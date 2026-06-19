const jwt = require('jsonwebtoken');
const env = require('../config/env');

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_INVALID', message: 'Missing admin authorization.' },
    });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, env.ADMIN_JWT_SECRET);
    if (!decoded.isAdmin) {
      return res.status(403).json({
        success: false,
        error: { code: 'AUTH_INVALID', message: 'Not an admin token.' },
      });
    }
    req.adminId = decoded.adminId;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_INVALID', message: 'Invalid or expired admin token.' },
    });
  }
}

module.exports = { adminAuth };
