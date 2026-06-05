const express        = require('express');
const router         = express.Router();
const bizneoService  = require('../services/bizneoService');
const cvParser       = require('../services/cvParserService');
const scoringService = require('../services/scoringService');
const { scoreMatchWithVacancy, stripHtml } = require('../services/cvParserService');
const cache          = require('../utils/cache');
const sheetsService  = require('../services/sheetsService');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function toBizneoSlug(firstName, lastName) {
  return `${firstName || ''} ${lastName || ''}`
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // quitar tildes y diacríticos
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function calcAge(birthDate) {
  if (!birthDate) return null;
  const today = new Date();
  const birth = new Date(birthDate);
  if (isNaN(birth.getTime())) return null;
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return (age > 0 && age < 100) ? age : null;
}

function labelToBg(label) {
  if (label === 'COMPLETO')   return '#22543D';
  if (label === 'REVISAR')    return '#744210';
  if (label === 'INCOMPLETO') return '#742A2A';
  // Legacy labels stored in Sheets
  if (label === 'APTO')       return '#22543D';
  if (label === 'REVISIÓN')   return '#744210';
  if (label === 'NO APTO')    return '#742A2A';
  return '#2D3748';
}

function normalizeClfLabel(raw) {
  if (!raw) return 'INCOMPLETO';
  const map = { 'APTO': 'COMPLETO', 'REVISIÓN': 'REVISAR', 'NO APTO': 'INCOMPLETO', 'FALTA DE INFORMACIÓN': 'INCOMPLETO' };
  return map[raw] || raw;
}

function reconstructFromSaved(i, saved, raw, jobId) {
  const slug = raw?.slug || toBizneoSlug(
    saved.nombre?.split(' ')[0]             || '',
    saved.nombre?.split(' ').slice(1).join(' ') || ''
  );

  let education = [], experience = [], skills = [], breakdown = {};
  try { education  = JSON.parse(saved.formacion  || '[]'); } catch (_) {}
  try { experience = JSON.parse(saved.experiencia || '[]'); } catch (_) {}
  try { skills     = JSON.parse(saved.habilidades || '[]'); } catch (_) {}
  try { const bd = JSON.parse(saved.breakdown || '{}'); breakdown = bd; } catch (_) {}

  const totalMonths = Math.round(parseFloat(saved.anos_exp || 0) * 12);
  const clfLabel    = normalizeClfLabel(saved.clasificacion);

  return {
    type:                    'candidate',
    index:                   i + 1,
    id:                      saved.candidato_id,
    name:                    saved.nombre,
    email:                   saved.email,
    phone:                   saved.telefono || '',
    city:                    saved.ciudad,
    cv_status:               saved.cv_status,
    education,
    experience,
    skills,
    total_experience_months: totalMonths,
    years_experience:        parseFloat(saved.anos_exp) || 0,
    bizneo_url:              bizneoUrl(jobId, saved.candidato_id),
    avatar_url:              raw?.avatar_url || '',
    score:                   saved.score === 'N/A' ? null : (parseInt(saved.score) || 0),
    score_vacante:           saved.score_vacante || '',
    vacancy_na:              saved.score_vacante === 'N/A',
    explicacion:             breakdown.explicacion || '',
    breakdown,
    classification:          { label: clfLabel, bg: labelToBg(clfLabel) },
    etapa:                   saved.etapa || 'POSTULADO',
    calificacion_reclutador: saved.calificacion_reclutador || '',
    nota_reclutador:         saved.nota_reclutador || '',
    edad:                    saved.edad || '',
    fecha_postulacion:       saved.fecha_postulacion || (raw?.created_at ? fmtDate(raw.created_at) : ''),
    fecha_entrevista:        saved.fecha_entrevista || '',
    _from_sheets:            true,
  };
}

const VACANCIES_KEY  = 'bizneo:vacancies';
const CANDIDATES_TTL = 5 * 60 * 1000;
const COMPANY_ID     = process.env.BIZNEO_COMPANY_ID || '171780';

// URL directa al perfil del candidato usando IDs (más confiable que slug)
function bizneoUrl(jobId, candidateId) {
  return `https://ats.bizneo.com/companies/${COMPANY_ID}/jobs/${jobId}/candidates/${candidateId}`;
}

function slimVacancy(v) {
  return {
    id:                        v.id,
    title:                     v.title,
    friendly_title:            v.friendly_title,
    status:                    v.status,
    created_at:                v.created_at,
    department:                v.department,
    department_translation:    v.department_translation,
    contract_type_translation: v.contract_type_translation,
    location:                  v.locations?.[0]?.city?.name || null,
  };
}

// GET /api/vacancies
router.get('/', async (req, res) => {
  try {
    const bust = req.query.refresh === '1';
    if (bust) cache.del(VACANCIES_KEY);

    let data = cache.get(VACANCIES_KEY);
    const fromCache = !!data;

    if (!data) {
      const raw = await bizneoService.getActiveVacancies();
      data = { jobs: raw.jobs.map(slimVacancy), total: raw.total };
      cache.set(VACANCIES_KEY, data);
    }

    res.json({ success: true, data, fromCache });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// GET /api/vacancies/:id/candidates — lista rápida sin scores
router.get('/:id/candidates', async (req, res) => {
  const key = `bizneo:candidates:${req.params.id}`;
  try {
    let candidates = cache.get(key);
    const fromCache = !!candidates;

    if (!candidates) {
      candidates = await bizneoService.getAllCandidatesForJob(req.params.id);
      cache.set(key, candidates, CANDIDATES_TTL);
    }

    res.json({ success: true, data: candidates, total: candidates.length, fromCache });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// GET /api/vacancies/:id/procesar — SSE: descarga CV, parsea con IA, calcula score
router.get('/:id/procesar', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const forceReprocess = req.query.force === '1';

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  // Heartbeat cada 20s para que el proxy de Bonto no cierre la conexión por inactividad
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    }
  }, 20000);

  try {
    const key = `bizneo:candidates:${req.params.id}`;
    if (forceReprocess) cache.del(key);
    let candidates = cache.get(key);
    if (!candidates) {
      candidates = await bizneoService.getAllCandidatesForJob(req.params.id);
      cache.set(key, candidates, CANDIDATES_TTL);
    }

    const filtered = candidates.filter(c =>
      !String(c.source_portal || '').toLowerCase().includes('mtd')
    );

    // Nombre de la vacante (para columna vacante_nombre en Sheets)
    const vacancyCache = cache.get('bizneo:vacancies');
    const vacancyName = vacancyCache?.jobs?.find(j => String(j.id) === String(req.params.id))?.friendly_title || '';

    // Cargar candidatos ya procesados desde Sheets + candidatos globales
    const savedMap  = new Map();
    const globalMap = new Map();
    try {
      const [saved, global] = await Promise.all([
        sheetsService.getCandidatesForVacancy(req.params.id),
        sheetsService.getAllGlobalCandidates(),
      ]);
      saved.forEach(c => savedMap.set(String(c.candidato_id), c));
      global.forEach((v, k) => globalMap.set(k, v));
    } catch (e) {
      console.warn('[Sheets] No se pudo leer caché:', e.message);
    }

    send({ type: 'total', total: filtered.length, skipped: candidates.length - filtered.length });

    // Obtener descripción de la vacante para scoring basado en requisitos
    let vacancyDescription = '';
    try {
      const jobDetails = await bizneoService.getJobDetails(req.params.id);
      vacancyDescription = stripHtml(jobDetails?.description || '');
    } catch (_) {}
    const hasVacancyDesc = vacancyDescription.length > 80;

    const CONCURRENCY = 2;
    const BATCH_PAUSE = 5000;

    for (let batchStart = 0; batchStart < filtered.length; batchStart += CONCURRENCY) {
      const batch = filtered.slice(batchStart, batchStart + CONCURRENCY);

      // Solo pausar si alguno del batch requiere IA (o si es force)
      const batchNeedsAI = forceReprocess || batch.some(c => savedMap.get(String(c.id))?.procesado_ia !== 'true');
      if (batchStart > 0 && batchNeedsAI) await sleep(BATCH_PAUSE);

      await Promise.all(batch.map(async (c, batchIdx) => {
        const i    = batchStart + batchIdx;
        const meta = c.professional_metadata || {};
        const loc  = c.location || {};
        const user = c.user_metadata || {};

        // Si ya está en Sheets, verificar si el estado de Bizneo cambió a terminal
        const savedData = savedMap.get(String(c.id));
        if (savedData?.procesado_ia === 'true' && !forceReprocess) {
          // Comprobar estado actual de Bizneo aunque esté en caché
          const bizPhaseNow = (c.phase?.name || c.pipeline_phase?.name || c.current_phase?.name ||
                               c.phase_name || c.current_phase_name || c.state_name || '').trim();
          const TERMINAL = ['contrataci', 'hired', 'oferta', 'offer', 'descartad', 'discard', 'rechazad', 'reject'];
          const isTerminalNow = bizPhaseNow && TERMINAL.some(t => bizPhaseNow.toLowerCase().includes(t));
          if (isTerminalNow && !savedData.cv_status?.startsWith('sin_procesar:')) {
            const newStatus = `sin_procesar: estado "${bizPhaseNow}"`;
            const rebuilt = { ...reconstructFromSaved(i, savedData, c, req.params.id), cv_status: newStatus };
            send(rebuilt);
            sheetsService.updateFields(String(c.id), req.params.id, { cv_status: newStatus })
              .catch(() => {});
            return;
          }
          send(reconstructFromSaved(i, savedData, c, req.params.id));
          return;
        }

        // Detectar estado de Bizneo (fase/pipeline) que impide procesamiento
        const bizPhase = (c.phase?.name || c.pipeline_phase?.name || c.current_phase?.name ||
                          c.phase_name || c.current_phase_name || c.state_name || '').trim();
        const TERMINAL = ['contrataci', 'hired', 'oferta', 'offer', 'descartad', 'discard', 'rechazad', 'reject'];
        const isTerminal = bizPhase && TERMINAL.some(t => bizPhase.toLowerCase().includes(t));

        // Procesar con IA
        const cvAsset = (meta.assets || []).find(a =>
          (a.type || '').toLowerCase().includes('curriculum') ||
          (a.file_file_name || '').match(/\.(pdf|doc|docx)$/i)
        );

        let llmData  = null;
        let cvStatus = 'sin_cv';

        if (isTerminal) {
          cvStatus = `sin_procesar: estado "${bizPhase}"`;
        } else if (cvAsset?.url) {
          try {
            send({ type: 'progress', index: i + 1, step: 'Leyendo CV...' });
            const cvData = await cvParser.downloadAndExtractCV(cvAsset.url);

            send({ type: 'progress', index: i + 1, step: 'Analizando con IA...' });
            llmData = await cvParser.parseCVWithLLM(cvData);

            if (llmData?._unreadable) {
              cvStatus = `ilegible: ${llmData._reason || 'PDF escaneado'}`;
              llmData  = null;
            } else if (llmData?._via_llm) {
              send({ type: 'progress', index: i + 1, step: 'Analizado con IA ✓' });
              cvStatus = 'leido_ia';
            } else if (llmData?._via_heuristic) {
              cvStatus = 'leido_heuristico';
            } else if (llmData?._llm_error) {
              cvStatus = `error: ${(llmData._reason || 'error IA').slice(0, 60)}`;
              llmData  = null;
            } else {
              cvStatus = 'sin_procesar: sin texto suficiente';
              llmData  = null;
            }
          } catch (e) {
            cvStatus = `error: ${e.message.slice(0, 60)}`;
            llmData  = null;
          }
        }

        const completeness  = scoringService.calculateScore(c, llmData);
        const totalMonths   = llmData?.total_experience_months || 0;
        const yearsExp      = totalMonths > 0 ? Math.round(totalMonths / 12 * 10) / 10 : 0;

        // Score por vacante: si hay descripción usamos LLM; si no, N/A
        let vacancyMatch = null;
        if (hasVacancyDesc && llmData && !llmData._unreadable) {
          vacancyMatch = await scoreMatchWithVacancy(llmData, vacancyDescription).catch(() => null);
        }
        // score final: vacancy match normalizado a 60, o 'N/A', o completeness como fallback
        const score = {
          total:          vacancyMatch
                            ? Math.round(vacancyMatch.score * 60 / 100)
                            : hasVacancyDesc ? null : completeness.total,
          breakdown:      completeness.breakdown,
          explicacion:    vacancyMatch?.explicacion || '',
          classification: completeness.classification,
          vacancy_na:     hasVacancyDesc && !vacancyMatch,
          vacancy_match:  vacancyMatch,
        };
        const candidateSlug = c.slug || toBizneoSlug(c.first_name, c.last_name);
        // Edad: primero Bizneo, luego fecha extraída por IA, luego edad directa del CV
        const edad = calcAge(user.birth_date)
                  || (llmData?.birth_date ? calcAge(llmData.birth_date) : null)
                  || llmData?.age
                  || null;
        const cityStr       = loc.city || loc.province || llmData?.city || '';

        const fechaPost = fmtDate(c.created_at);

        const payload = {
          type:                    'candidate',
          index:                   i + 1,
          id:                      c.id,
          name:                    `${c.first_name || ''} ${c.last_name || ''}`.trim(),
          email:                   c.email || '',
          phone:                   meta.phone || '',
          city:                    cityStr,
          cv_status:               cvStatus,
          cv_file:                 cvAsset?.file_file_name || null,
          education:               llmData?.education  || [],
          experience:              llmData?.experience || [],
          skills:                  llmData?.skills     || [],
          total_experience_months: totalMonths,
          years_experience:        yearsExp,
          bizneo_url:              bizneoUrl(req.params.id, c.id),
          avatar_url:              c.avatar_url || '',
          score:                   score.total,
          score_vacante:           score.vacancy_na ? 'N/A' : (score.vacancy_match ? Math.round(score.vacancy_match.score) : ''),
          vacancy_na:              score.vacancy_na || false,
          vacancy_na_reason:       score.vacancy_na ? 'La vacante no tiene descripción o requisitos suficientes para calcular el puntaje.' : '',
          explicacion:             score.explicacion,
          breakdown:               score.breakdown,
          classification:          score.classification,
          etapa:                   savedData?.etapa || 'POSTULADO',
          calificacion_reclutador: savedData?.calificacion_reclutador || '',
          nota_reclutador:         savedData?.nota_reclutador || '',
          edad:                    edad ?? '',
          fecha_postulacion:       fechaPost,
          fecha_entrevista:        savedData?.fecha_entrevista || '',
          global_etapa:   globalMap.get(String(c.id))?.etapa          || null,
          global_vacante: globalMap.get(String(c.id))?.vacante_nombre || null,
          global_abrev:   globalMap.get(String(c.id))?.usuario_abrev  || null,
        };

        send(payload);

        // Guardar en Sheets de forma asíncrona (no bloquea SSE)
        sheetsService.upsertCandidate({
          candidato_id:            c.id,
          vacante_id:              req.params.id,
          user_id:                 c.user_id || '',
          fecha_postulacion:       fechaPost,
          score_vacante:           payload.score_vacante,
          breakdown:               JSON.stringify({ ...score.breakdown, explicacion: score.explicacion }),
          nombre:                  payload.name,
          email:                   payload.email,
          telefono:                payload.phone,
          ciudad:                  cityStr,
          edad:                    edad ?? '',
          score:                   score.total,
          clasificacion:           score.classification.label,
          formacion:               JSON.stringify(llmData?.education  || []),
          experiencia:             JSON.stringify(llmData?.experience || []),
          anos_exp:                yearsExp,
          habilidades:             JSON.stringify(llmData?.skills     || []),
          cv_status:               cvStatus,
          etapa:                   savedData?.etapa || 'POSTULADO',
          calificacion_reclutador: savedData?.calificacion_reclutador || '',
          nota_reclutador:         savedData?.nota_reclutador || '',
          procesado_ia:            'true',
          fecha_procesado:         new Date().toISOString().split('T')[0],
          fecha_promovido:         savedData?.fecha_promovido || '',
          vacante_nombre:          vacancyName,
        }).catch(e => console.warn('[Sheets] Error guardando candidato:', e.message));
      }));
    }

    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    clearInterval(heartbeat);
  }

  res.end();
});

module.exports = router;
