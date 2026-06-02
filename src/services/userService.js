// Desarrollado por donangeel · 2026
const { google } = require('googleapis');
const bcrypt     = require('bcryptjs');

const USERS_SHEET  = 'MTD_Usuarios';
// Columnas: nombre | email | password | password_hash | rol | activo
const USER_HEADERS = ['nombre', 'email', 'password', 'password_hash', 'rol', 'activo'];
const USER_LAST    = 'F';

let _ensured = false;

function _auth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}
const _client = () => google.sheets({ version: 'v4', auth: _auth() });
const _sid    = () => process.env.GOOGLE_SPREADSHEET_ID;

async function _ensureSheet() {
  if (_ensured) return;
  const sheets = _client();
  const sid    = _sid();

  const meta   = await sheets.spreadsheets.get({ spreadsheetId: sid });
  const exists = meta.data.sheets.some(s => s.properties.title === USERS_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sid,
      requestBody: { requests: [{ addSheet: { properties: { title: USERS_SHEET } } }] },
    });
  }

  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: sid,
    range: `${USERS_SHEET}!A1:${USER_LAST}1`,
  });
  if (!check.data.values?.[0]?.[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid,
      range: `${USERS_SHEET}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [USER_HEADERS] },
    });
  }
  _ensured = true;
}

async function _getAll() {
  await _ensureSheet();
  const res = await _client().spreadsheets.values.get({
    spreadsheetId: _sid(),
    range: `${USERS_SHEET}!A2:${USER_LAST}`,
  });
  return (res.data.values || []).map((r, i) => ({
    _row:          i + 2,          // fila en Sheets (para updates)
    nombre:        r[0] || '',
    email:         (r[1] || '').toLowerCase().trim(),
    password:      r[2] || '',     // plain text — visible para admin en Sheets
    password_hash: r[3] || '',
    rol:           r[4] || 'reclutador',
    activo:        r[5] !== 'false',
  }));
}

async function getUserByEmail(email) {
  const all = await _getAll();
  return all.find(u => u.email === (email || '').toLowerCase().trim()) || null;
}

// Actualiza el hash en la columna D cuando admin cambió el password plain text
async function updatePasswordHash(email, newHash) {
  const all  = await _getAll();
  const user = all.find(u => u.email === (email || '').toLowerCase().trim());
  if (!user) return;
  await _client().spreadsheets.values.update({
    spreadsheetId:   _sid(),
    range:           `${USERS_SHEET}!D${user._row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[newHash]] },
  });
}

async function addUser(nombre, email, password, rol = 'reclutador') {
  await _ensureSheet();
  const hash = await bcrypt.hash(password, 10);
  await _client().spreadsheets.values.append({
    spreadsheetId:    _sid(),
    range:            `${USERS_SHEET}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[nombre, email.toLowerCase().trim(), password, hash, rol, 'true']] },
  });
}

async function seedDefaultUsers() {
  try {
    await _ensureSheet();
    const existing = await _getAll();
    const defaults = [
      { nombre: 'Administrador MTD',  email: 'admin@mtd.net.co',           password: 'Admin2026!',  rol: 'admin'      },
      { nombre: 'Juan Antolinez',     email: 'juan.antolinez@mtd.net.co',  password: 'MTD2026!',    rol: 'reclutador' },
    ];
    for (const u of defaults) {
      if (!existing.find(x => x.email === u.email)) {
        await addUser(u.nombre, u.email, u.password, u.rol);
        console.log(`  [Auth] Usuario creado: ${u.email}`);
      }
    }
  } catch (e) {
    console.warn('  [Auth] No se pudieron sembrar usuarios:', e.message);
  }
}

// Genera o actualiza el hash de todo usuario que tenga password en texto plano sin hash válido
async function syncPasswordHashes() {
  try {
    await _ensureSheet();
    const all = await _getAll();
    let synced = 0;
    for (const user of all) {
      if (!user.password) continue;
      const needsHash = !user.password_hash ||
        !(await bcrypt.compare(user.password, user.password_hash));
      if (needsHash) {
        const hash = await bcrypt.hash(user.password, 10);
        await updatePasswordHash(user.email, hash);
        synced++;
        console.log(`  [Auth] Hash generado: ${user.email}`);
      }
    }
    if (synced === 0) console.log('  [Auth] Hashes al día ✓');
  } catch (e) {
    console.warn('  [Auth] Error sincronizando hashes:', e.message);
  }
}

module.exports = { getUserByEmail, updatePasswordHash, addUser, seedDefaultUsers, syncPasswordHashes };
