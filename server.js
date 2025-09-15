require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mysql = require('mysql2/promise');
const axios = require('axios');
const WebSocket = require('ws');
const express = require('express');

// Initialize Express server for health check
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({ 
        status: 'Temp Email Bot Running Successfully!', 
        timestamp: new Date().toISOString(),
        uptime: `${Math.floor(process.uptime())} seconds`
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: 'Active' });
});

app.listen(PORT, () => {
    console.log(`🚀 Health check server running on port ${PORT}`);
});

// Initialize Telegram Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// MySQL Connection Pool (Clean Configuration)
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
});

// WebSocket connections storage
const wsConnections = new Map();

// Database initialization
async function initDatabase() {
    let retries = 3;
    
    while (retries > 0) {
        try {
            const connection = await pool.getConnection();
            
            // Test connection
            await connection.execute('SELECT 1');
            
            // Create emails table
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS emails (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    email VARCHAR(255) NOT NULL,
                    password VARCHAR(255) NOT NULL,
                    token TEXT NOT NULL,
                    telegram_user_id BIGINT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_user_id (telegram_user_id),
                    INDEX idx_email (email)
                )
            `);

            // Create email_messages table
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS email_messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    email VARCHAR(255) NOT NULL,
                    message_id VARCHAR(255) NOT NULL,
                    sender VARCHAR(255) NOT NULL,
                    subject TEXT,
                    text TEXT,
                    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_email (email),
                    INDEX idx_message_id (message_id)
                )
            `);

            connection.release();
            console.log('✅ Database initialized successfully');
            return;
        } catch (error) {
            retries--;
            console.error(`❌ Database error (${3-retries}/3):`, error.message);
            if (retries === 0) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

// Mail.tm API functions
class MailTmAPI {
    static async getDomains() {
        try {
            const response = await axios.get('https://api.mail.tm/domains', {
                timeout: 10000
            });
            return response.data['hydra:member'][0].domain;
        } catch (error) {
            console.log('Using fallback domain');
            return 'guerrillamail.info';
        }
    }

    static async createAccount() {
        try {
            const domain = await this.getDomains();
            const randomString = Math.random().toString(36).substring(2, 10);
            const email = `${randomString}@${domain}`;
            const password = Math.random().toString(36).substring(2, 12);

            const response = await axios.post('https://api.mail.tm/accounts', {
                address: email,
                password: password
            }, { timeout: 15000 });

            return {
                email: response.data.address,
                password: password,
                id: response.data.id
            };
        } catch (error) {
            throw new Error('Failed to create email account');
        }
    }

    static async getToken(email, password) {
        try {
            const response = await axios.post('https://api.mail.tm/token', {
                address: email,
                password: password
            }, { timeout: 10000 });

            return response.data.token;
        } catch (error) {
            throw new Error('Failed to get authentication token');
        }
    }

    static async getMessages(token) {
        try {
            const response = await axios.get('https://api.mail.tm/messages', {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                timeout: 10000
            });

            return response.data['hydra:member'] || [];
        } catch (error) {
            return [];
        }
    }
}

// WebSocket connection for real-time messages
function setupWebSocket(email, token, userId) {
    try {
        // Close existing connection
        if (wsConnections.has(email)) {
            wsConnections.get(email).close();
        }

        const ws = new WebSocket(`wss://api.mail.tm/messages?token=${token}`);
        
        ws.on('open', () => {
            console.log(`🔌 WebSocket connected for ${email}`);
            wsConnections.set(email, ws);
        });

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                
                if (message.type === 'message' && message.data) {
                    const emailData = message.data;
                    
                    // Store message in database
                    try {
                        await pool.execute(
                            'INSERT INTO email_messages (email, message_id, sender, subject, text) VALUES (?, ?, ?, ?, ?)',
                            [email, emailData.id, emailData.from.address, emailData.subject || '', emailData.intro || emailData.text || '']
                        );
                    } catch (dbError) {
                        console.error('Database insert error:', dbError.message);
                    }

                    // Send notification to user
                    const messageText = `📩 New Mail Received! 🪧\n\n📇 From: ${emailData.from.address}\n🗒️ Subject: ${emailData.subject || 'No Subject'}\n💬 Message: ${(emailData.intro || emailData.text || 'No content').substring(0, 200)}${(emailData.intro || emailData.text || '').length > 200 ? '...' : ''}\n\n📬 Email: ${email}`;
                    
                    try {
                        await bot.telegram.sendMessage(userId, messageText);
                    } catch (telegramError) {
                        console.error('Telegram send error:', telegramError.message);
                    }
                }
            } catch (error) {
                console.error('WebSocket message error:', error.message);
            }
        });

        ws.on('error', (error) => {
            console.error(`WebSocket error for ${email}:`, error.message);
        });

        ws.on('close', () => {
            console.log(`🔌 WebSocket disconnected for ${email}`);
            wsConnections.delete(email);
        });

    } catch (error) {
        console.error('WebSocket setup error:', error.message);
    }
}

