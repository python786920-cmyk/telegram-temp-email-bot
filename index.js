const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const axios = require('axios');
const WebSocket = require('ws');
const express = require('express');

// Bot Configuration
const BOT_TOKEN = '8006290667:AAFrfrSsgNWDjuwqToSoGB9x-9nGyUIltyE';
const CHANNEL_URL = 'https://t.me/earning_tips009';
const CHANNEL_USERNAME = '@earning_tips009';

// Database Configuration
const DB_CONFIG = {
    host: 'cashearnersofficial.xyz',
    user: 'cztldhwx_tampemail',
    password: 'Aptap786920',
    database: 'cztldhwx_tampemail',
    connectionLimit: 10,
    acquireTimeout: 60000,
    timeout: 60000
};

// Initialize Bot and Express
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
const port = process.env.PORT || 3000;

// Create MySQL connection pool
const pool = mysql.createPool(DB_CONFIG);

// Store active WebSocket connections
const activeConnections = new Map();

// Initialize Database Tables
async function initDatabase() {
    try {
        const connection = await pool.getConnection();
        
        // Create emails table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS emails (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) UNIQUE,
                password VARCHAR(255),
                token TEXT,
                telegram_user_id BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_access TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_telegram_user_id (telegram_user_id),
                INDEX idx_email (email)
            )
        `);

        // Create email messages table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS email_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255),
                message_id VARCHAR(255),
                sender VARCHAR(255),
                subject TEXT,
                content TEXT,
                received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_notified BOOLEAN DEFAULT FALSE,
                INDEX idx_email (email),
                INDEX idx_message_id (message_id)
            )
        `);

        // Create users table for channel verification
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                telegram_user_id BIGINT UNIQUE,
                username VARCHAR(255),
                first_name VARCHAR(255),
                is_verified BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_telegram_user_id (telegram_user_id)
            )
        `);

        connection.release();
        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error);
    }
}

// Keyboard Configurations
const getMainKeyboard = () => ({
    keyboard: [
        [{ text: '🌀 Generate New' }],
        [{ text: '📥 Inbox' }],
        [{ text: '♻️ Recovery' }],
        [{ text: '📧 My Email' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
});

const getJoinKeyboard = () => ({
    inline_keyboard: [
        [{ text: '📢 Join Channel', url: CHANNEL_URL }],
        [{ text: '✅ Verify', callback_data: 'verify_membership' }]
    ]
});

// Helper Functions
async function checkUserMembership(userId) {
    try {
        const chatMember = await bot.getChatMember(CHANNEL_USERNAME, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) {
        console.error('Error checking membership:', error);
        return false;
    }
}

async function saveUser(userId, username, firstName) {
    try {
        const connection = await pool.getConnection();
        await connection.execute(
            'INSERT INTO users (telegram_user_id, username, first_name, is_verified) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = ?, first_name = ?, is_verified = ?',
            [userId, username, firstName, true, username, firstName, true]
        );
        connection.release();
    } catch (error) {
        console.error('Error saving user:', error);
    }
}

async function isUserVerified(userId) {
    try {
        const connection = await pool.getConnection();
        const [rows] = await connection.execute(
            'SELECT is_verified FROM users WHERE telegram_user_id = ?',
            [userId]
        );
        connection.release();
        return rows.length > 0 && rows[0].is_verified;
    } catch (error) {
        console.error('Error checking user verification:', error);
        return false;
    }
}

async function generateTempEmail(userId) {
    try {
        // Get available domains
        const domainsResponse = await axios.get('https://api.mail.tm/domains');
        const domains = domainsResponse.data['hydra:member'];
        const domain = domains[Math.floor(Math.random() * domains.length)].domain;

        // Generate username and email
        const prefixes = ['temp', 'quick', 'fast', 'instant', 'rapid', 'swift', 'flash'];
        const username = prefixes[Math.floor(Math.random() * prefixes.length)] + Math.floor(Math.random() * 900000 + 100000);
        const email = `${username}@${domain}`;
        const password = `TempMail${Math.floor(Math.random() * 900) + 100}!`;

        // Create account
        const accountResponse = await axios.post('https://api.mail.tm/accounts', {
            address: email,
            password: password
        });

        if (accountResponse.status !== 201) {
            throw new Error('Failed to create account');
        }

        // Get token
        const tokenResponse = await axios.post('https://api.mail.tm/token', {
            address: email,
            password: password
        });

        const token = tokenResponse.data.token;

        // Save to database
        const connection = await pool.getConnection();
        await connection.execute(
            'INSERT INTO emails (email, password, token, telegram_user_id, created_at, last_access) VALUES (?, ?, ?, ?, NOW(), NOW()) ON DUPLICATE KEY UPDATE token = ?, last_access = NOW()',
            [email, password, token, userId, token]
        );
        connection.release();

        // Start WebSocket connection for this email
        startWebSocketConnection(email, token, userId);

        return { email, password, token };
    } catch (error) {
        console.error('Error generating temp email:', error);
        return null;
    }
}

async function getInbox(email, token) {
    try {
        const response = await axios.get('https://api.mail.tm/messages', {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data['hydra:member'] || [];
    } catch (error) {
        if (error.response?.status === 401) {
            // Token expired, refresh it
            return await refreshTokenAndRetry(email);
        }
        console.error('Error getting inbox:', error);
        return [];
    }
}

async function refreshTokenAndRetry(email) {
    try {
        const connection = await pool.getConnection();
        const [rows] = await connection.execute('SELECT password, telegram_user_id FROM emails WHERE email = ?', [email]);
        
        if (rows.length === 0) {
            connection.release();
            return [];
        }

        const { password, telegram_user_id } = rows[0];

        // Get new token
        const tokenResponse = await axios.post('https://api.mail.tm/token', {
            address: email,
            password: password
        });

        const newToken = tokenResponse.data.token;

        // Update token in database
        await connection.execute('UPDATE emails SET token = ?, last_access = NOW() WHERE email = ?', [newToken, email]);
        connection.release();

        // Restart WebSocket with new token
        startWebSocketConnection(email, newToken, telegram_user_id);

        // Retry getting inbox
        const response = await axios.get('https://api.mail.tm/messages', {
            headers: { Authorization: `Bearer ${newToken}` }
        });
        return response.data['hydra:member'] || [];
    } catch (error) {
        console.error('Error refreshing token:', error);
        return [];
    }
}

async function readMessage(token, messageId) {
    try {
        const response = await axios.get(`https://api.mail.tm/messages/${messageId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data;
    } catch (error) {
        console.error('Error reading message:', error);
        return null;
    }
}

