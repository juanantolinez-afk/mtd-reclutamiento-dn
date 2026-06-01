const { google } = require('googleapis');

const SHEET_NAME = 'MTD_Candidatos';

// Columnas A-Z (26 columnas)
const HEADERS = [
  'candidato_id', 'vacante_id', 'nombre', 'email', 'telefono', 'ciudad', 'edad',
  'score', 'clasificacion', 'formacion', 'experiencia', 'anos_exp', 'habilidades',
  'cv_status', 'etapa', 'calificacion_reclutador', 'nota_reclutador',
  'procesado_ia', 'fecha_procesado', 'fecha_promovido', 'breakdown',
  'vacante_nombre', 'user_id', 'fecha_postulacion', 'fecha_entrevista', 'score_vacante',
];

const COL = {};
HEADERS.forEach((h, i) => { COL[h] = i; });

const LAST_COL = 'Z';

let _ensured = false;

function _getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function _client() {
  return google.sheets({ version: 'v4', auth: _getAuth() });
}

function _sid() {
  return process.env.GOOGLE_SPREADSHEET_ID;
}

async function ensureSheet() {
  if (_ensured) return;
  const sheets = _client();
  const spreadsheetId = _sid();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === SHEET_NAME);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
    });
  }

  const check = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A1:${LAST_COL}1`,
  });

  const existingHeaders = check.data.values?.[0] || [];
  if (existingHeaders.length < HEADERS.length || existingHeaders[0] !== HEADERS[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }

  _ensured = true;
}

async function _ensureOnce() {
  if (!_ensured) await ensureSheet();
}

async function _getAllRows() {
  const sheets = _client();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: _sid(),
    range: `${SHEET_NAME}!A2:${LAST_COL}`,
  });
  return res.data.values || [];
}

function _rowToObj(row) {
  const obj = {};
  HEADERS.forEach((h, i) => { obj[h] = row[i] ?? ''; });
  return obj;
}

async function getCandidatesForVacancy(vacancyId) {
  await _ensureOnce();
  const rows = await _getAllRows();
  return rows
    .filter(row => row[COL.vacante_id] === String(vacancyId))
    .map(_rowToObj);
}

async function getCandidateById(candidatoId, vacanteId) {
  await _ensureOnce();
  const rows = await _getAllRows();
  const row  = rows.find(r =>
    r[COL.candidato_id] === String(candidatoId) &&
    r[COL.vacante_id]   === String(vacanteId)
  );
  return row ? _rowToObj(row) : null;
}

async function upsertCandidate(data) {
  await _ensureOnce();
  const sheets = _client();
  const spreadsheetId = _sid();
  const rows = await _getAllRows();

  const idx = rows.findIndex(r =>
    r[COL.candidato_id] === String(data.candidato_id) &&
    r[COL.vacante_id]   === String(data.vacante_id)
  );

  const row = HEADERS.map(h => {
    const v = data[h];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });

  if (idx === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range:            `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody:      { values: [row] },
    });
  } else {
    const sheetRow = idx + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range:            `${SHEET_NAME}!A${sheetRow}:${LAST_COL}${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody:      { values: [row] },
    });
  }
}

async function updateFields(candidatoId, vacanteId, updates) {
  await _ensureOnce();
  const sheets = _client();
  const spreadsheetId = _sid();
  const rows = await _getAllRows();

  const idx = rows.findIndex(r =>
    r[COL.candidato_id] === String(candidatoId) &&
    r[COL.vacante_id]   === String(vacanteId)
  );
  if (idx === -1) return false;

  const sheetRow = idx + 2;
  const current  = [...rows[idx]];
  while (current.length < HEADERS.length) current.push('');

  for (const [field, value] of Object.entries(updates)) {
    const colIdx = COL[field];
    if (colIdx !== undefined) current[colIdx] = (value == null) ? '' : String(value);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range:            `${SHEET_NAME}!A${sheetRow}:${LAST_COL}${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody:      { values: [current] },
  });

  return true;
}

async function getSpreadsheetInfo() {
  const sheets = _client();
  const res = await sheets.spreadsheets.get({ spreadsheetId: _sid() });
  return {
    title:  res.data.properties.title,
    sheets: res.data.sheets.map(s => s.properties.title),
  };
}

// ── Resumen de etapas por vacante (para tarjetas) ─────────────────────────────

async function getVacancyStageSummary() {
  await _ensureOnce();
  const rows = await _getAllRows();
  const summary = {};
  for (const row of rows) {
    const vid = row[COL.vacante_id];
    if (!vid) continue;
    if (!summary[vid]) summary[vid] = { procesados: 0, preseleccionados: 0, finalistas: 0 };
    summary[vid].procesados++;
    const etapa = (row[COL.etapa] || '').toUpperCase();
    if (etapa === 'PRESELECCIONADO') summary[vid].preseleccionados++;
    if (etapa === 'FINALISTA')       summary[vid].finalistas++;
  }
  return summary;
}

// ── Candidatos globales (cross-vacante) ───────────────────────────────────────

