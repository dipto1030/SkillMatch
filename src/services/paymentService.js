const db = require('../config/database');
const configService = require('./configService');

const paymentService = {
  async handlePreCheckout(preCheckoutQuery) {
    const bot = require('../bot');
    // Always approve pre-checkout (Stars payments don't need extra validation)
    try {
      await bot.telegram.answerPreCheckoutQuery(preCheckoutQuery.id, true);
    } catch (err) {
      console.error('Failed to answer pre_checkout_query:', err.message);
    }
  },

  async handleSuccessfulPayment(message) {
    const userId = message.from.id;
    const payment = message.successful_payment;
    const chargeId = payment.telegram_payment_charge_id;
    const starsAmount = payment.total_amount;
    const tokenRate = configService.get('VAR_TOKEN_RATE', 1);
    const tokensToCredit = starsAmount / tokenRate;

    await db.transaction(async (client) => {
      // Idempotency: check if charge_id already processed
      const { rows: existing } = await client.query(
        'SELECT id FROM star_payments WHERE charge_id = $1',
        [chargeId]
      );
      if (existing.length > 0) return;

      // Store the payment
      await client.query(
        `INSERT INTO star_payments (user_id, stars_amount, tokens_credited, charge_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, starsAmount, tokensToCredit, chargeId]
      );

      // Credit tokens
      await client.query(
        'UPDATE wallets SET available = available + $1 WHERE user_id = $2',
        [tokensToCredit, userId]
      );

      // Ledger entry
      const { rows: wallet } = await client.query(
        'SELECT available FROM wallets WHERE user_id = $1',
        [userId]
      );
      await client.query(
        `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id, note)
         VALUES ($1, 'DEPOSIT', $2, $3, $4, $5)`,
        [userId, tokensToCredit, wallet[0].available, chargeId, `Deposit: ${starsAmount} Stars → ${tokensToCredit} Tokens`]
      );

      // Check for outstanding debt and auto-deduct
      const { rows: debtRows } = await client.query(
        'SELECT id, amount_remaining FROM debts WHERE user_id = $1 AND amount_remaining > 0 ORDER BY created_at ASC',
        [userId]
      );
      // Debt recovery handled in separate service
    });

    // Send confirmation
    const bot = require('../bot');
    await bot.sendNotification(userId, `✅ <b>${tokensToCredit} Tokens</b> added to your wallet.`);
  },

  async createDepositInvoice(userId, tokenAmount) {
    const bot = require('../bot');
    const tokenRate = configService.get('VAR_TOKEN_RATE', 1);
    const starsAmount = Math.ceil(tokenAmount * tokenRate);
    const minDeposit = configService.get('VAR_MIN_DEPOSIT', 10);

    if (tokenAmount < minDeposit) {
      throw Object.assign(new Error(`Minimum deposit is ${minDeposit} Tokens.`), {
        status: 400, code: 'VALIDATION_ERROR',
      });
    }

    // Create Telegram Stars invoice
    const invoice = await bot.telegram.sendInvoice(userId, {
      title: 'SkillMatch Deposit',
      description: `Add ${tokenAmount} Tokens to your SkillMatch wallet`,
      payload: `deposit_${userId}_${Date.now()}`,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: `${tokenAmount} Tokens`, amount: starsAmount }],
    });

    return { invoice_message_id: invoice.message_id, stars_amount: starsAmount, tokens: tokenAmount };
  },

  async processWithdrawal(userId, tokenAmount) {
    const bot = require('../bot');
    const tokenRate = configService.get('VAR_TOKEN_RATE', 1);
    const minWithdrawal = configService.get('VAR_MIN_WITHDRAWAL', 10);

    if (tokenAmount < minWithdrawal) {
      throw Object.assign(new Error(`Minimum withdrawal is ${minWithdrawal} Tokens.`), {
        status: 400, code: 'VALIDATION_ERROR',
      });
    }

    return db.transaction(async (client) => {
      // Check balance
      const { rows: walletRows } = await client.query(
        'SELECT available FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (!walletRows[0] || parseFloat(walletRows[0].available) < tokenAmount) {
        throw Object.assign(new Error('Insufficient available balance.'), {
          status: 400, code: 'INSUFFICIENT_BALANCE',
        });
      }

      const starsToRefund = Math.floor(tokenAmount * tokenRate);

      // Find unused charge IDs (FIFO)
      const { rows: charges } = await client.query(
        `SELECT id, charge_id, stars_amount FROM star_payments
         WHERE user_id = $1 AND used_for_withdrawal = FALSE
         ORDER BY created_at ASC`,
        [userId]
      );

      let starsRemaining = starsToRefund;
      const chargeIdsToUse = [];

      for (const charge of charges) {
        if (starsRemaining <= 0) break;
        chargeIdsToUse.push(charge);
        starsRemaining -= charge.stars_amount;
      }

      if (starsRemaining > 0) {
        throw Object.assign(new Error('Insufficient charge IDs for withdrawal.'), {
          status: 400, code: 'WITHDRAWAL_UNAVAILABLE',
        });
      }

      // Deduct tokens
      await client.query(
        'UPDATE wallets SET available = available - $1 WHERE user_id = $2',
        [tokenAmount, userId]
      );

      // Refund Stars via Telegram
      for (const charge of chargeIdsToUse) {
        try {
          await bot.telegram.callApi('refundStarPayment', { user_id: userId, telegram_payment_charge_id: charge.charge_id });
          await client.query(
            'UPDATE star_payments SET used_for_withdrawal = TRUE WHERE id = $1',
            [charge.id]
          );
        } catch (err) {
          console.error(`Failed to refund charge ${charge.charge_id}:`, err.message);
          throw Object.assign(new Error('Stars refund failed. Please try again.'), {
            status: 500, code: 'REFUND_FAILED',
          });
        }
      }

      // Ledger
      const { rows: wallet } = await client.query(
        'SELECT available FROM wallets WHERE user_id = $1',
        [userId]
      );
      await client.query(
        `INSERT INTO token_ledger (user_id, type, amount, balance_after, note)
         VALUES ($1, 'WITHDRAWAL', $2, $3, $4)`,
        [userId, -tokenAmount, wallet[0].available, `Withdrawal: ${tokenAmount} Tokens → ${starsToRefund} Stars`]
      );

      await bot.sendNotification(userId, `✅ <b>${starsToRefund} Stars</b> sent to your Telegram account.`);

      return { stars_refunded: starsToRefund, tokens_deducted: tokenAmount };
    });
  },
};

module.exports = paymentService;
