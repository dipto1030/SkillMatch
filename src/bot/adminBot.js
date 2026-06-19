const { Telegraf } = require('telegraf');
const env = require('../config/env');

let adminBot = null;

if (env.ADMIN_BOT_TOKEN && env.ADMIN_BOT_TOKEN !== 'PLACEHOLDER_ADMIN_BOT_TOKEN') {
  adminBot = new Telegraf(env.ADMIN_BOT_TOKEN);
}

const adminAlerts = {
  async send(text, inlineKeyboard = null) {
    if (!adminBot || !env.ADMIN_CHAT_ID || env.ADMIN_CHAT_ID === 'PLACEHOLDER_ADMIN_CHAT_ID') {
      console.log('[Admin Alert]', text.replace(/<[^>]*>/g, ''));
      return;
    }

    const options = { parse_mode: 'HTML' };
    if (inlineKeyboard) {
      options.reply_markup = { inline_keyboard: inlineKeyboard };
    }

    try {
      await adminBot.telegram.sendMessage(env.ADMIN_CHAT_ID, text, options);
    } catch (err) {
      console.error('Failed to send admin alert:', err.message);
    }
  },

  newRegistration(user) {
    this.send(`🆕 <b>New Registration</b>\nName: ${user.display_name}\nTG ID: ${user.id}`);
  },

  disputeOpened(dispute, match) {
    this.send(
      `🔴 <b>New Dispute</b>\nMatch: ${match.match_code} | Pot: ${match.total_pot} Tokens\n` +
      `Track: ${dispute.track || 'pending'}`,
    );
  },

  fastTrackDispute(dispute, match) {
    this.send(
      `⚡ <b>FAST-TRACK Dispute</b>\nMatch: ${match.match_code} | Pot: ${match.total_pot} Tokens\n` +
      `Priority — needs fast resolution`,
    );
  },

  accountFrozen(user, reportCount) {
    this.send(`🚨 <b>Account Frozen</b>\n${user.display_name} — ${reportCount} consecutive reports`);
  },

  highStakesMatch(match) {
    this.send(`👁️ <b>High Stakes</b>\nMatch: ${match.match_code} | Pot: ${match.total_pot} Tokens`);
  },

  juryBadgePurchased(user) {
    this.send(`🏅 <b>New Juror</b>\n${user.display_name} purchased jury badge`);
  },

  flaggedAccount(user, signalType) {
    this.send(`🚩 <b>Fraud Flag</b>\n${user.display_name} — ${signalType}`);
  },

  disputeEscalated(dispute, match) {
    this.send(`📋 <b>Dispute Escalated</b>\nMatch: ${match.match_code} — Post-jury escalation`);
  },
};

module.exports = adminAlerts;
