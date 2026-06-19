const { Telegraf } = require('telegraf');
const env = require('../config/env');

const bot = new Telegraf(env.BOT_TOKEN);

// /start command — sends the Mini App launch button
bot.start(async (ctx) => {
  await ctx.reply('Welcome to SkillMatch 🎮\nTap the button below to open the app!', {
    reply_markup: {
      inline_keyboard: [[{
        text: '🎮 Open SkillMatch',
        web_app: { url: env.WEBAPP_URL },
      }]],
    },
  });
});

// /appeal command — ban appeal entry point
bot.command('appeal', async (ctx) => {
  await ctx.reply(
    'To appeal a ban, please provide new evidence not previously reviewed.\n' +
    'Send your appeal as a message here, and it will be forwarded to admin for review.\n\n' +
    'Note: Frivolous appeals (no new evidence) will result in an additional Warning.',
  );
});

// Notification helper — sends a message to a user by their Telegram ID
bot.sendNotification = async (telegramUserId, text, options = {}) => {
  try {
    await bot.telegram.sendMessage(telegramUserId, text, {
      parse_mode: 'HTML',
      ...options,
    });
  } catch (err) {
    console.error(`Failed to send notification to ${telegramUserId}:`, err.message);
  }
};

// Invoice helper
bot.sendDepositInvoice = async (userId, title, description, payload, currency, prices) => {
  try {
    return await bot.telegram.sendInvoice(userId, {
      title,
      description,
      payload,
      provider_token: '',
      currency,
      prices,
    });
  } catch (err) {
    console.error(`Failed to send invoice to ${userId}:`, err.message);
    throw err;
  }
};

module.exports = bot;
