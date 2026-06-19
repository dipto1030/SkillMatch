const crypto = require('crypto');
const env = require('../config/env');
const db = require('../config/database');

function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (computedHash !== hash) return null;

    // Check auth_date freshness (max 86400 seconds = 24 hours)
    const authDate = parseInt(params.get('auth_date'), 10);
    if (!authDate || (Date.now() / 1000 - authDate) > 86400) return null;

    const userStr = params.get('user');
    if (!userStr) return null;

    return JSON.parse(decodeURIComponent(userStr));
  } catch (err) {
    console.error('initData validation error:', err.message);
    return null;
  }
}

async function telegramAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('TelegramWebApp ')) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_INVALID', message: 'Missing or invalid authorization header.' },
    });
  }

  const initData = authHeader.slice('TelegramWebApp '.length);

  // In development with placeholder token, allow a dev bypass
  let telegramUser;
  if (env.NODE_ENV === 'development' && env.BOT_TOKEN === 'PLACEHOLDER_BOT_TOKEN') {
    // Dev mode: accept raw JSON user object for testing
    try {
      telegramUser = JSON.parse(initData);
    } catch {
      return res.status(401).json({
        success: false,
        error: { code: 'AUTH_INVALID', message: 'Invalid dev auth payload.' },
      });
    }
  } else {
    telegramUser = validateInitData(initData, env.BOT_TOKEN);
  }

  if (!telegramUser || !telegramUser.id) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_INVALID', message: 'initData validation failed.' },
    });
  }

  // Check if user exists and is not banned/frozen
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [telegramUser.id]);
    if (rows.length > 0) {
      const user = rows[0];
      if (user.is_banned) {
        return res.status(403).json({
          success: false,
          error: { code: 'AUTH_BANNED', message: 'Your account is banned.' },
        });
      }
      if (user.is_frozen) {
        return res.status(403).json({
          success: false,
          error: { code: 'AUTH_FROZEN', message: 'Your account is frozen pending review.' },
        });
      }
      req.user = user;
    }

    req.telegramUser = telegramUser;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { telegramAuth, validateInitData };
