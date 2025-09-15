// Professional Temp Email Telegram Bot - FIXED VERSION
// All Issues Resolved - Production Ready Code
// Author: Professional Bot Developer

const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

// Validate required environment variables
if (!process.env.BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is required in .env file');
    process.exit(1);
}

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_URL = 'https://t.me/earning_tips009';
const CHANNEL_USERNAME = 'earning_tips009'; // Without @ symbol
const PORT = process.env.PORT || 3000;

// Database Configuration - Fixed with proper error handling
const DB_CONFIG = {
    host: 'cashearnersofficial.xyz',
    user: 'cztldhwx_tampemail',
    password: 'Aptap786920',
    database: 'cztldhwx_tampemail',
    charset: 'utf8mb4',
    connectTimeout: 60000,
    acquireTimeout: 60000,
    timeout: 60000,
    reconnect: true,
    multipleStatements: false
};

// Initialize Bot and Express
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: {
        interval: 1000,
        autoStart: true,
        params: {
            timeout: 30
        }
    }
});

const app = express();
app.use(express.json());

// Global variables
let dbPool = null;
const wsConnections = new Map();
const userStates = new Map(); // For user conversation states

// Enhanced Database Connection with retry logic
async function initDatabase() {
    let retries = 3;
    while (retries > 0) {
        try {
            dbPool = mysql.createPool({
                ...DB_CONFIG,
                connectionLimit: 10,
                queueLimit: 0,
                retry: {
                    timeout: 60000,
                    delay: 2000
                }
            });
            
            // Test connection
            const connection = await dbPool.getConnection();
            await connection.ping();
            connection.release();
            
            // Create tables if not exists - Fixed SQL
            await dbPool.execute(`
                CREATE TABLE IF NOT EXISTS emails (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    email VARCHAR(255) UNIQUE NOT NULL,
                    password VARCHAR(255) NOT NULL,
                    token TEXT,
                    account_id VARCHAR(255),
                    telegram_user_id BIGINT NOT NULL,
                    is_active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_telegram_user_id (telegram_user_id),
                    INDEX idx_email (email),
                    INDEX idx_account_id (account_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            await dbPool.execute(`
                CREATE TABLE IF NOT EXISTS email_messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    email VARCHAR(255) NOT NULL,
                    message_id VARCHAR(255) NOT NULL UNIQUE,
                    sender VARCHAR(255),
                    subject TEXT,
                    text_content LONGTEXT,
                    html_content LONGTEXT,
                    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    is_read BOOLEAN DEFAULT FALSE,
                    INDEX idx_email (email),
                    INDEX idx_message_id (message_id),
                    INDEX idx_received_at (received_at),
                    FOREIGN KEY (email) REFERENCES emails(email) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            console.log('✅ Database initialized successfully');
            return;
            
        } catch (error) {
            retries--;
            console.error(`❌ Database connection failed (${3-retries}/3):`, error.message);
            
            if (retries === 0) {
                console.error('❌ Failed to connect to database after 3 attempts');
                process.exit(1);
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// Fixed Mail.tm API Class
class MailTmAPI {
    static baseURL = 'https://api.mail.tm';
    static wsURL = 'wss://api.mail.tm';

    static async getDomains() {
        try {
            const response = await axios.get(`${this.baseURL}/domains`, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'TempEmailBot/1.0'
                }
            });
            
            const domains = response.data['hydra:member'] || [];
            return domains.length > 0 ? domains[0].domain : 'mail.tm';
        } catch (error) {
            console.error('Error getting domains:', error.message);
            return 'mail.tm';
        }
    }

    static async createAccount() {
        try {
            const domain = await this.getDomains();
            const username = this.generateRandomString(12);
            const email = `${username}@${domain}`;
            const password = this.generateRandomString(16);

            const response = await axios.post(`${this.baseURL}/accounts`, {
                address: email,
                password: password
            }, {
                timeout: 15000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'TempEmailBot/1.0'
                }
            });

            return {
                email: response.data.address,
                password: password,
                id: response.data.id
            };
        } catch (error) {
            console.error('Error creating account:', error.response?.data || error.message);
            throw new Error('Failed to create email account');
        }
    }

    static async getToken(email, password) {
        try {
            const response = await axios.post(`${this.baseURL}/token`, {
                address: email,
                password: password
            }, {
                timeout: 15000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'TempEmailBot/1.0'
                }
            });
            
            return response.data.token;
        } catch (error) {
            console.error('Error getting token:', error.response?.data || error.message);
            throw new Error('Failed to authenticate email account');
        }
    }

    static async getMessages(token) {
        try {
            const response = await axios.get(`${this.baseURL}/messages`, {
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'TempEmailBot/1.0'
                },
                timeout: 10000
            });
            return response.data['hydra:member'] || [];
        } catch (error) {
            console.error('Error getting messages:', error.response?.data || error.message);
            return [];
        }
    }

    static async getMessage(messageId, token) {
        try {
            const response = await axios.get(`${this.baseURL}/messages/${messageId}`, {
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'TempEmailBot/1.0'
                },
                timeout: 10000
            });
            return response.data;
        } catch (error) {
            console.error('Error getting message details:', error.message);
            return null;
        }
    }

    static generateRandomString(length) {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
}