// Database helper functions
async function saveEmail(userId, email, password, token) {
    try {
        await pool.execute(
            'INSERT INTO emails (telegram_user_id, email, password, token) VALUES (?, ?, ?, ?)',
            [userId, email, password, token]
        );
        return true;
    } catch (error) {
        console.error('Save email error:', error.message);
        return false;
    }
}

async function getUserEmails(userId) {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM emails WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT 10',
            [userId]
        );
        return rows;
    } catch (error) {
        return [];
    }
}

async function getEmailByAddress(email) {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM emails WHERE email = ?',
            [email]
        );
        return rows[0] || null;
    } catch (error) {
        return null;
    }
}

// Check channel membership
async function checkChannelMembership(userId) {
    try {
        const chatMember = await bot.telegram.getChatMember('@earning_tips009', userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) {
        return false;
    }
}

// Bot commands
bot.start(async (ctx) => {
    try {
        const welcomeMessage = `👑 Hey There! Welcome To Temp Email Bot! 

⚪️ Join The Channel Below
🤩 After Joining Click Verify

🌟 Features:
• Generate unlimited temp emails
• Real-time inbox notifications  
• Easy email recovery
• Secure & fast`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url('📢 Join Channel', 'https://t.me/earning_tips009')],
            [Markup.button.callback('✅ Verify', 'verify')]
        ]);

        await ctx.reply(welcomeMessage, keyboard);
    } catch (error) {
        console.error('Start error:', error.message);
    }
});

bot.action('verify', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const isJoined = await checkChannelMembership(userId);

        if (isJoined) {
            await ctx.answerCbQuery('✅ Verification successful!');
            
            const mainMenu = Markup.keyboard([
                ['🌀 Generate New', '📥 Inbox'],
                ['♻️ Recovery', '📧 My Emails']
            ]).resize().persistent();

            await ctx.reply('🎉 Welcome! Choose an option:', mainMenu);
        } else {
            await ctx.answerCbQuery('❌ Please join the channel first!');
            await ctx.reply('❌ Please join the channel first and then click verify!');
        }
    } catch (error) {
        await ctx.answerCbQuery('❌ Error occurred!');
    }
});

bot.hears('🌀 Generate New', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const loadingMsg = await ctx.reply('⏳ Generating new temp email...');
        
        const account = await MailTmAPI.createAccount();
        const token = await MailTmAPI.getToken(account.email, account.password);
        
        const saved = await saveEmail(userId, account.email, account.password, token);
        
        if (saved) {
            setupWebSocket(account.email, token, userId);
            
            const successMessage = `♻️ New Email Generated Successfully ✅\n\n📬 Email ID: \`${account.email}\` 👈\n🔐 Password: \`${account.password}\`\n\n🔔 Real-time notifications are now active!`;
            
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, successMessage, { parse_mode: 'Markdown' });
        } else {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, '❌ Error saving email!');
        }
        
    } catch (error) {
        console.error('Generate email error:', error.message);
        await ctx.reply('❌ Error generating email. Please try again!');
    }
});

bot.hears('📥 Inbox', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const emails = await getUserEmails(userId);
        
        if (emails.length === 0) {
            await ctx.reply('❌ No emails found! Generate a new email first.');
            return;
        }
        
        const buttons = emails.map(email => 
            [Markup.button.callback(`📬 ${email.email}`, `inbox_${email.id}`)]
        );
        
        const keyboard = Markup.inlineKeyboard(buttons);
        await ctx.reply('📥 Select email to check inbox:', keyboard);
    } catch (error) {
        await ctx.reply('❌ Error loading emails!');
    }
});

