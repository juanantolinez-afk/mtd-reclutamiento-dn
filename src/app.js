// Desarrollado por donangeel · 2026
const express      = require('express');
const cors         = require('cors');
const morgan       = require('morgan');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');
const jwt          = require('jsonwebtoken');

const vacanciesRouter = require('./routes/vacancies');
const sheetsRouter    = require('./routes/sheets');
const authRouter      = require('./routes/auth');
const authenticate    = require('./middleware/authenticate');
const errorHandler    = require('./middleware/errorHandler');

const JWT_SECRET    = process.env.JWT_SECRET || 'mtd-reclutamiento-2026-change-in-prod';
const BUILD_VERSION = Date.now();

const app = express();

// Confiar en el proxy de Bonto para que req.protocol sea 'https'
app.set('trust proxy', 1);

app.use(compression({
  filter: (req, res) => {
    if (req.headers.accept?.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ credentials: true }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 80,
  message: { success: false, error: 'Too many requests.' },
});

// ── Auth (sin middleware) ───────────────────────────────────────────────────
app.use('/api/auth', limiter, authRouter);

// ── Config y health (sin middleware) ────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const sid = process.env.GOOGLE_SPREADSHEET_ID;
  const sheetsUrl = process.env.GOOGLE_SHEETS_URL ||
    (sid ? `https://docs.google.com/spreadsheets/d/${sid}/edit` : '');
  res.json({ sheetsUrl, googleOauthEnabled: !!process.env.GOOGLE_OAUTH_CLIENT_ID });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'MTD Reclutamiento',
    timestamp: new Date().toISOString(),
    env: {
      bizneo:     !!process.env.BIZNEO_API_TOKEN,
      openrouter: !!process.env.OPENROUTER_API_KEY,
      sheets:     !!process.env.GOOGLE_SPREADSHEET_ID,
    },
  });
});

// Clasificaciones (sin auth — frontend las usa para display)
app.get('/api/config/clasificaciones', async (req, res) => {
  try {
    const { getClasificaciones } = require('./services/sheetsService');
    const data = await getClasificaciones();
    res.json({ success: true, data });
  } catch { res.json({ success: false, data: [] }); }
});

// ── Rutas protegidas ─────────────────────────────────────────────────────────
app.use('/api', limiter, authenticate);
app.use('/api/vacancies', vacanciesRouter);
app.use('/api/sheets',    sheetsRouter);

// Dispara recordatorios manualmente para probar (solo admin)
app.post('/api/admin/test-reminders', async (req, res) => {
  try {
    const { rol } = req.user || {};
    if (rol !== 'admin') return res.status(403).json({ success: false, error: 'Solo admin' });
    const calendarService = require('./services/calendarService');
    const sheetsService   = require('./services/sheetsService');
    await calendarService.checkAndSendReminders(sheetsService);
    res.json({ success: true, message: 'Chequeo ejecutado — revisa tu correo y los logs.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Página de login ──────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const token = req.cookies?.mtd_token;
  if (token) {
    try { jwt.verify(token, JWT_SECRET); return res.redirect('/'); } catch {}
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
  const loginUri = process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8')
    .replace('__GOOGLE_CLIENT_ID__', clientId)
    .replace('__GOOGLE_OAUTH_ENABLED__', clientId ? 'true' : 'false')
    .replace('__LOGIN_URI__', loginUri);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(html);
});

// ── App principal (requiere auth) ────────────────────────────────────────────
const serveIndex = (req, res) => {
  const token = req.cookies?.mtd_token;
  if (!token) return res.redirect('/login');
  try { jwt.verify(token, JWT_SECRET); }
  catch { res.clearCookie('mtd_token'); return res.redirect('/login'); }

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
    .replace('"/css/styles.css"', `"/css/styles.css?v=${BUILD_VERSION}"`)
    .replace('"/js/app.js"',      `"/js/app.js?v=${BUILD_VERSION}"`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(html);
};

app.get('/', serveIndex);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/{*splat}', serveIndex);

app.use(errorHandler);

module.exports = app;
