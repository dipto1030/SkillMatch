const redis = require('../config/redis');

function createRateLimiter(keyPrefix, maxRequests, windowSeconds) {
  return async (req, res, next) => {
    const userId = req.user?.id || req.adminId || req.ip;
    const key = `rl:${keyPrefix}:${userId}`;

    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      if (current > maxRequests) {
        return res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
        });
      }

      next();
    } catch (err) {
      // If Redis is down, allow the request
      console.error('Rate limiter error:', err.message);
      next();
    }
  };
}

// Pre-configured limiters per SRS Section 11.5
const rateLimiters = {
  createMatch: createRateLimiter('create_match', 10, 60),
  createDispute: createRateLimiter('create_dispute', 5, 3600),
  reportPlayer: createRateLimiter('report', 3, 3600),
  createDeposit: createRateLimiter('deposit', 10, 3600),
  withdraw: createRateLimiter('withdraw', 3, 3600),
  adminEndpoint: createRateLimiter('admin', 200, 60),
  webhookGlobal: createRateLimiter('webhook', 1000, 60),
};

module.exports = { createRateLimiter, rateLimiters };
