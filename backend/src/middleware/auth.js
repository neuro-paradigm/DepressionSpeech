const User = require('../models/User');
const mongoose = require('mongoose');
const { verifyToken } = require('../utils/auth');

async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const payload = verifyToken(token);
    if (!payload?.id) return res.status(401).json({ message: 'Authentication required.' });
    if (!mongoose.Types.ObjectId.isValid(payload.id)) return res.status(401).json({ message: 'Invalid authentication token.' });

    const user = await User.findById(payload.id);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    if (user.role !== 'admin') {
      user.role = 'admin';
      await user.save();
    }
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required.' });
  next();
}

module.exports = { requireAuth, requireAdmin };