const GLOBAL_SHEET   = 'MTD_Candidatos_Global';
const GLOBAL_HEADERS = ['candidato_id', 'nombre', 'email', 'etapa', 'vacante_id', 'vacante_nombre', 'usuario_abrev', 'fecha'];
const GLOBAL_COL     = {};
GLOBAL_HEADERS.forEach((h, i) => { GLOBAL_COL[h] = i; });
const GLOBAL_LAST    = String.fromCharCode(64 + GLOBAL_HEADERS.length); // 'H'
let _globalEnsured   = false;

async function _ensureGlobalSheet() {
  if (_globalEnsured) return;
  const sheets = _client(), sid = _sid();
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: sid });
  if (!meta.data.sheets.some(s => s.properties.title === GLOBAL_SHEET)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sid,
      requestBody: { requests: [{ addSheet: { properties: { title: GLOBAL_SHEET } } }] },
    });
  }
  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: sid,
    range: `${GLOBAL_SHEET}!A1:${GLOBAL_LAST}1`,
  });
  if (!check.data.values?.[0]?.[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid, range: `${GLOBAL_SHEET}!A1`,
      valueInputOption: 'RAW', requestBody: { values: [GLOBAL_HEADERS] },
    });
  }
  _globalEnsured = true;
}

async function upsertGlobalCandidate(data) {
  await _ensureGlobalSheet();
  const sheets = _client(), sid = _sid();
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `${GLOBAL_SHEET}!A2:${GLOBAL_LAST}` });
  const rows = res.data.values || [];
  const idx  = rows.findIndex(r => r[GLOBAL_COL.candidato_id] === String(data.candidato_id));
  const RANK = { PRESELECCIONADO: 1, FINALISTA: 2 };
  if (idx !== -1 && (RANK[rows[idx][GLOBAL_COL.etapa]] || 0) >= (RANK[data.etapa] || 0)) return;
  const row = GLOBAL_HEADERS.map(h => String(data[h] || ''));
  if (idx === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sid, range: `${GLOBAL_SHEET}!A1`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid, range: `${GLOBAL_SHEET}!A${idx + 2}:${GLOBAL_LAST}${idx + 2}`,
      valueInputOption: 'RAW', requestBody: { values: [row] },
    });
  }
}

async function getAllGlobalCandidates() {
  await _ensureGlobalSheet();
  const res  = await _client().spreadsheets.values.get({ spreadsheetId: _sid(), range: `${GLOBAL_SHEET}!A2:${GLOBAL_LAST}` });
  const map  = new Map();
  for (const row of (res.data.values || [])) {
    const cid = String(row[GLOBAL_COL.candidato_id] || '');
    if (cid) map.set(cid, {
      etapa:          row[GLOBAL_COL.etapa]          || '',
      vacante_id:     row[GLOBAL_COL.vacante_id]     || '',
      vacante_nombre: row[GLOBAL_COL.vacante_nombre] || '',
      usuario_abrev:  row[GLOBAL_COL.usuario_abrev]  || '',
      fecha:          row[GLOBAL_COL.fecha]           || '',
    });
  }
  return map;
}

// ── Clasificaciones configurables ─────────────────────────────────────────────

const CLF_SHEET   = 'MTD_Clasificaciones';
const CLF_HEADERS = ['codigo', 'nombre_display', 'descripcion', 'umbral_min', 'umbral_max', 'activo'];
const CLF_LAST    = 'F';
let _clfEnsured   = false;

const CLF_DEFAULTS = [
  ['COMPLETO',   'COMPLETO',   'Candidato con toda la información procesada y score alto',  '40', '60',  'true'],
  ['REVISAR',    'REVISAR',    'Candidato con información parcial o score medio',             '22', '39',  'true'],
  ['INCOMPLETO', 'INCOMPLETO', 'Candidato sin información suficiente o score bajo',          '0',  '21',  'true'],
];

async function ensureClasificacionesSheet() {
  if (_clfEnsured) return;
  const sheets = _client(), sid = _sid();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sid });
  if (!meta.data.sheets.some(s => s.properties.title === CLF_SHEET)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sid,
      requestBody: { requests: [{ addSheet: { properties: { title: CLF_SHEET } } }] },
    });
  }
  const check = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `${CLF_SHEET}!A1:F1` });
  if (!check.data.values?.[0]?.[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid, range: `${CLF_SHEET}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [CLF_HEADERS, ...CLF_DEFAULTS] },
    });
  }
  _clfEnsured = true;
}

async function getClasificaciones() {
  await ensureClasificacionesSheet();
  const res = await _client().spreadsheets.values.get({ spreadsheetId: _sid(), range: `${CLF_SHEET}!A2:F` });
  return (res.data.values || [])
    .filter(r => r[5] !== 'false')
    .map(r => ({
      codigo:        r[0] || '',
      nombre_display: r[1] || r[0] || '',
      descripcion:   r[2] || '',
      umbral_min:    parseInt(r[3]) || 0,
      umbral_max:    parseInt(r[4]) || 60,
    }));
}

module.exports = {
  ensureSheet, getCandidatesForVacancy, getCandidateById, upsertCandidate, updateFields,
  getSpreadsheetInfo, getVacancyStageSummary, upsertGlobalCandidate, getAllGlobalCandidates,
  getClasificaciones, ensureClasificacionesSheet,
};
