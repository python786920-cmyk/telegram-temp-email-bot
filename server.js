require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mysql = require('mysql2/promise');
const axios = require('axios');
const WebSocket = require('ws');
const express = require('express');
const cron = require('node-cron');

// Initialize Express server for health check
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({ status: 'Bot is running!', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`🚀 Health check server running on port ${PORT}`);
});

// Initialize Telegram Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// MySQL Connection Pool
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    acquireTimeout: 60000,
    timeout: 60000
};

const pool = mysql.createPool(dbConfig);

// WebSocket connections storage
const wsConnections = new Map();

// Database initialization
async function initDatabase() {
    try {
        const connection = await pool.getConnection();
        
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
    } catch (error) {
        console.error('❌ Database initialization error:', error);
    }
}

// Mail.tm API functions
class MailTmAPI {
    static async getDomains() {
        try {
            const response = await axios.get(`${process.env.MAIL_TM_API}/domains`);
            return response.data['hydra:member'][0].domain;
        } catch (error) {
            console.error('Error fetching domains:', error);
            return 'guerrillamail.info';
        }
    }

    static async createAccount() {
        try {
            const domain = await this.getDomains();
            const randomString = Math.random().toString(36).substring(2, 10);
            const email = `${randomString}@${domain}`;
            const password = Math.random().toString(36).substring(2, 12);

            const response = await axios.post(`${process.env.MAIL_TM_API}/accounts`, {
                address: email,
                password: password
            });

            return {
                email: response.data.address,
                password: password,
                id: response.data.id
            };
        } catch (error) {
            console.error('Error creating account:', error);
            throw new Error('Failed to create email account');
        }
    }

    static async getToken(email, password) {
        try {
            const response = await axios.post(`${process.env.MAIL_TM_API}/token`, {
                address: email,
                password: password
            });

            return response.data.token;
        } catch (error) {
            console.error('Error getting token:', error);
            throw new Error('Failed to get authentication token');
        }
    }

    static async getMessages(token) {
        try {
            const response = await axios.get(`${process.env.MAIL_TM_API}/messages`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            return response.data['hydra:member'];
        } catch (error) {
            console.error('Error getting messages:', error);
            return [];
        }
    }
}

// WebSocket connection for real-time messages
function setupWebSocket(email, token, userId) {
    if (wsConnections.has(email)) {
        wsConnections.get(email).close();
    }

    const ws = new WebSocket(`${process.env.MAIL_TM_WS}?token=${token}`);
    
    ws.on('open', () => {
        console.log(`🔌 WebSocket connected for ${email}`);
        wsConnections.set(email, ws);
    });

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'message') {
                const emailData = message.data;
                
                // Store message in database
                await pool.execute(
                    'INSERT INTO email_messages (email, message_id, sender, subject, text) VALUES (?, ?, ?, ?, ?)',
                    [email, emailData.id, emailData.from.address, emailData.subject, emailData.intro || emailData.text]
                );

                // Send notification to user
                const messageText = `📩 New Mail Received In Your Email ID 🪧\n\n📇 From: ${emailData.from.address}\n🗒️ Subject: ${emailData.subject || 'No Subject'}\n💬 Text: ${emailData.intro || emailData.text || 'No content'}\n\n📬 Email: ${email}`;
                
                await bot.telegram.sendMessage(userId, messageText);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${email}:`, error);
    });

    ws.on('close', () => {
        console.log(`🔌 WebSocket disconnected for ${email}`);
        wsConnections.delete(email);
    });
}

// Database helper functions
async function saveEmail(userId, email, password, token) {
    try {
        await pool.execute(
            'INSERT INTO emails (telegram_user_id, email, password, token) VALUES (?, ?, ?, ?)',
            [userId, email, password, token]
        );
    } catch (error) {
        console.error('Error saving email:', error);
        throw error;
    }
}

async function getUserEmails(userId) {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM emails WHERE telegram_user_id = ? ORDER BY created_at DESC',
            [userId]
        );
        return rows;
    } catch (error) {
        console.error('Error getting user emails:', error);
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
        console.error('Error getting email by address:', error);
        return null;
    }
}

// Check if user joined channel
async function checkChannelMembership(userId) {
    try {
        const chatMember = await bot.telegram.getChatMember(process.env.CHANNEL_USERNAME, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) {
        console.error('Error checking membership:', error);
        return false;
    }
}

// Bot commands
bot.start(async (ctx) => {
    const welcomeMessage = `👑 Hey There! Welcome To Temp Email Bot! 

⚪️ Join The Channel Below
🤩 After Joining Click Verify

🌟 Features:
• Generate unlimited temp emails
• Real-time inbox notifications  
• Easy email recovery
• Secure & fast`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('📢 Join Channel', process.env.CHANNEL_URL)],
        [Markup.button.callback('✅ Verify', 'verify')]
    ]);

    await ctx.reply(welcomeMessage, keyboard);
});

bot.action('verify', async (ctx) => {
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
});

bot.hears('🌀 Generate New', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        await ctx.reply('⏳ Generating new temp email...');
        
        const account = await MailTmAPI.createAccount();
        const token = await MailTmAPI.getToken(account.email, account.password);
        
        await saveEmail(userId, account.email, account.password, token);
        
        // Setup WebSocket for real-time notifications
        setupWebSocket(account.email, token, userId);
        
        const successMessage = `♻️ New Email Generated Successfully ✅\n\n📬 Email ID: \`${account.email}\` 👈\n🔐 Password: \`${account.password}\`\n\n🔔 Real-time notifications are now active!`;
        
        await ctx.reply(successMessage, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('Error generating email:', error);
        await ctx.reply('❌ Error generating email. Please try again!');
    }
});