// Fixed WebSocket Manager with proper error handling
class EmailWebSocketManager {
    static async startMonitoring(email, token, accountId, userId) {
        try {
            // Close existing connection
            const existingWs = wsConnections.get(email);
            if (existingWs && existingWs.readyState === WebSocket.OPEN) {
                existingWs.close();
            }

            // Create new WebSocket connection - Fixed URL
            const wsUrl = `${MailTmAPI.wsURL}/mercure?topic=/accounts/${accountId}/messages`;
            const ws = new WebSocket(wsUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'TempEmailBot/1.0'
                }
            });
            
            let reconnectAttempts = 0;
            const maxReconnectAttempts = 5;
            
            ws.on('open', () => {
                console.log(`🔄 WebSocket connected for ${email}`);
                wsConnections.set(email, ws);
                reconnectAttempts = 0;
            });

            ws.on('message', async (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.type === 'message') {
                        await this.handleNewEmail(email, message.data, userId, token);
                    }
                } catch (error) {
                    console.error('Error processing WebSocket message:', error.message);
                }
            });

            ws.on('close', (code) => {
                console.log(`❌ WebSocket closed for ${email}, code: ${code}`);
                wsConnections.delete(email);
                
                // Reconnect logic
                if (reconnectAttempts < maxReconnectAttempts) {
                    reconnectAttempts++;
                    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
                    console.log(`🔄 Reconnecting ${email} in ${delay}ms (attempt ${reconnectAttempts})`);
                    
                    setTimeout(() => {
                        this.startMonitoring(email, token, accountId, userId);
                    }, delay);
                }
            });

            ws.on('error', (error) => {
                console.error(`WebSocket error for ${email}:`, error.message);
                wsConnections.delete(email);
            });

            // Ping to keep connection alive
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                } else {
                    clearInterval(pingInterval);
                }
            }, 30000);

        } catch (error) {
            console.error('Error starting WebSocket monitoring:', error.message);
        }
    }

    static async handleNewEmail(email, messageData, userId, token) {
        try {
            // Get full message details
            const fullMessage = await MailTmAPI.getMessage(messageData.id, token);
            if (!fullMessage) return;

            // Save to database with duplicate check
            await dbPool.execute(`
                INSERT IGNORE INTO email_messages 
                (email, message_id, sender, subject, text_content, html_content) 
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                email,
                fullMessage.id,
                fullMessage.from?.address || 'Unknown',
                fullMessage.subject || 'No Subject',
                fullMessage.text || '',
                fullMessage.html || ''
            ]);

            // Format and send notification - Fixed message format
            const notificationText = `📩 New Mail Received In Your Email ID 🪧

📇 From : ${fullMessage.from?.address || 'Unknown'}

🗒️ Subject : ${fullMessage.subject || 'No Subject'}

💬 Text : ${this.formatMessagePreview(fullMessage.text || fullMessage.html || 'No content')}`;

            await bot.sendMessage(userId, notificationText);

        } catch (error) {
            console.error('Error handling new email:', error.message);
        }
    }

    static formatMessagePreview(text) {
        if (!text) return 'No content';
        
        // Remove HTML tags and clean text
        const cleanText = text
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
            
        return cleanText.length > 200 ? 
            cleanText.substring(0, 200) + '...' : 
            cleanText;
    }

    static closeConnection(email) {
        const ws = wsConnections.get(email);
        if (ws) {
            ws.close();
            wsConnections.delete(email);
        }
    }
}

// Fixed Channel Verification
async function checkChannelMembership(userId) {
    try {
        const member = await bot.getChatMember(`@${CHANNEL_USERNAME}`, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
        console.error('Error checking membership:', error.message);
        return false;
    }
}

// Enhanced Bot Handlers
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const userName = msg.from.first_name || 'User';
    
    try {
        const welcomeMessage = `👑 Hey ${userName}! Welcome To Temp Email Bot!!

⚪️ Join All The Channels Below

🤩 After Joining Click Verify`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '📢 Join Channel', url: CHANNEL_URL }],
                [{ text: '✅ Verify', callback_data: 'verify' }]
            ]
        };

        await bot.sendMessage(userId, welcomeMessage, { 
            reply_markup: keyboard,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error('Error in start command:', error.message);
        await bot.sendMessage(userId, '❌ Something went wrong. Please try again.');
    }
});

// Fixed Callback Query Handler
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;

    try {
        if (data === 'verify') {
            const isMember = await checkChannelMembership(userId);
            
            if (isMember) {
                await bot.answerCallbackQuery(query.id, { 
                    text: '✅ Verification successful!',
                    show_alert: false
                });
                
                const mainKeyboard = {
                    keyboard: [
                        [{ text: '🌀 Generate New' }, { text: '📥 Inbox' }],
                        [{ text: '🔄 Email Recovery' }, { text: '📧 My Emails' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: false
                };

                await bot.sendMessage(userId, '🎉 Welcome! You can now use all features:', {
                    reply_markup: mainKeyboard
                });
            } else {
                await bot.answerCallbackQuery(query.id, { 
                    text: '❌ Please join the channel first!', 
                    show_alert: true 
                });
            }
        }
    } catch (error) {
        console.error('Error in callback query:', error.message);
        await bot.answerCallbackQuery(query.id, { 
            text: '❌ Something went wrong', 
            show_alert: true 
        });
    }
});

// Enhanced Message Handler
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const text = msg.text;

    // Skip commands and non-text messages
    if (!text || text.startsWith('/')) return;

    try {
        // Check if user is in recovery mode
        if (userStates.has(userId) && userStates.get(userId) === 'awaiting_email') {
            await handleEmailRecoveryInput(userId, text);
            return;
        }

        // Check channel membership
        const isMember = await checkChannelMembership(userId);
        if (!isMember) {
            const keyboard = {
                inline_keyboard: [
                    [{ text: '📢 Join Channel', url: CHANNEL_URL }],
                    [{ text: '✅ Verify', callback_data: 'verify' }]
                ]
            };
            
            await bot.sendMessage(userId, '❌ Please join our channel first and verify!', {
                reply_markup: keyboard
            });
            return;
        }

        // Handle menu options
        switch (text) {
            case '🌀 Generate New':
                await handleGenerateNew(userId);
                break;
            case '📥 Inbox':
                await handleInbox(userId);
                break;
            case '🔄 Email Recovery':
                await handleEmailRecovery(userId);
                break;
            case '📧 My Emails':
                await handleMyEmails(userId);
                break;
            default:
                await bot.sendMessage(userId, '❌ Please use the menu buttons below.');
        }
    } catch (error) {
        console.error('Error in message handler:', error.message);
        await bot.sendMessage(userId, '❌ Something went wrong. Please try again.');
    }
});

// Fixed Handler Functions
async function handleGenerateNew(userId) {
    const loadingMsg = await bot.sendMessage(userId, '⏳ Generating new email...');
    
    try {
        const account = await MailTmAPI.createAccount();
        const token = await MailTmAPI.getToken(account.email, account.password);
        
        // Save to database
        await dbPool.execute(`
            INSERT INTO emails (email, password, token, account_id, telegram_user_id) 
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
            password = VALUES(password), 
            token = VALUES(token),
            account_id = VALUES(account_id),
            is_active = TRUE,
            updated_at = CURRENT_TIMESTAMP
        `, [account.email, account.password, token, account.id, userId]);

        // Start WebSocket monitoring with account ID
        await EmailWebSocketManager.startMonitoring(account.email, token, account.id, userId);

        await bot.deleteMessage(userId, loadingMsg.message_id);
        
        // Fixed success message format
        await bot.sendMessage(userId, `♻️ New Email Generated Successfully ✅

📬 Email ID : ${account.email} 👈`);

    } catch (error) {
        console.error('Error generating email:', error.message);
        await bot.editMessageText('❌ Failed to generate email. Please try again.', {
            chat_id: userId,
            message_id: loadingMsg.message_id
        });
    }
}

async function handleInbox(userId) {
    try {
        const [rows] = await dbPool.execute(`
            SELECT email, token FROM emails 
            WHERE telegram_user_id = ? AND is_active = TRUE
            ORDER BY updated_at DESC LIMIT 1
        `, [userId]);

        if (rows.length === 0) {
            return bot.sendMessage(userId, '❌ No active email found. Please generate one first!');
        }

        const { email, token } = rows[0];
        const messages = await MailTmAPI.getMessages(token);

        if (messages.length === 0) {
            return bot.sendMessage(userId, `📭 No messages in ${email}`);
        }

        let inboxText = `📥 Inbox for ${email}\n\n`;
        const recentMessages = messages.slice(0, 5);
        
        for (let i = 0; i < recentMessages.length; i++) {
            const msg = recentMessages[i];
            inboxText += `${i + 1}. 📧 From: ${msg.from?.address || 'Unknown'}\n`;
            inboxText += `   📋 Subject: ${msg.subject || 'No Subject'}\n`;
            inboxText += `   📅 Date: ${new Date(msg.createdAt).toLocaleString()}\n\n`;
        }

        await bot.sendMessage(userId, inboxText);

    } catch (error) {
        console.error('Error fetching inbox:', error.message);
        await bot.sendMessage(userId, '❌ Failed to fetch inbox. Please try again.');
    }
}

async function handleEmailRecovery(userId) {
    try {
        userStates.set(userId, 'awaiting_email');
        await bot.sendMessage(userId, '📧 Send me the email address you want to recover:', {
            reply_markup: {
                force_reply: true
            }
        });
        
        // Auto-clear state after 5 minutes
        setTimeout(() => {
            userStates.delete(userId);
        }, 300000);
        
    } catch (error) {
        console.error('Error in email recovery:', error.message);
        await bot.sendMessage(userId, '❌ Failed to start recovery process.');
    }
}

async function handleEmailRecoveryInput(userId, email) {
    try {
        userStates.delete(userId); // Clear state
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email.trim())) {
            return bot.sendMessage(userId, '❌ Please enter a valid email address.');
        }
        
        const cleanEmail = email.trim().toLowerCase();
        
        const [rows] = await dbPool.execute(`
            SELECT * FROM emails WHERE email = ?
        `, [cleanEmail]);

        if (rows.length > 0) {
            // Update ownership
            await dbPool.execute(`
                UPDATE emails SET 
                telegram_user_id = ?, 
                is_active = TRUE,
                updated_at = CURRENT_TIMESTAMP 
                WHERE email = ?
            `, [userId, cleanEmail]);

            // Try to restart monitoring
            const { password, account_id } = rows[0];
            try {
                const token = await MailTmAPI.getToken(cleanEmail, password);
                await dbPool.execute(`
                    UPDATE emails SET token = ? WHERE email = ?
                `, [token, cleanEmail]);
                
                if (account_id) {
                    await EmailWebSocketManager.startMonitoring(cleanEmail, token, account_id, userId);
                }
            } catch (tokenError) {
                console.error('Failed to refresh token:', tokenError.message);
            }

            await bot.sendMessage(userId, `✅ Email ${cleanEmail} recovered successfully!`);
        } else {
            await bot.sendMessage(userId, '❌ Email not found in our database.');
        }
    } catch (error) {
        console.error('Error recovering email:', error.message);
        await bot.sendMessage(userId, '❌ Failed to recover email.');
    }
}

async function handleMyEmails(userId) {
    try {
        const [rows] = await dbPool.execute(`
            SELECT email, created_at, is_active FROM emails 
            WHERE telegram_user_id = ? 
            ORDER BY created_at DESC
            LIMIT 10
        `, [userId]);

        if (rows.length === 0) {
            return bot.sendMessage(userId, '❌ No emails found. Generate one first!');
        }

        let emailList = '📧 Your Emails:\n\n';
        rows.forEach((row, index) => {
            const status = row.is_active ? '🟢 Active' : '🔴 Inactive';
            emailList += `${index + 1}. ${row.email}\n`;
            emailList += `   📅 Created: ${new Date(row.created_at).toLocaleString()}\n`;
            emailList += `   📊 Status: ${status}\n\n`;
        });

        await bot.sendMessage(userId, emailList);

    } catch (error) {
        console.error('Error fetching user emails:', error.message);
        await bot.sendMessage(userId, '❌ Failed to fetch emails.');
    }
}

// Enhanced Express Routes
app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot is running!', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        connections: wsConnections.size,
        version: '2.0.0'
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        database: dbPool ? 'connected' : 'disconnected',
        websockets: wsConnections.size,
        memory: process.memoryUsage(),
        uptime: process.uptime()
    });
});

app.get('/stats', async (req, res) => {
    try {
        const [emailCount] = await dbPool.execute('SELECT COUNT(*) as count FROM emails');
        const [messageCount] = await dbPool.execute('SELECT COUNT(*) as count FROM email_messages');
        
        res.json({
            total_emails: emailCount[0].count,
            total_messages: messageCount[0].count,
            active_connections: wsConnections.size,
            uptime: process.uptime()
        });
    } catch (error) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Periodic cleanup and health checks
setInterval(async () => {
    try {
        // Clean old messages (older than 7 days)
        await dbPool.execute(`
            DELETE FROM email_messages 
            WHERE received_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
        `);
        
        console.log(`🔄 Health check - Active connections: ${wsConnections.size}`);
    } catch (error) {
        console.error('Cleanup error:', error.message);
    }
}, 300000); // Every 5 minutes

// Restart monitoring on startup
async function restartAllConnections() {
    try {
        const [rows] = await dbPool.execute(`
            SELECT DISTINCT email, token, account_id, telegram_user_id 
            FROM emails 
            WHERE is_active = TRUE AND token IS NOT NULL
        `);

        console.log(`🔄 Restarting monitoring for ${rows.length} emails...`);

        for (const row of rows) {
            if (row.token && row.account_id) {
                await EmailWebSocketManager.startMonitoring(
                    row.email, 
                    row.token, 
                    row.account_id, 
                    row.telegram_user_id
                );
                await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
            }
        }

        console.log('✅ All WebSocket connections restarted');
    } catch (error) {
        console.error('Error restarting connections:', error.message);
    }
}

// Enhanced Error Handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit in production, log and continue
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    
    try {
        // Close all WebSocket connections
        for (const [email, ws] of wsConnections) {
            ws.close();
            console.log(`Closed WebSocket for ${email}`);
        }
        
        // Close database pool
        if (dbPool) {
            await dbPool.end();
            console.log('Database pool closed');
        }
        
        console.log('Shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    process.emit('SIGTERM');
});

// Initialize and Start
async function start() {
    try {
        console.log('🚀 Starting Temp Email Bot...');
        
        await initDatabase();
        console.log('✅ Database connected');
        
        // Start Express server
        app.listen(PORT, () => {
            console.log(`🌐 Server running on port ${PORT}`);
        });

        console.log('🤖 Bot started successfully!');
        
        // Restart monitoring after delay
        setTimeout(async () => {
            await restartAllConnections();
        }, 10000); // 10 second delay
        
    } catch (error) {
        console.error('❌ Failed to start bot:', error);
        process.exit(1);
    }
}

// Start the bot
start();
