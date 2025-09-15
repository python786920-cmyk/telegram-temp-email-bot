require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mysql = require('mysql2/promise');
const axios = require('axios');
const WebSocket = require('ws');
const express = require('express');
const cron = require('node-cron');

// Initialize Express for health checks
const app = express();
app.get('/', (req, res) => res.send('🤖 Telegram Temp Email Bot is Running!'));
app.listen(process.env.PORT || 3001);

// Initialize Telegram Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Database connection
let db;
async function initDatabase() {
    try {
        db = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            charset: 'utf8mb4'
        });

        // Create tables if not exist
        await db.execute(`
            CREATE TABLE IF NOT EXISTS emails (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                password VARCHAR(255) NOT NULL,
                token TEXT NOT NULL,
                telegram_user_id BIGINT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user_id (telegram_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        // Add updated_at column if it doesn't exist
        try {
            await db.execute(`ALTER TABLE emails ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
        } catch (error) {
            // Column might already exist, ignore error
            if (!error.message.includes('Duplicate column name')) {
                console.log('Note: updated_at column handling:', error.message);
            }
        }

        await db.execute(`
            CREATE TABLE IF NOT EXISTS email_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                message_id VARCHAR(255) NOT NULL,
                sender VARCHAR(255) NOT NULL,
                subject TEXT,
                text TEXT,
                html TEXT,
                received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_email (email),
                INDEX idx_message_id (message_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        console.log('✅ Database connected and tables created');
    } catch (error) {
        console.error('❌ Database connection failed:', error);
        process.exit(1);
    }
}

// WebSocket connections for real-time email monitoring
const activeConnections = new Map();

// Mail.tm API functions
class MailTMAPI {
    static async getDomains() {
        try {
            const response = await axios.get(`${process.env.MAILTM_API_URL}/domains`);
            return response.data['hydra:member'].filter(domain => domain.isActive);
        } catch (error) {
            console.error('Error fetching domains:', error);
            return [];
        }
    }

    static async createAccount(address, password) {
        try {
            const response = await axios.post(`${process.env.MAILTM_API_URL}/accounts`, {
                address,
                password
            });
            return response.data;
        } catch (error) {
            console.error('Error creating account:', error);
            return null;
        }
    }

    static async getToken(address, password) {
        try {
            const response = await axios.post(`${process.env.MAILTM_API_URL}/token`, {
                address,
                password
            });
            return response.data;
        } catch (error) {
            console.error('Error getting token:', error);
            return null;
        }
    }

    static async getMessages(token, page = 1) {
        try {
            const response = await axios.get(`${process.env.MAILTM_API_URL}/messages?page=${page}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            return response.data['hydra:member'] || [];
        } catch (error) {
            console.error('Error fetching messages:', error);
            return [];
        }
    }

    static async getMessage(token, messageId) {
        try {
            const response = await axios.get(`${process.env.MAILTM_API_URL}/messages/${messageId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            return response.data;
        } catch (error) {
            console.error('Error fetching message details:', error);
            return null;
        }
    }

    static async markAsRead(token, messageId) {
        try {
            await axios.patch(`${process.env.MAILTM_API_URL}/messages/${messageId}`, {}, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            return true;
        } catch (error) {
            console.error('Error marking message as read:', error);
            return false;
        }
    }
}

// WebSocket connection for real-time updates
function connectWebSocket(accountId, token, userTelegramId, email) {
    const wsUrl = `${process.env.MAILTM_WS_URL}?topic=/accounts/${accountId}`;
    const ws = new WebSocket(wsUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    ws.on('open', () => {
        console.log(`🔗 WebSocket connected for ${email}`);
        activeConnections.set(email, { ws, userTelegramId, token });
    });

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            // Check if it's a new message notification
            if (message.type === 'update' && message.data) {
                // Fetch latest messages
                const messages = await MailTMAPI.getMessages(token, 1);
                if (messages.length > 0) {
                    const latestMessage = messages[0];
                    
                    // Check if we already notified about this message
                    const [existing] = await db.execute(
                        'SELECT id FROM email_messages WHERE message_id = ?',
                        [latestMessage.id]
                    );

                    if (existing.length === 0) {
                        // Save to database
                        await db.execute(`
                            INSERT INTO email_messages (email, message_id, sender, subject, text, received_at)
                            VALUES (?, ?, ?, ?, ?, NOW())
                        `, [
                            email,
                            latestMessage.id,
                            latestMessage.from?.address || 'Unknown',
                            latestMessage.subject || 'No Subject',
                            latestMessage.intro || 'No Content'
                        ]);

                        // Send notification to Telegram
                        const notificationText = `📩 New Mail Received In Your Email ID 🪧\n\n📇 From: ${latestMessage.from?.address || 'Unknown'}\n🗒️ Subject: ${latestMessage.subject || 'No Subject'}\n💬 Text: ${(latestMessage.intro || 'No Content').substring(0, 200)}${(latestMessage.intro?.length > 200) ? '...' : ''}\n\n📬 Email: ${email}`;

                        try {
                            await bot.telegram.sendMessage(userTelegramId, notificationText, {
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: '📖 Read Full Message', callback_data: `read_${latestMessage.id}_${email}` },
                                        { text: '📥 View Inbox', callback_data: `inbox_${email}` }
                                    ]]
                                }
                            });
                        } catch (telegramError) {
                            console.error('Error sending Telegram notification:', telegramError);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
        }
    });

    ws.on('error', (error) => {
        console.error(`❌ WebSocket error for ${email}:`, error);
        activeConnections.delete(email);
        
        // Attempt to reconnect after 30 seconds
        setTimeout(() => {
            connectWebSocket(accountId, token, userTelegramId, email);
        }, 30000);
    });

    ws.on('close', () => {
        console.log(`🔌 WebSocket closed for ${email}`);
        activeConnections.delete(email);
        
        // Attempt to reconnect after 10 seconds
        setTimeout(() => {
            connectWebSocket(accountId, token, userTelegramId, email);
        }, 10000);
    });
}

// Utility functions
function generateRandomString(length = 8) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

async function checkChannelMembership(userId, channelId) {
    try {
        const member = await bot.telegram.getChatMember(channelId, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
        console.error('Error checking channel membership:', error);
        return false;
    }
}

// Bot command handlers
bot.start(async (ctx) => {
    const welcomeText = `👑 Hey There! Welcome To Temp Email Bot!!\n\n⚪️ Join All The Channels Below\n🤩 After Joining Click Verify`;
    
    await ctx.reply(welcomeText, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📢 Join Channel', url: 'https://t.me/earning_tips009' }],
                [{ text: '✅ Verify', callback_data: 'verify_membership' }]
            ]
        }
    });
});

// Verify membership callback
bot.action('verify_membership', async (ctx) => {
    const userId = ctx.from.id;
    
    // Check if user is member of the channel
    const isMember = await checkChannelMembership(userId, process.env.CHANNEL_ID || '@earning_tips009');
    
    if (isMember) {
        const mainMenuText = `🎉 Verification Successful!\n\nChoose an option below:`;
        await ctx.editMessageText(mainMenuText, {
            reply_markup: {
                keyboard: [
                    [{ text: '🌀 Generate New' }, { text: '📥 Inbox' }],
                    [{ text: '♻️ Recovery' }, { text: '📧 My Email' }]
                ],
                resize_keyboard: true
            }
        });
    } else {
        await ctx.answerCbQuery('❌ Please join the channel first!', { show_alert: true });
    }
});

// Generate new email
bot.hears('🌀 Generate New', async (ctx) => {
    try {
        const userId = ctx.from.id;
        
        // Get available domains
        const domains = await MailTMAPI.getDomains();
        if (domains.length === 0) {
            return ctx.reply('❌ No domains available. Please try again later.');
        }

        // Generate random email
        const username = generateRandomString(10);
        const domain = domains[0].domain;
        const email = `${username}@${domain}`;
        const password = generateRandomString(12);

        // Create account
        const account = await MailTMAPI.createAccount(email, password);
        if (!account) {
            return ctx.reply('❌ Failed to create email. Please try again.');
        }

        // Get token
        const tokenData = await MailTMAPI.getToken(email, password);
        if (!tokenData) {
            return ctx.reply('❌ Failed to authenticate email. Please try again.');
        }

        // Save to database
        await db.execute(`
            INSERT INTO emails (email, password, token, telegram_user_id)
            VALUES (?, ?, ?, ?)
        `, [email, password, tokenData.token, userId]);

        // Start WebSocket connection for real-time updates
        connectWebSocket(tokenData.id, tokenData.token, userId, email);

        const successText = `♻️ New Email Generated Successfully ✅\n\n📬 Email ID: ${email} 👈\n\n🔔 Real-time notifications are now active!`;
        
        await ctx.reply(successText, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📥 View Inbox', callback_data: `inbox_${email}` }],
                    [{ text: '🌀 Generate Another', callback_data: 'generate_new' }]
                ]
            }
        });
    } catch (error) {
        console.error('Error generating email:', error);
        ctx.reply('❌ An error occurred. Please try again.');
    }
});

// View inbox
bot.hears('📥 Inbox', async (ctx) => {
    try {
        const userId = ctx.from.id;
        
        // Get user's emails
        const [emails] = await db.execute(
            'SELECT * FROM emails WHERE telegram_user_id = ? ORDER BY created_at DESC',
            [userId]
        );

        if (emails.length === 0) {
            return ctx.reply('❌ No emails found. Generate a new email first!', {
                reply_markup: {
                    inline_keyboard: [[{ text: '🌀 Generate New Email', callback_data: 'generate_new' }]]
                }
            });
        }

        const buttons = emails.map(email => [{
            text: `📥 ${email.email}`,
            callback_data: `inbox_${email.email}`
        }]);

        await ctx.reply('📬 Select an email to view inbox:', {
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (error) {
        console.error('Error viewing inbox:', error);
        ctx.reply('❌ An error occurred. Please try again.');
    }
});

// Recovery email
bot.hears('♻️ Recovery', async (ctx) => {
    ctx.reply('🔍 Please send me your email address to recover:');
    ctx.session = { waitingForEmail: true };
});

// My Email
bot.hears('📧 My Email', async (ctx) => {
    try {
        const userId = ctx.from.id;
        
        const [emails] = await db.execute(
            'SELECT * FROM emails WHERE telegram_user_id = ? ORDER BY created_at DESC',
            [userId]
        );

        if (emails.length === 0) {
            return ctx.reply('❌ No emails found!');
        }

        let emailList = '📧 Your Generated Emails:\n\n';
        emails.forEach((email, index) => {
            emailList += `${index + 1}. ${email.email}\n📅 Created: ${email.created_at.toLocaleDateString()}\n\n`;
        });

        await ctx.reply(emailList);
    } catch (error) {
        console.error('Error fetching user emails:', error);
        ctx.reply('❌ An error occurred. Please try again.');
    }
});

// Handle inbox callback
bot.action(/^inbox_(.+)$/, async (ctx) => {
    try {
        const email = ctx.match[1];
        const userId = ctx.from.id;

        // Get email token from database
        const [emailData] = await db.execute(
            'SELECT * FROM emails WHERE email = ? AND telegram_user_id = ?',
            [email, userId]
        );

        if (emailData.length === 0) {
            return ctx.answerCbQuery('❌ Email not found!', { show_alert: true });
        }

        const token = emailData[0].token;

        // Get messages
        const messages = await MailTMAPI.getMessages(token);
        
        if (messages.length === 0) {
            return ctx.editMessageText(`📭 Inbox Empty\n\n📬 Email: ${email}\n\n🔔 Waiting for new messages...`);
        }

        let inboxText = `📥 Inbox for ${email}\n\n`;
        const messageButtons = [];

        messages.slice(0, 5).forEach((message, index) => {
            inboxText += `${index + 1}. From: ${message.from?.address || 'Unknown'}\n`;
            inboxText += `   Subject: ${message.subject || 'No Subject'}\n`;
            inboxText += `   Time: ${new Date(message.createdAt).toLocaleString()}\n\n`;
            
            messageButtons.push([{
                text: `📖 Read Message ${index + 1}`,
                callback_data: `read_${message.id}_${email}`
            }]);
        });

        messageButtons.push([{ text: '🔄 Refresh Inbox', callback_data: `inbox_${email}` }]);

        await ctx.editMessageText(inboxText, {
            reply_markup: { inline_keyboard: messageButtons }
        });
    } catch (error) {
        console.error('Error viewing inbox:', error);
        ctx.answerCbQuery('❌ Error loading inbox!', { show_alert: true });
    }
});

// Handle read message callback
bot.action(/^read_(.+)_(.+)$/, async (ctx) => {
    try {
        const messageId = ctx.match[1];
        const email = ctx.match[2];
        const userId = ctx.from.id;

        // Get email token
        const [emailData] = await db.execute(
            'SELECT token FROM emails WHERE email = ? AND telegram_user_id = ?',
            [email, userId]
        );

        if (emailData.length === 0) {
            return ctx.answerCbQuery('❌ Email not found!', { show_alert: true });
        }

        const token = emailData[0].token;

        // Get message details
        const message = await MailTMAPI.getMessage(token, messageId);
        if (!message) {
            return ctx.answerCbQuery('❌ Message not found!', { show_alert: true });
        }

        // Mark as read
        await MailTMAPI.markAsRead(token, messageId);

        let messageText = `📧 Email Details\n\n`;
        messageText += `📬 To: ${email}\n`;
        messageText += `📤 From: ${message.from?.address || 'Unknown'}\n`;
        messageText += `📋 Subject: ${message.subject || 'No Subject'}\n`;
        messageText += `📅 Date: ${new Date(message.createdAt).toLocaleString()}\n\n`;
        messageText += `💬 Content:\n${message.text || message.html?.[0] || 'No content available'}`;

        // Truncate if too long
        if (messageText.length > 4000) {
            messageText = messageText.substring(0, 3900) + '\n\n... (Message truncated)';
        }

        await ctx.editMessageText(messageText, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Back to Inbox', callback_data: `inbox_${email}` }],
                    [{ text: '❌ Close', callback_data: 'delete_message' }]
                ]
            }
        });
    } catch (error) {
        console.error('Error reading message:', error);
        ctx.answerCbQuery('❌ Error loading message!', { show_alert: true });
    }
});

// Handle generate new callback
bot.action('generate_new', async (ctx) => {
    // Trigger the generate new email function
    ctx.session = null; // Clear session
    return ctx.scene.enter('generate_email');
});

// Handle delete message callback
bot.action('delete_message', async (ctx) => {
    try {
        await ctx.deleteMessage();
    } catch (error) {
        console.error('Error deleting message:', error);
    }
});

// Handle text messages for recovery
bot.on('text', async (ctx) => {
    if (ctx.session?.waitingForEmail) {
        const emailToRecover = ctx.message.text.trim();
        const userId = ctx.from.id;

        try {
            // Check if email exists in database
            const [emails] = await db.execute(
                'SELECT * FROM emails WHERE email = ? AND telegram_user_id = ?',
                [emailToRecover, userId]
            );

            if (emails.length === 0) {
                ctx.session = null;
                return ctx.reply('❌ Email not found in your account!');
            }

            const emailData = emails[0];
            
            // Try to refresh the token
            const tokenData = await MailTMAPI.getToken(emailData.email, emailData.password);
            if (tokenData) {
                // Update token in database
                await db.execute(
                    'UPDATE emails SET token = ?, updated_at = NOW() WHERE id = ?',
                    [tokenData.token, emailData.id]
                );

                // Restart WebSocket connection
                connectWebSocket(tokenData.id, tokenData.token, userId, emailData.email);

                ctx.reply(`✅ Email recovered successfully!\n\n📬 Email: ${emailData.email}\n🔔 Real-time notifications reactivated!`);
            } else {
                ctx.reply(`❌ Failed to recover email. It may have expired.`);
            }
        } catch (error) {
            console.error('Error recovering email:', error);
            ctx.reply('❌ Error occurred during recovery.');
        }

        ctx.session = null;
    }
});

// Restore WebSocket connections on startup
async function restoreConnections() {
    try {
        // Use created_at instead of updated_at for compatibility
        const [emails] = await db.execute('SELECT * FROM emails WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)');
        
        for (const emailData of emails) {
            try {
                // Try to refresh token
                const tokenData = await MailTMAPI.getToken(emailData.email, emailData.password);
                if (tokenData) {
                    // Update token
                    await db.execute(
                        'UPDATE emails SET token = ? WHERE id = ?',
                        [tokenData.token, emailData.id]
                    );
                    
                    // Restore WebSocket connection
                    connectWebSocket(tokenData.id, tokenData.token, emailData.telegram_user_id, emailData.email);
                    console.log(`🔗 Restored connection for ${emailData.email}`);
                }
            } catch (error) {
                console.error(`❌ Failed to restore connection for ${emailData.email}:`, error);
            }
        }
    } catch (error) {
        console.error('Error restoring connections:', error);
    }
}

// Keep-alive cron job for Render.com
cron.schedule('*/5 * * * *', async () => {
    try {
        const response = await axios.get(`http://localhost:${process.env.PORT || 3000}`);
        console.log('🏓 Keep-alive ping successful');
    } catch (error) {
        console.error('❌ Keep-alive ping failed:', error);
    }
});

