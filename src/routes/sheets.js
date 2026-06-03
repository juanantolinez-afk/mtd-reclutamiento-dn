const express       = require('express');
const router        = express.Router();
const sheetsService = require('../services/sheetsService');
const bizneoService = require('../services/bizneoService');
const emailService    = require('../services/emailService');
const calendarService = require('../services/calendarService');

function userAbbrev(nombre) {
  return (nombre || 'MTD').split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 3);
}

// Obtiene user_id desde Sheets; si no existe, lo busca en Bizneo y lo guarda
async function resolveUserId(candidateId, vacancyId) {
  const saved = await sheetsService.getCandidateById(candidateId, vacancyId).catch(() => null);
  if (saved?.user_id) return saved.user_id;

  // Fallback: buscar en la lista de candidatos de Bizneo
  try {
    const candidates = await bizneoService.getAllCandidatesForJob(vacancyId);
    const match = candidates.find(c => String(c.id) === String(candidateId));
    if (match?.user_id) {
      // Guardar para próximas veces
      sheetsService.updateFields(candidateId, vacancyId, { user_id: String(match.user_id) }).catch(() => {});
      return String(match.user_id);
    }
  } catch (_) {}

  return null;
}

// GET /api/sheets/candidatos/:vacancyId
router.get('/candidatos/:vacancyId', async (req, res) => {
  try {
    const candidates = await sheetsService.getCandidatesForVacancy(req.params.vacancyId);
    res.json({ success: true, data: candidates });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// GET /api/sheets/resumen — conteo de etapas por vacante (para tarjetas)
router.get('/resumen', async (req, res) => {
  try {
    const data = await sheetsService.getVacancyStageSummary();
    res.json({ success: true, data });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// PATCH /api/sheets/candidatos/:candidateId/stage
router.patch('/candidatos/:candidateId/stage', async (req, res) => {
  const { vacancyId, stage, nombre, email, telefono, ciudad, edad, vacanteName } = req.body;
  if (!vacancyId || !stage)
    return res.status(400).json({ success: false, error: 'vacancyId y stage son requeridos' });

  try {
    const fecha_promovido = new Date().toISOString().split('T')[0];
    const abrev           = userAbbrev(req.user?.nombre);

    let ok = await sheetsService.updateFields(req.params.candidateId, vacancyId, { etapa: stage, fecha_promovido });

    if (!ok) {
      await sheetsService.upsertCandidate({
        candidato_id: req.params.candidateId, vacante_id: vacancyId,
        nombre: nombre || '', email: email || '', telefono: telefono || '',
        ciudad: ciudad || '', edad: edad || '',
        procesado_ia: 'false', etapa: stage, fecha_promovido,
        vacante_nombre: vacanteName || '',
      });
      ok = true;
    }

    // Registro cross-vacante
    sheetsService.upsertGlobalCandidate({
      candidato_id:   req.params.candidateId,
      nombre:         nombre        || '',
      email:          email         || '',
      etapa:          stage,
      vacante_id:     vacancyId,
      vacante_nombre: vacanteName   || '',
      usuario_abrev:  abrev,
      fecha:          fecha_promovido,
    }).catch(e => console.warn('[Global]', e.message));

    // Bizneo: etiqueta + nota de cambio de etapa
    let bizneoSynced = false;
    if (ok) {
      const userId = await resolveUserId(req.params.candidateId, vacancyId);
      if (userId) {
        const r = await bizneoService.setCandidateStageTag(userId, stage);
        bizneoSynced = r.ok;
        const reclutador = req.user?.nombre || 'Reclutador';
        const saved = await sheetsService.getCandidateById(req.params.candidateId, vacancyId).catch(() => null);
        const noteParts = [`🔄 Etapa: ${stage}`];
        if (saved?.calificacion_reclutador) noteParts.push(`⭐ ${saved.calificacion_reclutador}/5`);
        if (saved?.nota_reclutador?.trim()) noteParts.push(saved.nota_reclutador.trim());
        noteParts.push(reclutador);
        const noteRes = await bizneoService.addCandidateNote(userId, noteParts.join(' — '));
        if (!noteRes.ok) console.warn(`[Bizneo] nota stage falló para userId=${userId}, HTTP ${noteRes.status}`);
      }
    }

    res.json({ success: ok, bizneoSynced, usuario_abrev: abrev });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// PATCH /api/sheets/candidatos/:candidateId/rating
router.patch('/candidatos/:candidateId/rating', async (req, res) => {
  const { vacancyId, rating, nota, candidateName } = req.body;
  if (!vacancyId) return res.status(400).json({ success: false, error: 'vacancyId es requerido' });
  try {
    const ok = await sheetsService.updateFields(req.params.candidateId, vacancyId, {
      calificacion_reclutador: rating ?? '',
      nota_reclutador:         nota   ?? '',
    });

    // Nota en Bizneo siempre que haya calificación
    if (rating !== undefined && rating !== null && rating !== '') {
      const reclutador = req.user?.nombre || 'Reclutador';
      const partes     = [`⭐ ${Number(rating)}/5`];
      if (nota && String(nota).trim()) partes.push(String(nota).trim());
      partes.push(reclutador);
      const userId = await resolveUserId(req.params.candidateId, vacancyId);
      if (!userId) {
        console.warn(`[Bizneo] nota calificación: userId no resuelto para candidato ${req.params.candidateId}`);
      } else {
        const noteRes = await bizneoService.addCandidateNote(userId, partes.join(' — '));
        if (!noteRes.ok) console.warn(`[Bizneo] nota calificación falló userId=${userId}, HTTP ${noteRes.status}`);
      }
    }

    res.json({ success: ok });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// POST /api/sheets/candidatos/:candidateId/no-continua
router.post('/candidatos/:candidateId/no-continua', async (req, res) => {
  const { vacancyId, emailTo, emailBody, candidateName, vacancyTitle } = req.body;
  if (!vacancyId || !emailTo)
    return res.status(400).json({ success: false, error: 'vacancyId y emailTo son requeridos' });

  try {
    // 1. Actualizar etapa en Sheets
    const fecha = new Date().toISOString().split('T')[0];
    await sheetsService.updateFields(req.params.candidateId, vacancyId, {
      etapa: 'NO_CONTINUA', fecha_promovido: fecha,
    });

    // 2. Tag en Bizneo
    const userId = await resolveUserId(req.params.candidateId, vacancyId);
    if (userId) {
      bizneoService.setCandidateStageTag(userId, 'NO_CONTINUA')
        .catch(e => console.warn('[Bizneo] no-continua tag:', e.message));
    }

    // 3. Enviar email (best-effort: el candidato se mueve aunque el correo falle)
    let emailError = null;
    try {
      const body = emailBody || emailService.noContinuaBody({ candidateName, vacancyTitle });
      await emailService.sendMail({
        to:      emailTo,
        subject: `Tu proceso de selección en MTD — ${vacancyTitle || 'Cargo'}`,
        html:    body,
        text:    body.replace(/<[^>]+>/g, ''),
      });
    } catch (mailErr) {
      console.error('[NoContinua] email:', mailErr.message);
      emailError = mailErr.message;
    }

    res.json({ success: true, emailError });
  } catch (err) {
    console.error('[NoContinua]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/sheets/candidatos/:candidateId/entrevista — guardar fecha manualmente
router.patch('/candidatos/:candidateId/entrevista', async (req, res) => {
  const { vacancyId, fecha_entrevista } = req.body;
  if (!vacancyId) return res.status(400).json({ success: false, error: 'vacancyId requerido' });
  try {
    await sheetsService.updateFields(req.params.candidateId, vacancyId, { fecha_entrevista: fecha_entrevista || '' });
    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// POST /api/sheets/candidatos/:candidateId/entrevista/calendar — guardar fecha y devolver URL de Calendar
router.post('/candidatos/:candidateId/entrevista/calendar', async (req, res) => {
  const { vacancyId, candidateName, candidateEmail, startDateTime, endDateTime, vacancyTitle } = req.body;
  if (!vacancyId || !startDateTime)
    return res.status(400).json({ success: false, error: 'vacancyId y startDateTime son requeridos' });

  try {
    // Guardar fecha en Sheets
    const d = new Date(startDateTime);
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yy = String(d.getFullYear()).slice(-2);
    await sheetsService.updateFields(req.params.candidateId, vacancyId, { fecha_entrevista: `${dd}/${mm}/${yy}` });

    // Construir URL de Google Calendar pre-llenada (abre en el calendario del reclutador)
    const fmt = (dt) => dt.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
    const start = fmt(new Date(startDateTime));
    const end   = fmt(new Date(endDateTime || new Date(new Date(startDateTime).getTime() + 3600000)));
    const title = encodeURIComponent(`Entrevista · ${candidateName} · ${vacancyTitle || ''}`);
    const details = encodeURIComponent(`Candidato: ${candidateName}\nEmail: ${candidateEmail}`);
    const calUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${start}/${end}&details=${details}&add=${encodeURIComponent(candidateEmail || '')}`;

    res.json({ success: true, calendarUrl: calUrl });
  } catch (err) {
    console.error('[Calendar]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sheets/info
router.get('/info', async (req, res) => {
  try {
    const info = await sheetsService.getSpreadsheetInfo();
    res.json({ success: true, data: info });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;
