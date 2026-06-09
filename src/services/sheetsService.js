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

// ── Formato y hoja guía ───────────────────────────────────────────────────────

const GUIDE_SHEET = '📘 Guía';

async function setupSheetsFormatting() {
  const sheets = _client();
  const sid    = _sid();

  const meta     = await sheets.spreadsheets.get({ spreadsheetId: sid });
  const sheetMap = {};
  meta.data.sheets.forEach(s => { sheetMap[s.properties.title] = s.properties.sheetId; });

  const requests = [];

  // Crear hoja guía si no existe
  if (!sheetMap[GUIDE_SHEET]) {
    requests.push({ addSheet: { properties: { title: GUIDE_SHEET, index: 0 } } });
  }

  // Formatear encabezado de MTD_Candidatos
  const mainId = sheetMap[SHEET_NAME];
  if (mainId !== undefined) {
    // Fila 1 fija
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: mainId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
    // Encabezado azul MTD, texto blanco y negrita
    requests.push({
      repeatCell: {
        range: { sheetId: mainId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.059, green: 0.18, blue: 0.361 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    });
    // Anchos de columna legibles
    const widths = [90,80,160,180,110,90,55,55,90,160,160,55,160,120,105,90,200,60,90,90,160,160,80,90,90,60];
    widths.forEach((w, i) => {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId: mainId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: w },
          fields: 'pixelSize',
        },
      });
    });
  }

  // Formatear MTD_Candidatos_Global, MTD_Usuarios, MTD_Clasificaciones
  const sideSheets = [
    { name: GLOBAL_SHEET,  widths: [90,160,180,105,80,200,70,90] },
    { name: 'MTD_Usuarios', widths: [160,200,140,300,90,60] },
    { name: CLF_SHEET,      widths: [100,130,320,80,80,60] },
  ];

  for (const { name, widths } of sideSheets) {
    const sid2 = sheetMap[name];
    if (sid2 === undefined) continue;
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: sid2, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
    requests.push({
      repeatCell: {
        range: { sheetId: sid2, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.059, green: 0.18, blue: 0.361 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    });
    widths.forEach((w, i) => {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId: sid2, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: w },
          fields: 'pixelSize',
        },
      });
    });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: sid, requestBody: { requests } });
  }

  // Contenido de la hoja guía
  const AZUL  = { red: 0.059, green: 0.18, blue: 0.361 };
  const BLANCO = { red: 1, green: 1, blue: 1 };
  const GRIS  = { red: 0.95, green: 0.95, blue: 0.95 };

  const guideData = [
    ['MTD RECLUTAMIENTO — GUÍA DEL SISTEMA', '', ''],
    ['Sistema interno de reclutamiento · Medicina y Terapias Domiciliarias', '', ''],
    ['', '', ''],
    ['📋 MTD_Candidatos — Candidatos por vacante (hoja principal)', '', ''],
    ['COLUMNA', 'DESCRIPCIÓN', 'EJEMPLO / VALORES'],
    ['candidato_id', 'ID del candidato en Bizneo. No editar.', '82816989'],
    ['vacante_id', 'ID de la vacante en Bizneo. No editar.', '1779543'],
    ['nombre', 'Nombre completo del candidato.', 'María García'],
    ['email', 'Correo electrónico del candidato.', 'maria@email.com'],
    ['telefono', 'Teléfono de contacto.', '3001234567'],
    ['ciudad', 'Ciudad de residencia.', 'Bogotá'],
    ['edad', 'Edad calculada por IA desde el CV.', '28'],
    ['score', 'Puntaje IA de compatibilidad con la vacante (0–60). Si la vacante no tiene descripción, queda vacío.', '45'],
    ['clasificacion', 'Nivel del candidato según su score de completitud.', 'COMPLETO / REVISAR / INCOMPLETO'],
    ['formacion', 'Historial académico procesado por IA. Formato JSON — no editar.', '[{"nivel":"pregrado",...}]'],
    ['experiencia', 'Historial laboral procesado por IA. Formato JSON — no editar.', '[{"empresa":"...",...}]'],
    ['anos_exp', 'Años de experiencia total calculados por IA.', '3.5'],
    ['habilidades', 'Habilidades identificadas por IA. Formato JSON — no editar.', '["Excel","Trabajo en equipo"]'],
    ['cv_status', 'Estado del procesamiento del CV.', 'leido_ia / sin_cv / ilegible / error'],
    ['etapa', 'Etapa actual en el proceso de selección.', 'POSTULADO / PRESELECCIONADO / FINALISTA / NO_CONTINUA'],
    ['calificacion_reclutador', 'Estrellas asignadas por el reclutador (1 a 5).', '4'],
    ['nota_reclutador', 'Comentario escrito por el reclutador.', 'Buen perfil, experiencia relevante.'],
    ['procesado_ia', 'Indica si el CV fue analizado por IA. No editar.', 'true / false'],
    ['fecha_procesado', 'Fecha del último análisis IA. No editar.', '2026-06-02'],
    ['fecha_promovido', 'Fecha del último cambio de etapa.', '2026-06-02'],
    ['breakdown', 'Detalle interno del score y explicación del LLM. Formato JSON — no editar.', '{"completitud":...}'],
    ['vacante_nombre', 'Nombre de la vacante a la que aplicó el candidato.', 'Auxiliar de Enfermería Bogotá'],
    ['user_id', 'ID de usuario Bizneo para sincronizar etiquetas. No editar.', '42094434'],
    ['fecha_postulacion', 'Fecha en que aplicó en Bizneo (dd/mm/aa).', '01/06/26'],
    ['fecha_entrevista', 'Fecha de entrevista agendada (dd/mm/aa).', '05/06/26'],
    ['score_vacante', 'Puntaje de match con los requisitos específicos de la vacante (0–100). "N/A" si la vacante no tiene descripción.', '78'],
    ['', '', ''],
    ['', '', ''],
    ['👥 MTD_Candidatos_Global — Registro global por candidato', '', ''],
    ['Guarda la etapa más avanzada que ha alcanzado cada candidato en cualquier vacante.', '', ''],
    ['Sirve para detectar si un candidato ya está en proceso en otra vacante (indicador en la tabla).', '', ''],
    ['COLUMNA', 'DESCRIPCIÓN', ''],
    ['candidato_id', 'ID del candidato en Bizneo.', ''],
    ['nombre', 'Nombre completo.', ''],
    ['email', 'Correo electrónico.', ''],
    ['etapa', 'Etapa más avanzada alcanzada en cualquier vacante.', ''],
    ['vacante_id', 'ID de la vacante donde alcanzó esa etapa.', ''],
    ['vacante_nombre', 'Nombre de esa vacante.', ''],
    ['usuario_abrev', 'Iniciales del reclutador que lo promovió (ej: JUA).', ''],
    ['fecha', 'Fecha en que alcanzó esa etapa.', ''],
    ['', '', ''],
    ['', '', ''],
    ['🔐 MTD_Usuarios — Usuarios con acceso al sistema', '', ''],
    ['⚠️ Para agregar un usuario: llena nombre, email, password (texto plano) y rol. El sistema genera el hash automáticamente al iniciar sesión.', '', ''],
    ['COLUMNA', 'DESCRIPCIÓN', 'VALORES'],
    ['nombre', 'Nombre completo del reclutador.', 'Juan Antolinez'],
    ['email', 'Correo con el que inicia sesión.', 'juan@mtd.net.co'],
    ['password', 'Contraseña en texto plano. El admin puede cambiarla directamente aquí.', 'MiClave2026!'],
    ['password_hash', 'Hash de seguridad generado automáticamente. No editar.', '$2b$10$...'],
    ['rol', 'Nivel de acceso del usuario.', 'admin / reclutador'],
    ['activo', 'Define si el usuario puede iniciar sesión.', 'true / false'],
    ['', '', ''],
    ['', '', ''],
    ['⚙️ MTD_Clasificaciones — Umbrales de clasificación', '', ''],
    ['Ajusta los rangos de score para cambiar cuándo un candidato es COMPLETO, REVISAR o INCOMPLETO (escala 0–60).', '', ''],
    ['COLUMNA', 'DESCRIPCIÓN', 'VALORES'],
    ['codigo', 'Código interno. No cambiar.', 'COMPLETO'],
    ['nombre_display', 'Nombre que aparece en la app.', 'COMPLETO'],
    ['descripcion', 'Descripción del criterio de clasificación.', 'Candidato con toda la información...'],
    ['umbral_min', 'Score mínimo para esta clasificación (0–60).', '40'],
    ['umbral_max', 'Score máximo para esta clasificación (0–60).', '60'],
    ['activo', 'Si es false, no aparece en la app.', 'true / false'],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sid,
    range: `${GUIDE_SHEET}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: guideData },
  });

  // Formatear la hoja guía
  const guideMeta   = await sheets.spreadsheets.get({ spreadsheetId: sid });
  const guideSheetId = guideMeta.data.sheets.find(s => s.properties.title === GUIDE_SHEET)?.properties?.sheetId;

  if (guideSheetId !== undefined) {
    const sectionRows = [3, 33, 47, 57]; // filas de sección (0-indexed)
    const headerRows  = [4, 36, 50, 60]; // filas de encabezado de tabla
    const fmtRequests = [];

    // Título principal
    fmtRequests.push({
      repeatCell: {
        range: { sheetId: guideSheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 }, backgroundColor: AZUL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });

    // Subtítulo
    fmtRequests.push({
      repeatCell: {
        range: { sheetId: guideSheetId, startRowIndex: 1, endRowIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { italic: true }, backgroundColor: AZUL, textFormat: { foregroundColor: { red: 0.8, green: 0.9, blue: 1 } } } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });

    // Encabezados de sección (azul oscuro)
    for (const row of sectionRows) {
      fmtRequests.push({
        repeatCell: {
          range: { sheetId: guideSheetId, startRowIndex: row, endRowIndex: row + 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: AZUL,
              textFormat: { bold: true, foregroundColor: BLANCO, fontSize: 11 },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });
    }

    // Encabezados de tabla (gris)
    for (const row of headerRows) {
      fmtRequests.push({
        repeatCell: {
          range: { sheetId: guideSheetId, startRowIndex: row, endRowIndex: row + 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: GRIS,
              textFormat: { bold: true },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });
    }

    // Anchos de columna de la guía
    [[0, 220], [1, 500], [2, 280]].forEach(([i, w]) => {
      fmtRequests.push({
        updateDimensionProperties: {
          range: { sheetId: guideSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: w },
          fields: 'pixelSize',
        },
      });
    });

    // Fila 1 fija
    fmtRequests.push({
      updateSheetProperties: {
        properties: { sheetId: guideSheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });

    await sheets.spreadsheets.batchUpdate({ spreadsheetId: sid, requestBody: { requests: fmtRequests } });
  }

  console.log('  [Sheets] Formato y guía aplicados ✓');
}

function _parseFechaEntrevista(str) {
  if (!str || !str.includes('/')) return null;
  const [dd, mm, yy] = str.split('/');
  if (!dd || !mm || !yy) return null;
  const year = parseInt(yy) < 100 ? 2000 + parseInt(yy) : parseInt(yy);
  const d = new Date(year, parseInt(mm) - 1, parseInt(dd));
  return isNaN(d.getTime()) ? null : d;
}

async function getCandidatesWithUpcomingInterviews(maxDaysAhead = 2) {
  await _ensureOnce();
  const rows  = await _getAllRows();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const results = [];
  for (const row of rows) {
    const fechaStr = row[COL.fecha_entrevista];
    if (!fechaStr) continue;
    const fecha = _parseFechaEntrevista(fechaStr);
    if (!fecha) continue;
    fecha.setHours(0, 0, 0, 0);
    const diffDays = Math.round((fecha - today) / (1000 * 60 * 60 * 24));
    if (diffDays < 0 || diffDays > maxDaysAhead) continue;
    results.push({
      candidato_id:     row[COL.candidato_id],
      nombre:           row[COL.nombre],
      email:            row[COL.email],
      vacante_nombre:   row[COL.vacante_nombre],
      fecha_entrevista: fechaStr,
      diffDays,
    });
  }
  return results;
}

module.exports = {
  ensureSheet, getCandidatesForVacancy, getCandidateById, upsertCandidate, updateFields,
  getSpreadsheetInfo, getVacancyStageSummary, upsertGlobalCandidate, getAllGlobalCandidates,
  getClasificaciones, ensureClasificacionesSheet, setupSheetsFormatting,
  getCandidatesWithUpcomingInterviews,
};
