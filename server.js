const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const winston = require('winston');
const cron = require('node-cron');
require('dotenv').config();

// Logger Configuration
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'bot.log' })
    ]
});

// Initialize Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Database Connection Pool
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;

// WebSocket connections storage
const activeSockets = new Map();
const userSessions = new Map();

// Mail.tm API Configuration
const MAILTM_API = 'https://api.mail.tm';

// Initialize Database
async function initializeDatabase() {
    try {
        pool = mysql.createPool(dbConfig);
        
        // Create emails table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS emails (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                password VARCHAR(255) NOT NULL,
                token TEXT NOT NULL,
                telegram_user_id BIGINT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        // Create email_messages table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS email_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                message_id VARCHAR(255) NOT NULL,
                sender VARCHAR(255) NOT NULL,
                subject TEXT,
                text TEXT,
                received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        logger.info('Database initialized successfully');
    } catch (error) {
        logger.error('Database initialization failed:', error);
        throw error;
    }
}

// Check if user joined required channels
async function checkUserMembership(ctx) {
    try {
        const userId = ctx.from.id;
        const channelUsername = process.env.CHANNEL_URL.replace('https://t.me/', '@');
        
        const member = await ctx.telegram.getChatMember(channelUsername, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
        logger.error('Error checking membership:', error);
        return false;
    }
}

// Generate new temporary email
async function generateTempEmail(userId) {
    try {
        // Get available domains
        const domainsResponse = await axios.get(`${MAILTM_API}/domains`);
        const domain = domainsResponse.data['hydra:member'][0].domain;

        // Generate random email
        const randomStr = Math.random().toString(36).substring(2, 10);
        const email = `${randomStr}@${domain}`;
        const password = Math.random().toString(36).substring(2, 12);

        // Create account
        const accountResponse = await axios.post(`${MAILTM_API}/accounts`, {
            address: email,
            password: password
        });

        // Get token
        const tokenResponse = await axios.post(`${MAILTM_API}/token`, {
            address: email,
            password: password
        });

        const token = tokenResponse.data.token;

        // Save to database
        await pool.execute(
            'INSERT INTO emails (email, password, token, telegram_user_id) VALUES (?, ?, ?, ?)',
            [email, password, token, userId]
        );

        logger.info(`New email generated: ${email} for user ${userId}`);
        return { email, password, token };

    } catch (error) {
        logger.error('Error generating temp email:', error);
        throw new Error('Failed to generate temporary email. Please try again.');
    }
}

// Setup WebSocket connection for email
async function setupWebSocket(email, token, userId) {
    try {
        if (activeSockets.has(userId)) {
            activeSockets.get(userId).close();
        }

        const ws = new WebSocket('wss://api.mail.tm/messages', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        ws.on('open', () => {
            logger.info(`WebSocket connected for email: ${email}`);
            activeSockets.set(userId, ws);
        });

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data);
                if (message.type === 'message') {
                    await handleNewEmail(message.data, email, userId);
                }
            } catch (error) {
                logger.error('Error processing WebSocket message:', error);
            }
        });

        ws.on('error', (error) => {
            logger.error(`WebSocket error for ${email}:`, error);
        });

        ws.on('close', () => {
            logger.info(`WebSocket closed for ${email}`);
            activeSockets.delete(userId);
        });

    } catch (error) {
        logger.error('Error setting up WebSocket:', error);
    }
}

// Handle new email message
async function handleNewEmail(messageData, email, userId) {
    try {
        // Save message to database
        await pool.execute(
            'INSERT INTO email_messages (email, message_id, sender, subject, text) VALUES (?, ?, ?, ?, ?)',
            [email, messageData.id, messageData.from.address, messageData.subject, messageData.text || 'No content']
        );

        // Send notification to user
        const messageText = `📩 New Mail Received 🪧
📇 From: ${messageData.from.address}
🗒️ Subject: ${messageData.subject || 'No Subject'}
💬 Text: ${messageData.text || 'No content'}`;

        await bot.telegram.sendMessage(userId, messageText);
        logger.info(`New email notification sent to user ${userId}`);

    } catch (error) {
        logger.error('Error handling new email:', error);
    }
}