bot.hears('📥 Inbox', async (ctx) => {
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
});

bot.action(/inbox_(\d+)/, async (ctx) => {
    const emailId = ctx.match[1];
    
    try {
        const [emailRows] = await pool.execute('SELECT * FROM emails WHERE id = ?', [emailId]);
        const email = emailRows[0];
        
        if (!email) {
            await ctx.answerCbQuery('❌ Email not found!');
            return;
        }
        
        const messages = await MailTmAPI.getMessages(email.token);
        
        if (messages.length === 0) {
            await ctx.answerCbQuery('📭 Inbox is empty!');
            await ctx.reply(`📭 Inbox is empty for ${email.email}`);
            return;
        }
        
        await ctx.answerCbQuery('📬 Loading inbox...');
        
        for (const msg of messages.slice(0, 5)) {
            const messageText = `📩 Email Received\n\n📇 From: ${msg.from.address}\n🗒️ Subject: ${msg.subject || 'No Subject'}\n💬 Text: ${msg.intro || msg.text || 'No content'}\n📅 Date: ${new Date(msg.createdAt).toLocaleString()}`;
            
            await ctx.reply(messageText);
        }
        
    } catch (error) {
        console.error('Error getting inbox:', error);
        await ctx.answerCbQuery('❌ Error loading inbox!');
    }
});

bot.hears('♻️ Recovery', async (ctx) => {
    await ctx.reply('📧 Send me your temp email address to recover:');
    ctx.session = { waitingForEmail: true };
});

bot.hears('📧 My Emails', async (ctx) => {
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
});

// Handle recovery email input
bot.on('text', async (ctx) => {
    if (ctx.session && ctx.session.waitingForEmail) {
        const emailAddress = ctx.message.text.trim();
        const userId = ctx.from.id;
        
        const emailData = await getEmailByAddress(emailAddress);
        
        if (emailData) {
            // Setup WebSocket for recovered email
            setupWebSocket(emailData.email, emailData.token, userId);
            
            await ctx.reply(`✅ Email recovered successfully!\n\n📬 Email: ${emailData.email}\n🔔 Real-time notifications reactivated!`);
        } else {
            await ctx.reply('❌ Email not found! Make sure you entered the correct email address.');
        }
        
        delete ctx.session.waitingForEmail;
    }
});

// Error handling
bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply('❌ An error occurred. Please try again!');
});

// Health check cron job (keep alive)
cron.schedule('*/5 * * * *', () => {
    console.log('🏥 Health check - Bot is alive:', new Date().toISOString());
});

// Cleanup WebSocket connections on exit
process.on('SIGINT', () => {
    console.log('🛑 Shutting down bot...');
    wsConnections.forEach((ws) => ws.close());
    process.exit(0);
});

// Start the bot
async function startBot() {
    try {
        await initDatabase();
        console.log('🤖 Starting Telegram bot...');
        await bot.launch();
        console.log('✅ Bot started successfully!');
    } catch (error) {
        console.error('❌ Failed to start bot:', error);
        process.exit(1);
    }
}

startBot();