function startWebSocketConnection(email, token, userId) {
    // Close existing connection if any
    if (activeConnections.has(email)) {
        activeConnections.get(email).close();
    }

    try {
        const ws = new WebSocket('wss://api.mail.tm/messages', {
            headers: { Authorization: `Bearer ${token}` }
        });

        ws.on('open', () => {
            console.log(`✅ WebSocket connected for ${email}`);
        });

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                
                if (message.type === 'message' && message.data) {
                    const msg = message.data;
                    
                    // Check if message already processed
                    const connection = await pool.getConnection();
                    const [existing] = await connection.execute(
                        'SELECT id FROM email_messages WHERE email = ? AND message_id = ?',
                        [email, msg.id]
                    );

                    if (existing.length === 0) {
                        // Save new message
                        await connection.execute(
                            'INSERT INTO email_messages (email, message_id, sender, subject, content, received_at, is_notified) VALUES (?, ?, ?, ?, ?, NOW(), TRUE)',
                            [email, msg.id, msg.from.address, msg.subject || 'No Subject', msg.intro || '']
                        );

                        // Get full message content
                        const fullMessage = await readMessage(token, msg.id);
                        let content = 'No content available';
                        
                        if (fullMessage) {
                            content = fullMessage.text || 
                                     (fullMessage.html ? fullMessage.html.replace(/<[^>]*>/g, '') : '') || 
                                     fullMessage.intro || 
                                     'No content available';
                        }

                        // Send notification to user
                        const notification = `📩 New Mail Received In Your Email ID 🪧

📇 From : ${msg.from.address}

🗒️ Subject : ${msg.subject || 'No Subject'}

💬 Text : ${content.substring(0, 500)}${content.length > 500 ? '...' : ''}`;

                        try {
                            await bot.sendMessage(userId, notification, {
                                reply_markup: getMainKeyboard(),
                                parse_mode: 'HTML'
                            });
                        } catch (sendError) {
                            console.error('Error sending notification:', sendError);
                        }
                    }
                    connection.release();
                }
            } catch (error) {
                console.error('Error processing WebSocket message:', error);
            }
        });

        ws.on('error', (error) => {
            console.error(`❌ WebSocket error for ${email}:`, error);
        });

        ws.on('close', () => {
            console.log(`🔌 WebSocket closed for ${email}`);
            activeConnections.delete(email);
        });

        activeConnections.set(email, ws);
    } catch (error) {
        console.error('Error starting WebSocket connection:', error);
    }
}

