const express     = require('express');
const router      = express.Router();
const jwt         = require('jsonwebtoken');
const bcrypt      = require('bcryptjs');
const userService = require('../services/userService');
const { updatePasswordHash } = userService;
const { OAuth2Client } = require('google-auth-library');

const JWT_SECRET  = process.env.JWT_SECRET || 'mtd-reclutamiento-2026-change-in-prod';
const JWT_EXPIRES = '8h';
const COOKIE_NAME = 'mtd_token';

// Protección contra fuerza bruta: 5 intentos → bloqueo 15 min
const _attempts = new Map();
function _checkLock(email) {
  const rec = _attempts.get(email) || { n: 0, until: 0 };
  if (rec.until > Date.now()) {
    const mins = Math.ceil((rec.until - Date.now()) / 60000);
    throw { locked: true, mins };
  }
}
function _recordFail(email) {
  const rec = _attempts.get(email) || { n: 0, until: 0 };
  rec.n++;
  if (rec.n >= 5) { rec.until = Date.now() + 15 * 60 * 1000; rec.n = 0; }
  _attempts.set(email, rec);
}
function _clearFail(email) { _attempts.delete(email); }
const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge:   8 * 60 * 60 * 1000,
};

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, error: 'Email y contraseña requeridos' });

  const emailKey = email.toLowerCase().trim();
  try {
    _checkLock(emailKey);

    const user = await userService.getUserByEmail(email);
    if (!user || !user.activo) {
      _recordFail(emailKey);
      await new Promise(r => setTimeout(r, 600));
      return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }

    // Si admin cambió el password en Sheets (plain text no coincide con hash), re-sincronizar
    if (user.password && user.password_hash) {
      const plainMatchesHash = await bcrypt.compare(user.password, user.password_hash);
      if (!plainMatchesHash) {
        const newHash = await bcrypt.hash(user.password, 10);
        await updatePasswordHash(user.email, newHash).catch(() => {});
        user.password_hash = newHash;
      }
    } else if (user.password && !user.password_hash) {
      const newHash = await bcrypt.hash(user.password, 10);
      await updatePasswordHash(user.email, newHash).catch(() => {});
      user.password_hash = newHash;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      _recordFail(emailKey);
      await new Promise(r => setTimeout(r, 600));
      return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }
    _clearFail(emailKey);

    const token = jwt.sign(
      { email: user.email, rol: user.rol, nombre: user.nombre },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ success: true, user: { nombre: user.nombre, email: user.email, rol: user.rol } });
  } catch (err) {
    if (err.locked) {
      return res.status(429).json({ success: false, error: `Cuenta bloqueada temporalmente. Intenta en ${err.mins} minuto${err.mins > 1 ? 's' : ''}.` });
    }
    console.error('[Auth] login error:', err.message);
    res.status(500).json({ success: false, error: 'Error del servidor al verificar credenciales' });
  }
});

const _GOOGLE_NET_ERRORS = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED', 'EAI_AGAIN', 'EPIPE']);

async function _verifyGoogleCredential(credential) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!credential || !clientId) throw new Error('Google OAuth no configurado');
  const client = new OAuth2Client(clientId);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ticket  = await client.verifyIdToken({ idToken: credential, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload.email_verified) throw new Error('Email de Google no verificado');
      return (payload.email || '').toLowerCase();
    } catch (e) {
      const isNet = _GOOGLE_NET_ERRORS.has(e.code || '') ||
                    (e.message || '').toLowerCase().includes('timeout') ||
                    (e.message || '').toLowerCase().includes('network') ||
                    (e.message || '').toLowerCase().includes('econnreset');
      if (isNet && attempt < 3) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw e;
    }
  }
}

// POST /api/auth/google — Login con Google OAuth (llamada JSON desde frontend)
router.post('/google', async (req, res) => {
  try {
    const email = await _verifyGoogleCredential(req.body.credential);
    const user  = await userService.getUserByEmail(email);
    if (!user || !user.activo)
      return res.status(401).json({ success: false, error: `${email} no está autorizado. Contacta al administrador.` });

    const token = jwt.sign(
      { email: user.email, rol: user.rol, nombre: user.nombre },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ success: true, user: { nombre: user.nombre, email: user.email, rol: user.rol } });
  } catch (err) {
    console.error('[Auth] Google:', err.message);
    res.status(401).json({ success: false, error: err.message || 'Token de Google inválido' });
  }
});

// POST /api/auth/google/callback — Redirect mode: Google hace POST con credential en form body
router.post('/google/callback', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const email = await _verifyGoogleCredential(req.body.credential);
    const user  = await userService.getUserByEmail(email);
    if (!user || !user.activo) {
      return res.redirect(`/login?error=${encodeURIComponent(`${email} no está autorizado`)}`);
    }
    const token = jwt.sign(
      { email: user.email, rol: user.rol, nombre: user.nombre },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.redirect('/');
  } catch (err) {
    console.error('[Auth] Google callback:', err.message);
    res.redirect(`/login?error=${encodeURIComponent('Google: ' + (err.message || 'error desconocido').slice(0, 120))}`);
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  const token = req.cookies?.mtd_token;
  if (!token) return res.status(401).json({ success: false });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    res.json({ success: true, user: { nombre: user.nombre, email: user.email, rol: user.rol } });
  } catch {
    res.clearCookie(COOKIE_NAME);
    res.status(401).json({ success: false, error: 'Sesión expirada' });
  }
});

module.exports = router;