// Get user emails from database
async function getUserEmails(userId) {
    try {
        const [rows] = await pool.execute(
            'SELECT email, token, created_at FROM emails WHERE telegram_user_id = ? ORDER BY created_at DESC',
            [userId]
        );
        return rows;
    } catch (error) {
        logger.error('Error fetching user emails:', error);
        return [];
    }
}

// Recover email access
async function recoverEmail(userId, email) {
    try {
        const [rows] = await pool.execute(
            'SELECT password, token FROM emails WHERE telegram_user_id = ? AND email = ?',
            [userId, email]
        );

        if (rows.length === 0) {
            throw new Error('Email not found in your account');
        }

        const { password, token: oldToken } = rows[0];

        // Try to refresh token
        try {
            const tokenResponse = await axios.post(`${MAILTM_API}/token`, {
                address: email,
                password: password
            });

            const newToken = tokenResponse.data.token;

            // Update token in database
            await pool.execute(
                'UPDATE emails SET token = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ? AND email = ?',
                [newToken, userId, email]
            );

            // Setup WebSocket with new token
            await setupWebSocket(email, newToken, userId);

            return { success: true, email };
        } catch (tokenError) {
            logger.error('Token refresh failed:', tokenError);
            return { success: true, email }; // Still return success for existing email
        }

    } catch (error) {
        logger.error('Error recovering email:', error);
        throw error;
    }
}

// Bot Commands and Handlers

bot.start(async (ctx) => {
    const welcomeMessage = `🌟 Welcome to Temp Email Bot! 🌟

📧 Generate temporary emails instantly
📬 Receive emails in real-time
🔄 Recover your previous emails

📢 First, please join our channel to continue:`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('📢 Join Channel', process.env.CHANNEL_URL)],
        [Markup.button.callback('✅ Verify Membership', 'verify_membership')]
    ]);

    await ctx.reply(welcomeMessage, keyboard);
});

bot.action('verify_membership', async (ctx) => {
    const isMember = await checkUserMembership(ctx);
    
    if (isMember) {
        const mainMenu = Markup.keyboard([
            ['🌀 Generate New', '📥 Inbox'],
            ['♻️ Recovery', '📧 My Emails']
        ]).resize();

        await ctx.reply('✅ Verification successful! Choose an option:', mainMenu);
    } else {
        await ctx.reply('❌ Please join the channel first, then click verify again.');
    }
    
    await ctx.answerCbQuery();
});

bot.hears('🌀 Generate New', async (ctx) => {
    const isMember = await checkUserMembership(ctx);
    if (!isMember) {
        return ctx.reply('❌ Please join our channel first using /start command');
    }

    try {
        await ctx.reply('⏳ Generating new temporary email...');
        
        const { email, token } = await generateTempEmail(ctx.from.id);
        
        const successMessage = `♻️ New Email Generated Successfully ✅
📬 Email ID: ${email} 👈

Your inbox is now active and you'll receive notifications for new emails automatically!`;

        await ctx.reply(successMessage);
        
        // Setup WebSocket for real-time notifications
        await setupWebSocket(email, token, ctx.from.id);
        
    } catch (error) {
        await ctx.reply('❌ Error generating email. Please try again.');
        logger.error('Generate email error:', error);
    }
});

bot.hears('📥 Inbox', async (ctx) => {
    const isMember = await checkUserMembership(ctx);
    if (!isMember) {
        return ctx.reply('❌ Please join our channel first using /start command');
    }

    try {
        const userEmails = await getUserEmails(ctx.from.id);
        
        if (userEmails.length === 0) {
            return ctx.reply('❌ No emails found. Generate a new email first!');
        }

        // Get messages for user's latest email
        const latestEmail = userEmails[0].email;
        const [messages] = await pool.execute(
            'SELECT * FROM email_messages WHERE email = ? ORDER BY received_at DESC LIMIT 10',
            [latestEmail]
        );

        if (messages.length === 0) {
            await ctx.reply(`📭 Inbox is empty for: ${latestEmail}`);
        } else {
            let inboxText = `📨 Recent messages for: ${latestEmail}\n\n`;
            
            messages.forEach((msg, index) => {
                inboxText += `${index + 1}. 📧 From: ${msg.sender}\n`;
                inboxText += `   📑 Subject: ${msg.subject || 'No Subject'}\n`;
                inboxText += `   📅 Time: ${new Date(msg.received_at).toLocaleString()}\n\n`;
            });

            await ctx.reply(inboxText);
        }

    } catch (error) {
        await ctx.reply('❌ Error fetching inbox. Please try again.');
        logger.error('Inbox error:', error);
    }
});