// Initialize WebSocket connections for existing emails
async function initializeExistingConnections() {
    try {
        const connection = await pool.getConnection();
        const [rows] = await connection.execute(
            'SELECT email, token, telegram_user_id FROM emails WHERE last_access > DATE_SUB(NOW(), INTERVAL 24 HOUR)'
        );
        connection.release();

        for (const row of rows) {
            startWebSocketConnection(row.email, row.token, row.telegram_user_id);
        }

        console.log(`✅ Initialized ${rows.length} WebSocket connections`);
    } catch (error) {
        console.error('Error initializing connections:', error);
    }
}

// Bot Event Handlers
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || '';
    const firstName = msg.from.first_name || '';

    const welcomeMessage = `👑 Hey There! Welcome To Tamp Email !!

⚪️ Join All The Channels Below

🤩 After Joining Click Verify`;

    await bot.sendMessage(chatId, welcomeMessage, {
        reply_markup: getJoinKeyboard()
    });
});

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const username = callbackQuery.from.username || '';
    const firstName = callbackQuery.from.first_name || '';

    if (callbackQuery.data === 'verify_membership') {
        const isMember = await checkUserMembership(userId);
        
        if (isMember) {
            await saveUser(userId, username, firstName);
            
            const successMessage = `✅ Verification Successful!

🎉 Welcome to Temp Email Bot!

Choose an option below to get started:`;

            await bot.sendMessage(chatId, successMessage, {
                reply_markup: getMainKeyboard()
            });
            
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
        } else {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '❌ Please join the channel first!',
                show_alert: true
            });
        }
    }
});