// Error handling
bot.catch((err, ctx) => {
    console.error('❌ Bot error:', err);
    try {
        ctx.reply('❌ An unexpected error occurred. Please try again.');
    } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
    }
});

// Initialize and start
async function start() {
    try {
        await initDatabase();
        
        // Add delay to prevent bot conflicts
        console.log('⏳ Waiting 10 seconds before starting bot to prevent conflicts...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Restore WebSocket connections after delay
        setTimeout(restoreConnections, 15000);
        
        // Start bot with webhook mode for production
        if (process.env.NODE_ENV === 'production') {
            // Use webhook mode to prevent conflicts
            const PORT = process.env.PORT || 3000;
            const webhookPath = `/webhook/${process.env.BOT_TOKEN}`;
            
            // Set webhook
            await bot.telegram.setWebhook(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}${webhookPath}`);
            
            // Start webhook
            bot.startWebhook(webhookPath, null, PORT);
            console.log(`🚀 Bot started in webhook mode on port ${PORT}`);
        } else {
            // Use polling for development
            await bot.launch();
            console.log('🚀 Bot started in polling mode');
        }
        
        console.log(`📡 Bot is ready and listening!`);
        
        // Graceful shutdown
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
        
    } catch (error) {
        console.error('❌ Failed to start bot:', error);
        
        // If webhook fails, try polling mode
        if (process.env.NODE_ENV === 'production' && error.message.includes('409')) {
            console.log('🔄 Webhook failed, trying polling mode...');
            try {
                await bot.telegram.deleteWebhook();
                await new Promise(resolve => setTimeout(resolve, 5000));
                await bot.launch();
                console.log('🚀 Bot started in polling mode as fallback');
            } catch (fallbackError) {
                console.error('❌ Fallback also failed:', fallbackError);
                process.exit(1);
            }
        } else {
            process.exit(1);
        }
    }
}

start();
