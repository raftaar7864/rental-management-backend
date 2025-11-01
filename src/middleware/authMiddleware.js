// backend/src/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

exports.requireAuth = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided' });
    }
    const token = auth.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      // more specific error responses help debugging
      if (err.name === 'TokenExpiredError') {
        console.warn('requireAuth: token expired', err);
        return res.status(401).json({ message: 'Token expired' });
      }
      console.warn('requireAuth: invalid token', err);
      return res.status(401).json({ message: 'Invalid token' });
    }

    if (!decoded || !decoded.id) {
      return res.status(401).json({ message: 'Invalid token payload' });
    }

    // attach user summary on req.user (exclude password)
    const user = await User.findById(decoded.id).select('-password').populate('building');
    if (!user) return res.status(401).json({ message: 'Invalid token (no matching user)' });

    // ensure role is a string (defensive)
    user.role = user.role ? String(user.role).toLowerCase() : '';

    req.user = user;
    next();
  } catch (err) {
    console.error('requireAuth unexpected error', err && err.stack ? err.stack : err);
    return res.status(500).json({ message: 'Authorization error' });
  }
};

// role check middleware factory: usage requireRole('Admin') or requireRole('Manager','Admin')
exports.requireRole = (...allowed) => {
  // normalize allowed roles to lowercase once
  const allowedLower = allowed.map(r => (r || '').toString().toLowerCase());
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

    const userRole = (req.user.role || '').toString().toLowerCase();
    if (!allowedLower.includes(userRole)) {
      return res.status(403).json({ message: 'Forbidden: insufficient role' });
    }
    next();
  };
};