// Handle text messages
bot.on('message', async (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;

        // Check if user is verified
        const verified = await isUserVerified(userId);
        if (!verified) {
            await bot.sendMessage(chatId, '❌ Please complete verification first using /start');
            return;
        }

        if (text === '🌀 Generate New') {
            await bot.sendMessage(chatId, '🔄 Generating new temporary email...');
            
            const result = await generateTempEmail(userId);
            
            if (result) {
                const response = `♻️ New Email Generated Successfully ✅

📬 Email ID : ${result.email} 👈`;
                
                await bot.sendMessage(chatId, response, {
                    reply_markup: getMainKeyboard()
                });
            } else {
                await bot.sendMessage(chatId, '❌ Failed to generate email. Please try again.', {
                    reply_markup: getMainKeyboard()
                });
            }
        }
        
        else if (text === '📥 Inbox') {
            try {
                const connection = await pool.getConnection();
                const [rows] = await connection.execute(
                    'SELECT email, token FROM emails WHERE telegram_user_id = ? ORDER BY last_access DESC LIMIT 1',
                    [userId]
                );
                connection.release();

                if (rows.length === 0) {
                    await bot.sendMessage(chatId, '⚠️ No active email found. Generate a new email first using "🌀 Generate New".', {
                        reply_markup: getMainKeyboard()
                    });
                    return;
                }

                const { email, token } = rows[0];
                await bot.sendMessage(chatId, `📬 Loading inbox for ${email}...`);
                
                const messages = await getInbox(email, token);

                if (messages.length === 0) {
                    const response = `📭 Inbox Empty

📧 Email: ${email}
📥 No messages received yet.

Share your email and wait for messages!`;
                    
                    await bot.sendMessage(chatId, response, {
                        reply_markup: getMainKeyboard()
                    });
                } else {
                    let response = `📬 Inbox Messages
📧 Email: ${email}
📊 Total Messages: ${messages.length}

`;
                    
                    for (let i = 0; i < Math.min(messages.length, 5); i++) {
                        const msg = messages[i];
                        const date = new Date(msg.createdAt).toLocaleString();
                        const subject = msg.subject || 'No Subject';
                        const unreadIcon = !msg.seen ? '🆕' : '📖';
                        
                        response += `${unreadIcon} Message #${i + 1}
👤 From: ${msg.from.address}
📝 Subject: ${subject}
📅 Date: ${date}

`;

                        // Get full message content
                        const fullMsg = await readMessage(token, msg.id);
                        if (fullMsg) {
                            let content = fullMsg.text || 
                                         (fullMsg.html ? fullMsg.html.replace(/<[^>]*>/g, '') : '') || 
                                         'No content';
                            const preview = content.substring(0, 100);
                            response += `💬 Preview: ${preview}${content.length > 100 ? '...' : ''}

`;
                        }
                        
                        response += '─'.repeat(25) + '\n\n';
                    }

                    if (messages.length > 5) {
                        response += `📬 Showing first 5 messages out of ${messages.length} total.`;
                    }

                    await bot.sendMessage(chatId, response, {
                        reply_markup: getMainKeyboard()
                    });
                }
            } catch (error) {
                console.error('Error fetching inbox:', error);
                await bot.sendMessage(chatId, '❌ Error fetching inbox. Please try again.', {
                    reply_markup: getMainKeyboard()
                });
            }
        }
        
        else if (text === '♻️ Recovery') {
            const response = `🔄 Email Recovery

To recover a previous email, send your email address.

📋 Or check your email history with "📧 My Email" button.

💡 Example: temp123456@domain.com`;
            
            await bot.sendMessage(chatId, response, {
                reply_markup: getMainKeyboard()
            });
        }
        
        else if (text === '📧 My Email') {
            try {
                const connection = await pool.getConnection();
                const [rows] = await connection.execute(
                    'SELECT email, created_at, last_access FROM emails WHERE telegram_user_id = ? ORDER BY created_at DESC',
                    [userId]
                );
                connection.release();

                if (rows.length === 0) {
                    await bot.sendMessage(chatId, '📭 No emails found. Generate your first email using "🌀 Generate New".', {
                        reply_markup: getMainKeyboard()
                    });
                } else {
                    let response = `📧 Your Email History
📊 Total Emails: ${rows.length}

`;
                    
                    rows.forEach((email, index) => {
                        const created = new Date(email.created_at).toLocaleString();
                        const lastAccess = new Date(email.last_access).toLocaleString();
                        
                        response += `📮 Email #${index + 1}
📧 ${email.email}
📅 Created: ${created}
🕐 Last Used: ${lastAccess}

`;
                    });

                    response += '💡 Send any email address to recover and use it.';
                    
                    await bot.sendMessage(chatId, response, {
                        reply_markup: getMainKeyboard()
                    });
                }
            } catch (error) {
                console.error('Error fetching user emails:', error);
                await bot.sendMessage(chatId, '❌ Error fetching emails. Please try again.', {
                    reply_markup: getMainKeyboard()
                });
            }
        }
        
        else if (text.includes('@') && text.includes('.')) {
            // User sent an email for recovery
            const email = text.trim();
            
            await bot.sendMessage(chatId, `🔍 Recovering email: ${email}...`);
            
            try {
                const connection = await pool.getConnection();
                const [rows] = await connection.execute(
                    'SELECT email, password, token FROM emails WHERE email = ?',
                    [email]
                );

                if (rows.length === 0) {
                    connection.release();
                    await bot.sendMessage(chatId, '❌ Email not found in our database. Make sure the email was created through this bot.', {
                        reply_markup: getMainKeyboard()
                    });
                    return;
                }

                const { password } = rows[0];

                // Try to refresh token
                const tokenResponse = await axios.post('https://api.mail.tm/token', {
                    address: email,
                    password: password
                });

                const newToken = tokenResponse.data.token;

                // Update token and user_id
                await connection.execute(
                    'UPDATE emails SET token = ?, telegram_user_id = ?, last_access = NOW() WHERE email = ?',
                    [newToken, userId, email]
                );
                connection.release();

                // Start WebSocket connection
                startWebSocketConnection(email, newToken, userId);

                const response = `✅ Email Recovered Successfully!

📧 Email: ${email}
🔓 Email has been activated for your account.

Use "📥 Inbox" to check messages.`;
                
                await bot.sendMessage(chatId, response, {
                    reply_markup: getMainKeyboard()
                });
            } catch (error) {
                console.error('Error recovering email:', error);
                await bot.sendMessage(chatId, '❌ Email recovery failed. The email might be expired or invalid.', {
                    reply_markup: getMainKeyboard()
                });
            }
        }
        
        else {
            const response = `❓ Unknown Command

Please use the buttons below to navigate:`;
            await bot.sendMessage(chatId, response, {
                reply_markup: getMainKeyboard()
            });
        }
    }
});

// Express routes for health check (Anti-sleep)
app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot is running!', 
        timestamp: new Date().toISOString(),
        activeConnections: activeConnections.size
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        uptime: process.uptime(),
        activeConnections: activeConnections.size
    });
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// Initialize and start the bot
async function startBot() {
    try {
        await initDatabase();
        
        // Initialize existing connections after a delay
        setTimeout(() => {
            initializeExistingConnections();
        }, 5000);
        
        app.listen(port, () => {
            console.log(`✅ Express server running on port ${port}`);
            console.log(`✅ Telegram bot started successfully!`);
            console.log(`🔗 Health check: http://localhost:${port}/health`);
        });
    } catch (error) {
        console.error('❌ Failed to start bot:', error);
        process.exit(1);
    }
}

startBot();
