const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'mtd-reclutamiento-2026-change-in-prod';

module.exports = function authenticate(req, res, next) {
  const token = req.cookies?.mtd_token;
  if (!token) return res.status(401).json({ success: false, error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Sesión expirada' });
  }
};
