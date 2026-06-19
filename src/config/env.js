require('dotenv').config();

const env = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',

  DATABASE_URL: process.env.DATABASE_URL,

  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  BOT_TOKEN: process.env.BOT_TOKEN,
  WEBAPP_URL: process.env.WEBAPP_URL || 'http://localhost:5173',

  ADMIN_BOT_TOKEN: process.env.ADMIN_BOT_TOKEN,
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID,

  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  WEBHOOK_URL: process.env.WEBHOOK_URL,

  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
  ADMIN_JWT_EXPIRY: process.env.ADMIN_JWT_EXPIRY || '24h',

  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 10,

  PLATFORM_TIMEZONE: process.env.PLATFORM_TIMEZONE || 'Asia/Dhaka',
};

module.exports = env;