bot.action(/inbox_(\d+)/, async (ctx) => {
    try {
        const emailId = ctx.match[1];
        
        const [emailRows] = await pool.execute('SELECT * FROM emails WHERE id = ?', [emailId]);
        const email = emailRows[0];
        
        if (!email) {
            await ctx.answerCbQuery('❌ Email not found!');
            return;
        }
        
        await ctx.answerCbQuery('📬 Loading inbox...');
        
        const messages = await MailTmAPI.getMessages(email.token);
        
        if (messages.length === 0) {
            await ctx.reply(`📭 Inbox is empty for ${email.email}`);
            return;
        }
        
        for (const msg of messages.slice(0, 3)) {
            const messageText = `📩 Email Message\n\n📇 From: ${msg.from.address}\n🗒️ Subject: ${msg.subject || 'No Subject'}\n💬 Text: ${(msg.intro || msg.text || 'No content').substring(0, 300)}${(msg.intro || msg.text || '').length > 300 ? '...' : ''}\n📅 Date: ${new Date(msg.createdAt).toLocaleString()}`;
            
            await ctx.reply(messageText);
        }
        
    } catch (error) {
        console.error('Inbox error:', error.message);
        await ctx.answerCbQuery('❌ Error loading inbox!');
    }
});

bot.hears('♻️ Recovery', async (ctx) => {
    await ctx.reply('📧 Send me your temp email address to recover:');
    ctx.session = { waitingForEmail: true };
});

bot.hears('📧 My Emails', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const emails = await getUserEmails(userId);
        
        if (emails.length === 0) {
            await ctx.reply('❌ No emails found! Generate a new email first.');
            return;
        }
        
        let message = '📧 Your Generated Emails:\n\n';
        emails.forEach((email, index) => {
            message += `${index + 1}. 📬 ${email.email}\n📅 Created: ${new Date(email.created_at).toLocaleString()}\n\n`;
        });
        
        await ctx.reply(message);
    } catch (error) {
        await ctx.reply('❌ Error loading your emails!');
    }
});

// Handle recovery
bot.on('text', async (ctx) => {
    try {
        if (ctx.session && ctx.session.waitingForEmail) {
            const emailAddress = ctx.message.text.trim();
            const userId = ctx.from.id;
            
            const emailData = await getEmailByAddress(emailAddress);
            
            if (emailData) {
                setupWebSocket(emailData.email, emailData.token, userId);
                await ctx.reply(`✅ Email recovered successfully!\n\n📬 Email: ${emailData.email}\n🔔 Real-time notifications reactivated!`);
            } else {
                await ctx.reply('❌ Email not found! Please check the email address.');
            }
            
            delete ctx.session.waitingForEmail;
        }
    } catch (error) {
        console.error('Recovery error:', error.message);
    }
});

// Error handling
bot.catch((err, ctx) => {
    console.error('Bot error:', err.message);
    if (ctx && ctx.reply) {
        ctx.reply('❌ An error occurred. Please try again!').catch(() => {});
    }
});

// Graceful shutdown
process.once('SIGINT', async () => {
    console.log('🛑 Shutting down gracefully...');
    wsConnections.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    await bot.stop('SIGINT');
    await pool.end();
    process.exit(0);
});

process.once('SIGTERM', async () => {
    console.log('🛑 Shutting down gracefully...');
    wsConnections.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    await bot.stop('SIGTERM');
    await pool.end();
    process.exit(0);
});

// Start bot function
async function startBot() {
    try {
        await initDatabase();
        console.log('🤖 Starting Telegram bot...');
        
        // Delete webhook and start with polling
        await bot.telegram.deleteWebhook();
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        await bot.launch();
        console.log('✅ Bot started successfully!');
        
        // Heartbeat
        setInterval(() => {
            console.log('💓 Bot heartbeat:', new Date().toISOString());
        }, 300000);
        
    } catch (error) {
        console.error('❌ Start error:', error.message);
        
        // Retry once
        setTimeout(async () => {
            try {
                await bot.telegram.deleteWebhook();
                await bot.launch();
                console.log('✅ Bot started on retry!');
            } catch (retryError) {
                console.error('❌ Retry failed:', retryError.message);
                process.exit(1);
            }
        }, 5000);
    }
}

// Initialize
startBot().catch(console.error);
