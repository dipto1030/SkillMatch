const express = require('express');
const router = express.Router();
const env = require('../config/env');
const paymentHandler = require('../services/paymentService');

router.post('/telegram', async (req, res) => {
  // Validate webhook secret if configured
  if (env.WEBHOOK_SECRET) {
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
    if (secretHeader && secretHeader !== env.WEBHOOK_SECRET) {
      return res.sendStatus(403);
    }
  }

  const update = req.body;

  try {
    // Handle pre_checkout_query (must respond within 10 seconds)
    if (update.pre_checkout_query) {
      await paymentHandler.handlePreCheckout(update.pre_checkout_query);
      return res.sendStatus(200);
    }

    // Handle successful payment
    if (update.message && update.message.successful_payment) {
      await paymentHandler.handleSuccessfulPayment(update.message);
      return res.sendStatus(200);
    }

    // Pass other updates to Telegraf bot for command handling
    const bot = require('./index');
    await bot.handleUpdate(update);

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook processing error:', err);
    // Always respond 200 to Telegram to prevent retries on app errors
    res.sendStatus(200);
  }
});

module.exports = router;