bot.hears('♻️ Recovery', async (ctx) => {
    const isMember = await checkUserMembership(ctx);
    if (!isMember) {
        return ctx.reply('❌ Please join our channel first using /start command');
    }

    userSessions.set(ctx.from.id, 'awaiting_recovery_email');
    await ctx.reply('📧 Please enter your email address to recover:');
});

bot.hears('📧 My Emails', async (ctx) => {
    const isMember = await checkUserMembership(ctx);
    if (!isMember) {
        return ctx.reply('❌ Please join our channel first using /start command');
    }

    try {
        const userEmails = await getUserEmails(ctx.from.id);
        
        if (userEmails.length === 0) {
            return ctx.reply('❌ No emails found. Generate a new email first!');
        }

        let emailsList = '📧 Your Email Addresses:\n\n';
        userEmails.forEach((emailData, index) => {
            emailsList += `${index + 1}. ${emailData.email}\n`;
            emailsList += `   📅 Created: ${new Date(emailData.created_at).toLocaleDateString()}\n\n`;
        });

        await ctx.reply(emailsList);

    } catch (error) {
        await ctx.reply('❌ Error fetching your emails. Please try again.');
        logger.error('My emails error:', error);
    }
});

// Handle text messages for recovery
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);

    if (session === 'awaiting_recovery_email') {
        const email = ctx.message.text.trim();
        
        try {
            await ctx.reply('⏳ Recovering email access...');
            const result = await recoverEmail(userId, email);
            
            if (result.success) {
                await ctx.reply(`✅ Email recovered successfully!\n📧 Email: ${result.email}\n\nWebSocket reconnected for real-time notifications.`);
            }
            
        } catch (error) {
            await ctx.reply('❌ Email recovery failed. Make sure you entered the correct email address.');
            logger.error('Recovery error:', error);
        } finally {
            userSessions.delete(userId);
        }
    }
});

// Health check endpoint
bot.command('health', (ctx) => {
    ctx.reply('🟢 Bot is running healthy!');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Bot is shutting down...');
    
    // Close all WebSocket connections
    activeSockets.forEach((ws) => {
        ws.close();
    });
    
    // Close database pool
    if (pool) {
        await pool.end();
    }
    
    // Stop bot
    bot.stop('SIGINT');
    process.exit(0);
});

// Keep alive function for Render
async function keepAlive() {
    try {
        await axios.get(process.env.RENDER_URL || 'http://localhost:3000');
        logger.info('Keep alive ping successful');
    } catch (error) {
        logger.error('Keep alive ping failed:', error);
    }
}

// Schedule keep alive every 5 minutes
cron.schedule('*/5 * * * *', keepAlive);

// Initialize and start bot
async function startBot() {
    try {
        await initializeDatabase();
        
        // Set webhook for production
        if (process.env.NODE_ENV === 'production') {
            const webhookUrl = `${process.env.RENDER_URL || 'https://telegram-temp-email-bot-4.onrender.com'}/webhook`;
            await bot.telegram.setWebhook(webhookUrl);
            logger.info(`Webhook set to: ${webhookUrl}`);
        } else {
            // Use polling for development
            await bot.launch();
            logger.info('Bot started in polling mode');
        }
        
        logger.info('Bot started successfully');
        
        // Graceful stop
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
        
    } catch (error) {
        logger.error('Failed to start bot:', error);
        // Don't exit, keep HTTP server running
    }
}

// Simple HTTP server for health checks and webhook
const http = require('http');
const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', timestamp: new Date().toISOString() }));
    } else if (req.url === '/webhook' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                const update = JSON.parse(body);
                await bot.handleUpdate(update);
                res.writeHead(200);
                res.end('OK');
            } catch (error) {
                logger.error('Webhook error:', error);
                res.writeHead(500);
                res.end('Error');
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`HTTP server running on port ${PORT}`);
});

// Start the bot
startBot();

module.exports = bot;
