/* ============================================================
   MTD Reclutamiento — Frontend
   Desarrollado por donangeel · 2026
   ============================================================ */

const API = '/api';

// Clasificaciones cargadas desde Sheets (reemplaza nombres en badges)
let _clfConfig = {}; // { 'COMPLETO': { nombre_display: 'COMPLETO', ... }, ... }

async function loadClasificaciones() {
  try {
    const res  = await fetch('/api/config/clasificaciones');
    const json = await res.json();
    if (json.success) {
      _clfConfig = {};
      (json.data || []).forEach(c => { _clfConfig[c.codigo] = c; });
    }
  } catch {}
}

function getClfDisplayName(codigo) {
  const normalized = normalizeClfLabel(codigo) || codigo;
  return _clfConfig[normalized]?.nombre_display || codigo;
}

// Interceptor global: redirige a /login en cualquier 401
const _origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  if (res.status === 401) {
    const url = typeof args[0] === 'string' ? args[0] : '';
    if (!url.includes('/api/auth/')) { window.location.href = '/login'; }
  }
  return res;
};

// ─── Helpers de fecha ────────────────────────────────────────────────────────
function formatDateCompact(dateStr) {
  if (!dateStr) return '—';
  // Soporta 'dd/mm/yy', 'dd/mm/yyyy', ISO
  const parts = dateStr.split('/');
  if (parts.length === 3) return `${parts[0]}/${parts[1]}/${parts[2].slice(-2)}`;
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('es-CO', { day:'2-digit', month:'2-digit', year:'2-digit' });
  } catch { return dateStr; }
}

function calendarLink(candidateName, candidateEmail, vacancyTitle) {
  const title   = encodeURIComponent(`Entrevista · ${candidateName} · ${vacancyTitle || ''}`);
  const details = encodeURIComponent(`Entrevista de selección para ${vacancyTitle || 'la vacante'}.\nCandidato: ${candidateName}`);
  const add     = encodeURIComponent(candidateEmail || '');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&details=${details}&add=${add}`;
}

// Estado global
let allVacancies       = [];
let currentVacancy     = null;
let activeSSE          = null;
let allCandidatesState = [];
let currentTab         = 'postulados';
let processFilter      = 'all';
let currentUserRole    = 'reclutador';
const _rateTimers      = {};

// Mapas de niveles educativos (usados en varias funciones de render)
const LEVEL_LABEL = {
  doctorado:'Doctorado', maestria:'Maestría', especializacion:'Esp.',
  pregrado:'Pregrado', tecnologo:'Tecnólogo', tecnico:'Técnico',
  auxiliar:'Auxiliar', bachiller:'Bachiller', curso:'Curso',
};
const LEVEL_COLOR = {
  doctorado:'#6d28d9', maestria:'#7c3aed', especializacion:'#4f46e5',
  pregrado:'#0369a1', tecnologo:'#0891b2', tecnico:'#0284c7',
  auxiliar:'#64748b', bachiller:'#475569', curso:'#6b7280',
};
const LEVEL_ORDER = {
  doctorado:8, maestria:7, especializacion:6, pregrado:5,
  tecnologo:4, tecnico:3, auxiliar:2, bachiller:1, curso:0,
};

// ============================================================
// Navegación
// ============================================================
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
  });
});

// ============================================================
// Toast
// ============================================================
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// ============================================================
// Helpers de score y clasificación (dark-mode friendly)
// ============================================================
function scoreColor(score) {
  if (score >= 40) return 'var(--score-high)';
  if (score >= 22) return 'var(--score-mid)';
  return 'var(--score-low)';
}

const CLF_STYLE = {
  // Etiquetas actuales
  'COMPLETO':             { bg: 'rgba(74,222,128,0.12)',  color: '#4ade80', border: 'rgba(74,222,128,0.25)' },
  'REVISAR':              { bg: 'rgba(251,191,36,0.12)',  color: '#fbbf24', border: 'rgba(251,191,36,0.25)' },
  'INCOMPLETO':           { bg: 'rgba(248,113,113,0.12)', color: '#f87171', border: 'rgba(248,113,113,0.25)' },
  // Legacy (datos anteriores en Sheets)
  'APTO':                 { bg: 'rgba(74,222,128,0.12)',  color: '#4ade80', border: 'rgba(74,222,128,0.25)' },
  'REVISIÓN':             { bg: 'rgba(251,191,36,0.12)',  color: '#fbbf24', border: 'rgba(251,191,36,0.25)' },
  'NO APTO':              { bg: 'rgba(248,113,113,0.12)', color: '#f87171', border: 'rgba(248,113,113,0.25)' },
  'FALTA DE INFORMACIÓN': { bg: 'rgba(148,163,184,0.10)', color: '#94a3b8', border: 'rgba(148,163,184,0.22)' },
};

function classificationBadge(clf) {
  if (!clf) return '';
  const normalized = normalizeClfLabel(clf.label) || clf.label;
  const displayName = getClfDisplayName(normalized);
  let cls;
  if      (normalized === 'COMPLETO')  cls = 'badge-clf-completo';
  else if (normalized === 'REVISAR')   cls = 'badge-clf-revisar';
  else                                 cls = 'badge-clf-incompleto';
  return `<span class="badge-clf ${cls}">${escapeHtml(displayName)}</span>`;
}

function normalizeClfLabel(raw) {
  if (!raw) return null;
  const map = { 'APTO': 'COMPLETO', 'REVISIÓN': 'REVISAR', 'NO APTO': 'INCOMPLETO', 'FALTA DE INFORMACIÓN': 'INCOMPLETO' };
  return map[raw] || raw;
}

function labelToBg(label) {
  return (CLF_STYLE[label] || CLF_STYLE['INCOMPLETO']).bg;
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

function toBizneoSlug(firstName, lastName) {
  return `${firstName || ''} ${lastName || ''}`
    .trim().toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-').replace(/-+/g, '-');
}

// ============================================================
// Vacantes — carga
// ============================================================
document.getElementById('btn-refresh-vacancies').addEventListener('click', () => loadVacancies(true));

async function loadVacancies(forceRefresh = false) {
  const grid        = document.getElementById('vacancies-grid');
  const loading     = document.getElementById('vacancies-loading');
  const loadingText = document.getElementById('vacancies-loading-text');
  const filterBar   = document.getElementById('filter-bar');
  const cacheBadge  = document.getElementById('cache-badge');

  grid.innerHTML = '';
  filterBar.classList.add('hidden');
  cacheBadge.classList.add('hidden');
  loading.classList.remove('hidden');
  loadingText.textContent = forceRefresh ? 'Actualizando desde Bizneo...' : 'Cargando vacantes...';

  try {
    const url  = forceRefresh ? `${API}/vacancies?refresh=1` : `${API}/vacancies`;
    const res  = await fetch(url);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    allVacancies = json.data?.jobs || [];
    loading.classList.add('hidden');
    if (json.fromCache) cacheBadge.classList.remove('hidden');
    populateDeptFilter(allVacancies);
    filterBar.classList.remove('hidden');
    applyFilters();
    loadVacancyStageSummary();
  } catch (err) {
    loading.classList.add('hidden');
    grid.innerHTML = `<div style="color:var(--danger);padding:20px;">Error: ${err.message}</div>`;
    showToast(`Error al cargar vacantes: ${err.message}`, 'error');
  }
}

// ============================================================
// Filtros de vacantes
// ============================================================
document.getElementById('vacancy-search').addEventListener('input', applyFilters);
document.getElementById('filter-status').addEventListener('change', applyFilters);
document.getElementById('filter-dept').addEventListener('change', applyFilters);

function populateDeptFilter(vacancies) {
  const select  = document.getElementById('filter-dept');
  const depts   = [...new Set(vacancies.map(v => v.department_translation || v.department).filter(Boolean))].sort();
  const current = select.value;
  select.innerHTML = '<option value="">Todos los departamentos</option>';
  depts.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d; opt.textContent = d;
    if (d === current) opt.selected = true;
    select.appendChild(opt);
  });
}

function applyFilters() {
  const q      = document.getElementById('vacancy-search').value.trim().toLowerCase();
  const status = document.getElementById('filter-status').value;
  const dept   = document.getElementById('filter-dept').value;
  const ACTIVE = ['activated', 'activa', 'active'];
  const filtered = allVacancies.filter(v => {
    const vst = (v.status || '').toLowerCase();
    if (status === 'activated' && !ACTIVE.includes(vst)) return false;
    if (status === 'closed'    &&  ACTIVE.includes(vst)) return false;
    if (dept && (v.department_translation || v.department) !== dept) return false;
    if (q && !(v.friendly_title || v.title || '').toLowerCase().includes(q)) return false;
    return true;
  });
  renderVacancyGrid(filtered);
}

function renderVacancyGrid(vacancies) {
  const grid  = document.getElementById('vacancies-grid');
  const count = document.getElementById('search-count');
  count.textContent = `${vacancies.length} de ${allVacancies.length} vacantes`;
  if (vacancies.length === 0) {
    grid.innerHTML = '<p style="color:var(--mtd-muted);padding:16px;">Sin resultados.</p>';
    return;
  }
  grid.innerHTML = vacancies.map((v) => {
    const isActive = ['activated','activa','active'].includes((v.status || '').toLowerCase());
    const title = escapeHtml(v.friendly_title || v.title || 'Sin título');
    const dept  = escapeHtml(v.department_translation || v.department || '—');
    const loc   = escapeHtml(v.location || v.city || 'Colombia');
    const date  = v.created_at ? new Date(v.created_at).toLocaleDateString('es-CO') : '';
    return `<div class="vacancy-card" data-id="${v.id}" data-title="${title}">
      <div class="vacancy-title">${title}</div>
      <div class="vacancy-meta"><span>${loc}</span><span>${dept}</span><span>${date}</span></div>
      <div class="vacancy-badges">
        <span class="badge ${isActive ? 'badge-green' : 'badge-gray'}">${isActive ? 'Activa' : escapeHtml(v.status || 'Cerrada')}</span>
        ${v.applications_count != null ? `<span class="badge badge-blue">${v.applications_count} candidatos</span>` : ''}
        ${v.contract_type_translation ? `<span class="badge badge-gray">${escapeHtml(v.contract_type_translation)}</span>` : ''}
      </div>
      <div class="vacancy-stages" id="vstages-${v.id}"></div>
      <div class="vacancy-actions">
        <button class="btn btn-primary btn-sm js-ver-candidatos">Ver candidatos</button>
      </div>
    </div>`;
  }).join('');
  // Re-aplicar conteos si ya están en caché
  applyStageCountsToCards();
}

document.getElementById('vacancies-grid').addEventListener('click', e => {
  const btn = e.target.closest('.js-ver-candidatos');
  if (!btn) return;
  const card = btn.closest('.vacancy-card');
  openCandidates(card.dataset.id, card.dataset.title);
});

// ============================================================
// Panel candidatos — apertura con datos de Sheets + Bizneo
// ============================================================
async function openCandidates(jobId, jobTitle) {
  currentVacancy     = { id: jobId, title: jobTitle };
  allCandidatesState = [];
  currentTab         = 'postulados';
  processFilter      = 'all';

  const panel      = document.getElementById('candidates-panel');
  const loading    = document.getElementById('candidates-loading');
  const loadingTxt = document.getElementById('candidates-loading-text');
  const tableWrap  = document.getElementById('candidates-table-wrap');
  const stageTabs  = document.getElementById('stage-tabs');
  const progWrap   = document.getElementById('progress-wrap');
  const btn        = document.getElementById('btn-process');

  document.getElementById('panel-title').textContent    = jobTitle;
  document.getElementById('panel-subtitle').textContent = `ID: ${jobId}`;
  btn.disabled    = true;
  btn.textContent = '⚡ Calcular scores';

  panel.classList.remove('hidden');
  stageTabs.classList.add('hidden');
  progWrap.classList.add('hidden');
  loading.classList.remove('hidden');
  loadingTxt.textContent = 'Cargando candidatos...';
  tableWrap.innerHTML = '';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Asegurar tab postulados activo
  document.querySelectorAll('.stage-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === 'postulados')
  );

  try {
    const [bizneoRes, sheetsRes] = await Promise.all([
      fetch(`${API}/vacancies/${jobId}/candidates`).then(r => r.json()),
      fetch(`${API}/sheets/candidatos/${jobId}`).then(r => r.json()).catch(() => ({ success: false, data: [] })),
    ]);

    if (!bizneoRes.success) throw new Error(bizneoRes.error);

    allCandidatesState = buildCandidatesState(
      bizneoRes.data || [],
      sheetsRes.success ? (sheetsRes.data || []) : []
    );

    loading.classList.add('hidden');
    stageTabs.classList.remove('hidden');

    document.getElementById('panel-subtitle').textContent =
      `${allCandidatesState.length} candidatos · ID: ${jobId}`;

    updateTabCounts();
    document.getElementById('process-filter-bar')?.classList.remove('hidden');
    document.querySelectorAll('.pf-btn').forEach(b => b.classList.toggle('active', b.dataset.pf === 'all'));
    renderTab('postulados');

    const pending = allCandidatesState.filter(c => !c.procesado_ia).length;
    if (pending > 0) {
      btn.textContent   = `⚡ Procesar ${pending} pendientes`;
      btn.dataset.force = '0';
    } else {
      btn.textContent   = '⚡ Recalcular';
      btn.dataset.force = '0';
    }
    btn.disabled = false;
  } catch (err) {
    loading.classList.add('hidden');
    tableWrap.innerHTML = `<div style="color:var(--danger);padding:20px;">Error: ${err.message}</div>`;
    showToast(`Error: ${err.message}`, 'error');
  }
}

// Construye el estado unificado: datos de Bizneo + overlay de Sheets
function buildCandidatesState(bizneoList, sheetsRows) {
  const sheetsMap = new Map(sheetsRows.map(r => [String(r.candidato_id), r]));

  return bizneoList
    .filter(c => !String(c.source_portal || '').toLowerCase().includes('mtd'))
    .map(c => {
      const meta = c.professional_metadata || {};
      const loc  = c.location || {};
      const user = c.user_metadata || {};
      const slug = c.slug || toBizneoSlug(c.first_name || '', c.last_name || '');
      const saved = sheetsMap.get(String(c.id));

      const state = {
        id:          c.id,
        name:        `${c.first_name||''} ${c.last_name||''}`.trim(),
        email:       c.email || '',
        phone:       meta.phone || '',
        city:        loc.city || loc.province || '',
        edad:        calcAge(user.birth_date),
        bizneo_url:  `https://ats.bizneo.com/trabajar/mtd/candidates/${slug}`,
        score:                   null,
        classification:          null,
        education:               [],
        experience:              [],
        skills:                  [],
        total_experience_months: 0,
        anos_exp:                0,
        cv_status:               null,
        breakdown:               {},
        etapa:                   'POSTULADO',
        calificacion_reclutador: '',
        nota_reclutador:         '',
        procesado_ia:            false,
        fecha_procesado:         '',
        fecha_promovido:         '',
        global_etapa:            null,
        global_vacante:          null,
        global_abrev:            null,
      };

      if (saved) {
        let education = [], experience = [], skills = [], breakdown = {};
        try { education  = JSON.parse(saved.formacion  || '[]'); } catch (_) {}
        try { experience = JSON.parse(saved.experiencia || '[]'); } catch (_) {}
        try { skills     = JSON.parse(saved.habilidades || '[]'); } catch (_) {}
        try { breakdown  = JSON.parse(saved.breakdown   || '{}'); } catch (_) {}

        const clfLabel = normalizeClfLabel(saved.clasificacion);
        Object.assign(state, {
          score:                   parseInt(saved.score) || null,
          classification:          clfLabel ? { label: clfLabel, bg: labelToBg(clfLabel) } : null,
          education, experience, skills, breakdown,
          total_experience_months: Math.round(parseFloat(saved.anos_exp || 0) * 12),
          anos_exp:                parseFloat(saved.anos_exp) || 0,
          cv_status:               saved.cv_status || null,
          city:                    saved.ciudad   || state.city,
          phone:                   saved.telefono || state.phone,
          edad:                    saved.edad ? parseInt(saved.edad) : state.edad,
          etapa:                   saved.etapa || 'POSTULADO',
          calificacion_reclutador: saved.calificacion_reclutador || '',
          nota_reclutador:         saved.nota_reclutador || '',
          procesado_ia:            saved.procesado_ia === 'true',
          fecha_procesado:         saved.fecha_procesado || '',
          fecha_promovido:         saved.fecha_promovido || '',
        });
      }
      return state;
    })
    .sort((a, b) => {
      if (a.procesado_ia && !b.procesado_ia) return -1;
      if (!a.procesado_ia && b.procesado_ia) return 1;
      return (b.score || 0) - (a.score || 0);
    });
}

// ============================================================
// Pestañas de etapa
// ============================================================
function updateTabCounts() {
  const total = allCandidatesState.length;
  const pre   = allCandidatesState.filter(c => c.etapa === 'PRESELECCIONADO').length;
  const fin   = allCandidatesState.filter(c => c.etapa === 'FINALISTA').length;
  const nc    = allCandidatesState.filter(c => c.etapa === 'NO_CONTINUA').length;
  const bP  = document.getElementById('tab-badge-postulados');
  const bR  = document.getElementById('tab-badge-preseleccionados');
  const bF  = document.getElementById('tab-badge-finalistas');
  const bNC = document.getElementById('tab-badge-no-continua');
  if (bP)  bP.textContent  = total;
  if (bR)  bR.textContent  = pre || '';
  if (bF)  bF.textContent  = fin || '';
  if (bNC) bNC.textContent = nc  || '';
}

function applyProcessFilter(candidates) {
  if (processFilter === 'pending') return candidates.filter(c => !c.procesado_ia);
  if (processFilter === 'done')    return candidates.filter(c => c.procesado_ia);
  return candidates;
}

function updatePfCount(shown, total) {
  const el = document.getElementById('pf-count');
  if (el) el.textContent = shown < total ? `${shown} de ${total}` : `${total} candidatos`;
}

function renderTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.stage-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab)
  );
  const pfBar = document.getElementById('process-filter-bar');
  if (pfBar) pfBar.classList.toggle('hidden', tab !== 'postulados');

  if (tab === 'postulados') {
    const all      = allCandidatesState.filter(c => c.etapa !== 'NO_CONTINUA');
    const filtered = applyProcessFilter(all);
    updatePfCount(filtered.length, all.length);
    renderPostuladosTable(filtered);
  } else if (tab === 'preseleccionados') {
    renderPreseleccionadosTable(allCandidatesState.filter(c => c.etapa === 'PRESELECCIONADO'));
  } else if (tab === 'finalistas') {
    renderFinalistasTable(allCandidatesState.filter(c => c.etapa === 'FINALISTA'));
  } else if (tab === 'no_continua') {
    renderNoContinuaTable(allCandidatesState.filter(c => c.etapa === 'NO_CONTINUA'));
  }
}

// ============================================================
// Componente de estrellas
// ============================================================
function starRatingHtml(cid, vid, rating, nota) {
  const n = parseInt(rating) || 0;
  const stars = [1,2,3,4,5].map(i =>
    `<button class="star-btn ${i <= n ? 'on' : 'off'}" data-n="${i}" type="button">★</button>`
  ).join('');
  return `<div class="star-widget" data-cid="${cid}" data-vid="${vid}">
    <div class="stars-row">${stars}</div>
    <input class="star-note" type="text" placeholder="Nota…" value="${escapeHtml(nota||'')}" maxlength="120">
  </div>`;
}

// ============================================================
// Helpers HTML — versiones compactas para tabla
// ============================================================
function _eduCompact(education) {
  if (!education?.length) return '<span class="chip-empty">—</span>';
  const sorted = [...education].sort((a,b) => (LEVEL_ORDER[b.level]||0) - (LEVEL_ORDER[a.level]||0));
  const shown  = sorted.slice(0, 2);
  const more   = sorted.length - 2;
  return shown.map(e => {
    const lbl = LEVEL_LABEL[e.level] || e.level || '—';
    return `<span class="chip chip-edu">🎓 ${escapeHtml(lbl)}</span>`;
  }).join(' ') + (more > 0 ? ` <span class="chip chip-more">+${more}</span>` : '');
}

function _globalBadge(c) {
  if (!c.global_etapa) return '';
  const label = c.global_etapa === 'FINALISTA' ? '★ Finalista' : '✦ Presel.';
  const abrev = c.global_abrev ? ` [${escapeHtml(c.global_abrev)}]` : '';
  const vacante = c.global_vacante && c.global_vacante !== currentVacancy?.title
    ? ` · ${escapeHtml(c.global_vacante.slice(0, 30))}` : '';
  return `<div style="margin-top:4px"><span class="badge-global" title="Promovido en otra vacante">${label}${abrev}${vacante}</span></div>`;
}

function _expCompact(experience, totalMonths) {
  if (!experience?.length && !totalMonths) return '<span class="chip-empty">—</span>';
  const count = experience?.length || 0;
  const yrs = totalMonths >= 12
    ? `${Math.round(totalMonths/12*10)/10} años`
    : `${totalMonths || 0}m`;
  const cStr = count > 0 ? `${count} cargo${count>1?'s':''} · ` : '';
  return `<span class="chip chip-exp">💼 ${cStr}${yrs}</span>`;
}

function _skillsCompact(skills, cid) {
  if (!skills?.length) return '<span class="chip-empty">—</span>';
  const shown = skills.slice(0, 2);
  const more  = skills.length - 2;
  return shown.map(s => `<span class="chip chip-skill">${escapeHtml(s)}</span>`).join(' ') +
    (more > 0 ? ` <button class="chip chip-more js-skills-more" data-cid="${cid}">+${more}</button>` : '');
}

function _detailBtn(cid, section) {
  return `<button class="btn-detail" data-cid="${cid}" data-section="${section}" title="Ver detalle">↗</button>`;
}

function _scoreHtml(score, breakdown, classification, vacancyNa, explicacion) {
  const badge = classification ? `<div style="margin-bottom:5px">${classificationBadge(classification)}</div>` : '';
  const explText = explicacion || 'Recalcula con "↺ Forzar" para ver la razón específica del score basada en los requisitos de la vacante.';
  const razonBtn = `<button class="btn-score-razon" data-expl="${escapeHtml(explText)}" title="Ver razón" style="font-size:10px;color:var(--accent-2);background:none;border:none;cursor:pointer;padding:2px 0;margin-top:2px;display:block;text-align:left">📋 Ver razón</button>`;
  if (vacancyNa) {
    const naReason = 'Sin descripción de vacante — no es posible calcular el puntaje de coincidencia.';
    return `<div style="min-width:110px">${badge}<span class="btn-score-razon" data-expl="${escapeHtml(naReason)}" style="font-size:10px;color:var(--muted);font-style:italic;cursor:pointer">N/A · <u>¿Por qué?</u></span></div>`;
  }
  if (score == null || score === '') return `<div style="min-width:110px">${badge}<span class="no-data">—</span></div>`;
  const clr = scoreColor(score);
  return `<div style="min-width:110px">
    ${badge}
    <div class="score-cell">
      <span class="score-num" style="color:${clr}">${score}</span>
      <div class="score-bar"><div class="score-bar-fill" style="width:${Math.min(100,(score/60)*100)}%;background:${clr}"></div></div>
    </div>
    ${razonBtn}
  </div>`;
}

function _avatarHtml(c) {
  const initials = (c.name || '?').split(' ').slice(0,2).map(w => w[0]).join('').toUpperCase();
  if (c.avatar_url) {
    return `<img src="${escapeHtml(c.avatar_url)}" alt="${escapeHtml(initials)}"
      style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border)"
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <span style="display:none;width:32px;height:32px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:700;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initials)}</span>`;
  }
  return `<span style="display:flex;width:32px;height:32px;border-radius:50%;background:var(--surface-3,#23232f);color:var(--text-2);font-size:11px;font-weight:700;align-items:center;justify-content:center;flex-shrink:0;border:1px solid var(--border)">${escapeHtml(initials)}</span>`;
}

function _noContinuaBtn(c) {
  return `<button class="btn-no-continua"
    data-cid="${c.id}"
    data-vid="${escapeHtml(String(currentVacancy?.id||''))}"
    data-email="${escapeHtml(c.email)}"
    data-nombre="${escapeHtml(c.name)}"
    data-vacante="${escapeHtml(currentVacancy?.title||'')}"
    title="Notificar no continuidad">✗ No continúa</button>`;
}

function _calendarBtn(c) {
  return `<button class="btn-calendar btn-agendar"
    data-cid="${c.id}"
    data-vid="${escapeHtml(String(currentVacancy?.id||''))}"
    data-email="${escapeHtml(c.email)}"
    data-nombre="${escapeHtml(c.name)}"
    data-vacante="${escapeHtml(currentVacancy?.title||'')}"
    title="Agendar entrevista">📅</button>`;
}

function _cvIcon(cvStatus) {
  if (cvStatus === 'leido_ia')
    return `<span class="cv-ia cv-ia-ok" title="Procesado por IA">✓ IA</span>`;
  if (cvStatus === 'leido_heuristico')
    return `<span class="cv-ia cv-ia-ok" title="Procesado con análisis local">✓ CV</span>`;
  if (!cvStatus || cvStatus === 'sin_cv')
    return `<span class="cv-ia cv-ia-off" title="Sin CV adjunto en Bizneo">○ Sin CV</span>`;
  if (cvStatus.startsWith('leido_ia')) // variantes
    return `<span class="cv-ia cv-ia-ok" title="Procesado por IA">✓ IA</span>`;
  if (cvStatus.startsWith('sin_procesar:')) {
    const reason = cvStatus.replace('sin_procesar: ', '').replace('sin_procesar:', '');
    return `<span class="cv-ia cv-ia-warn" title="${escapeHtml(reason)}">◷ ${escapeHtml(reason.slice(0, 28))}</span>`;
  }
  if (cvStatus.startsWith('ilegible:')) {
    const reason = cvStatus.replace('ilegible: ', '').replace('ilegible:', '');
    return `<span class="cv-ia cv-ia-warn" title="${escapeHtml(reason)}">⚠ ${escapeHtml(reason.slice(0, 22))}</span>`;
  }
  if (cvStatus.startsWith('error:'))
    return `<span class="cv-ia cv-ia-err" title="${escapeHtml(cvStatus)}">✗ Error IA</span>`;
  return `<span class="cv-ia cv-ia-off" title="${escapeHtml(String(cvStatus||''))}">○ IA</span>`;
}

// ============================================================
// Drawer de detalle
// ============================================================
function openDetailDrawer(c, section) {
  document.getElementById('drawer-name').textContent = c.name || '—';
  document.getElementById('drawer-sub').textContent =
    [c.email, c.phone, c.city].filter(Boolean).join(' · ');
  document.getElementById('drawer-content').innerHTML = buildDrawerContent(c);
  document.getElementById('detail-drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('open');
  if (section) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(`drawer-sec-${section}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }
}

function closeDetailDrawer() {
  document.getElementById('detail-drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
}

document.getElementById('drawer-close').addEventListener('click', closeDetailDrawer);
document.getElementById('drawer-overlay').addEventListener('click', closeDetailDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetailDrawer(); });

function buildDrawerContent(c) {
  let html = '';

  // Score summary
  if (c.score != null) {
    const clr = scoreColor(c.score);
    const bd  = c.breakdown || {};
    html += `<div class="drawer-score-row">
      <div class="drawer-score-big" style="color:${clr}">${c.score}</div>
      <div class="drawer-score-meta">
        ${c.classification ? classificationBadge(c.classification) : ''}
        <div class="drawer-score-bar-outer" style="margin-top:8px">
          <div class="drawer-score-bar-fill" style="width:${Math.min(100,(c.score/60)*100)}%;background:${clr}"></div>
        </div>
        ${Object.keys(bd).length ? `<div class="drawer-score-breakdown">
          Formación ${bd.formacion||0} · Experiencia ${bd.experiencia||0} · Salud ${bd.healthcare||0} · Ciudad ${bd.ubicacion||0} · Completitud ${bd.completitud||0}
        </div>` : ''}
      </div>
    </div>`;
  }

  // Education
  if (c.education?.length) {
    html += `<div class="drawer-section" id="drawer-sec-education">
      <div class="drawer-section-title">🎓 Formación</div>
      ${[...c.education]
        .sort((a,b) => (LEVEL_ORDER[b.level]||0) - (LEVEL_ORDER[a.level]||0))
        .map(e => {
          const lbl = LEVEL_LABEL[e.level] || e.level || '';
          const clr = LEVEL_COLOR[e.level] || '#64748b';
          return `<div class="drawer-card">
            <div class="drawer-card-title">${escapeHtml(e.degree || '—')}</div>
            ${e.institution || e.year ? `<div class="drawer-card-sub">${e.institution ? escapeHtml(e.institution) : ''}${e.institution && e.year ? ' · ' : ''}${e.year ? escapeHtml(String(e.year)) : ''}</div>` : ''}
            <span class="drawer-card-badge" style="background:${clr}22;color:${clr}">${lbl}</span>
          </div>`;
        }).join('')}
    </div>`;
  }

  // Experience
  if (c.experience?.length) {
    const totalLabel = (c.total_experience_months || 0) >= 12
      ? `${Math.round(c.total_experience_months/12*10)/10} años`
      : `${c.total_experience_months || 0} meses`;
    html += `<div class="drawer-section" id="drawer-sec-experience">
      <div class="drawer-section-title">💼 Experiencia · ${totalLabel}</div>
      ${c.experience.map(e => `<div class="drawer-card">
        <div class="drawer-card-title">${escapeHtml(e.role || 'Cargo desconocido')}</div>
        ${e.company || e.duration_months ? `<div class="drawer-card-sub">${e.company ? escapeHtml(e.company) : ''}${e.company && e.duration_months ? ' · ' : ''}${e.duration_months ? e.duration_months + ' meses' : ''}</div>` : ''}
      </div>`).join('')}
    </div>`;
  }

  // Skills
  if (c.skills?.length) {
    html += `<div class="drawer-section" id="drawer-sec-skills">
      <div class="drawer-section-title">⚡ Habilidades</div>
      <div class="drawer-skills-wrap">
        ${c.skills.map(s => `<span class="drawer-skill-tag">${escapeHtml(s)}</span>`).join('')}
      </div>
    </div>`;
  }

  if (!html) {
    html = `<p style="color:var(--muted);padding:10px 0">Sin datos procesados por IA todavía.</p>`;
  }
  return html;
}

function _demoteBtn(c, targetStage) {
  const label = targetStage === 'POSTULADO' ? '← Devolver' : '← Bajar';
  return `<button class="btn-demote"
    data-cid="${c.id}" data-vid="${escapeHtml(String(currentVacancy?.id||''))}"
    data-stage="${targetStage}"
    data-nombre="${escapeHtml(c.name)}" data-email="${escapeHtml(c.email)}"
    data-telefono="${escapeHtml(c.phone||'')}" data-ciudad="${escapeHtml(c.city||'')}"
    data-edad="${escapeHtml(String(c.edad||''))}">${label}</button>`;
}

function _promoteBtn(c, targetStage) {
  const label = targetStage === 'PRESELECCIONADO' ? 'Preseleccionar' : '→ Finalista';
  return `<button class="btn-promote"
    data-cid="${c.id}" data-vid="${escapeHtml(String(currentVacancy?.id||''))}"
    data-stage="${targetStage}"
    data-nombre="${escapeHtml(c.name)}" data-email="${escapeHtml(c.email)}"
    data-telefono="${escapeHtml(c.phone||'')}" data-ciudad="${escapeHtml(c.city||'')}"
    data-edad="${escapeHtml(String(c.edad||''))}">${label}</button>`;
}

// ============================================================
// Filas por tipo de tabla (chips compactos + botón detalle)
// ============================================================
function rowPostulado(c, idx) {
  const edadStr     = c.edad ? ` <span class="age-tag">${c.edad} años</span>` : '';
  const hasEdu      = !!(c.education?.length);
  const hasExp      = !!(c.experience?.length);
  const promoteHtml = c.etapa !== 'FINALISTA'
    ? _promoteBtn(c, c.etapa === 'PRESELECCIONADO' ? 'FINALISTA' : 'PRESELECCIONADO')
    : `<span class="etapa-tag">Finalista</span>`;

  return `<tr data-cid="${c.id}" data-score="${c.score||0}">
    <td class="col-idx" style="white-space:nowrap;font-size:11px;color:var(--muted)">${formatDateCompact(c.fecha_postulacion)}</td>
    <td>
      <div style="display:flex;gap:8px;align-items:flex-start">
        ${_avatarHtml(c)}
        <div>
          <div class="cand-name">${escapeHtml(c.name)}${edadStr}</div>
          <div class="cand-email">${escapeHtml(c.email)}</div>
          ${c.phone ? `<div class="cand-phone">${escapeHtml(c.phone)}</div>` : ''}
          <div class="cand-cv">${_cvIcon(c.cv_status)}</div>
          ${_globalBadge(c)}
        </div>
      </div>
    </td>
    <td style="white-space:nowrap;font-size:12px;color:var(--text-2)">${escapeHtml(c.city||'—')}</td>
    <td>${_eduCompact(c.education)}${hasEdu ? _detailBtn(c.id, 'education') : ''}</td>
    <td>${_expCompact(c.experience, c.total_experience_months)}${hasExp ? _detailBtn(c.id, 'experience') : ''}</td>
    <td>${_skillsCompact(c.skills, c.id)}</td>
    <td>${_scoreHtml(c.score, c.breakdown, c.classification, c.vacancy_na, c.explicacion)}</td>
    <td>${starRatingHtml(c.id, currentVacancy?.id, c.calificacion_reclutador, c.nota_reclutador)}</td>
    <td style="display:flex;gap:4px;flex-wrap:wrap">${promoteHtml}${_noContinuaBtn(c)}</td>
    <td class="col-link">${c.bizneo_url ? `<a href="${c.bizneo_url}" target="_blank" rel="noopener">↗</a>` : '<span class="no-data">—</span>'}</td>
  </tr>`;
}

function rowPreseleccionado(c, idx) {
  const edadStr = c.edad ? ` <span class="age-tag">${c.edad} años</span>` : '';
  const hasEdu  = !!(c.education?.length);
  const hasExp  = !!(c.experience?.length);
  const entrevista = c.fecha_entrevista
    ? `<div style="font-size:11px;color:#22c55e;margin-top:3px">📅 ${formatDateCompact(c.fecha_entrevista)}</div>`
    : '';
  return `<tr data-cid="${c.id}" data-score="${c.score||0}">
    <td class="col-idx" style="white-space:nowrap;font-size:11px;color:var(--muted)">${formatDateCompact(c.fecha_postulacion)}</td>
    <td>
      <div style="display:flex;gap:8px;align-items:flex-start">
        ${_avatarHtml(c)}
        <div>
          <div class="cand-name">${escapeHtml(c.name)}${edadStr}</div>
          ${entrevista}
        </div>
      </div>
    </td>
    <td>
      <div style="font-size:12px;color:var(--text-2)">${escapeHtml(c.email)}</div>
      ${c.phone ? `<div class="cand-phone">${escapeHtml(c.phone)}</div>` : ''}
    </td>
    <td>${_eduCompact(c.education)}${hasEdu ? _detailBtn(c.id, 'education') : ''}</td>
    <td>${_expCompact(c.experience, c.total_experience_months)}${hasExp ? _detailBtn(c.id, 'experience') : ''}</td>
    <td>${_scoreHtml(c.score, c.breakdown, c.classification, c.vacancy_na, c.explicacion)}</td>
    <td>${starRatingHtml(c.id, currentVacancy?.id, c.calificacion_reclutador, c.nota_reclutador)}</td>
    <td style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
      ${_demoteBtn(c, 'POSTULADO')} ${_promoteBtn(c, 'FINALISTA')}
      ${_calendarBtn(c)} ${_noContinuaBtn(c)}
    </td>
    <td class="col-link">${c.bizneo_url ? `<a href="${c.bizneo_url}" target="_blank" rel="noopener">↗</a>` : '<span class="no-data">—</span>'}</td>
  </tr>`;
}

function rowFinalista(c, idx) {
  const edadStr = c.edad ? ` <span class="age-tag">${c.edad} años</span>` : '';
  const hasEdu  = !!(c.education?.length);
  const hasExp  = !!(c.experience?.length);
  return `<tr data-cid="${c.id}" data-score="${c.score||0}">
    <td class="col-idx" style="white-space:nowrap;font-size:11px;color:var(--muted)">${formatDateCompact(c.fecha_postulacion)}</td>
    <td>
      <div class="cand-name">${escapeHtml(c.name)}${edadStr}</div>
      <div class="cand-email">${escapeHtml(c.email)}</div>
      ${c.phone ? `<div class="cand-phone">${escapeHtml(c.phone)}</div>` : ''}
      <div class="cand-cv">${_cvIcon(c.cv_status)}</div>
    </td>
    <td style="white-space:nowrap;font-size:12px;color:var(--text-2)">${escapeHtml(c.city||'—')}</td>
    <td>${_eduCompact(c.education)}${hasEdu ? _detailBtn(c.id, 'education') : ''}</td>
    <td>${_expCompact(c.experience, c.total_experience_months)}${hasExp ? _detailBtn(c.id, 'experience') : ''}</td>
    <td>${_skillsCompact(c.skills, c.id)}</td>
    <td>${_scoreHtml(c.score, c.breakdown, c.classification, c.vacancy_na, c.explicacion)}</td>
    <td>${starRatingHtml(c.id, currentVacancy?.id, c.calificacion_reclutador, c.nota_reclutador)}</td>
    <td>${_demoteBtn(c, 'PRESELECCIONADO')}</td>
    <td class="col-link">${c.bizneo_url ? `<a href="${c.bizneo_url}" target="_blank" rel="noopener">↗</a>` : '<span class="no-data">—</span>'}</td>
  </tr>`;
}

function rowNoContinua(c, idx) {
  const edadStr = c.edad ? ` <span class="age-tag">${c.edad} años</span>` : '';
  return `<tr data-cid="${c.id}">
    <td class="col-idx" style="white-space:nowrap;font-size:11px;color:var(--muted)">${formatDateCompact(c.fecha_postulacion)}</td>
    <td>
      <div class="cand-name">${escapeHtml(c.name)}${edadStr}</div>
      <div class="cand-email">${escapeHtml(c.email)}</div>
      ${c.phone ? `<div class="cand-phone">${escapeHtml(c.phone)}</div>` : ''}
    </td>
    <td style="font-size:12px;color:var(--text-2)">${escapeHtml(c.city||'—')}</td>
    <td>${_scoreHtml(c.score, c.breakdown, c.classification, c.vacancy_na, c.explicacion)}</td>
    <td style="display:flex;gap:4px;flex-wrap:wrap">${_demoteBtn(c, 'POSTULADO')}</td>
    <td class="col-link">${c.bizneo_url ? `<a href="${c.bizneo_url}" target="_blank" rel="noopener">↗</a>` : '<span class="no-data">—</span>'}</td>
  </tr>`;
}

// ============================================================
// Render de tablas por pestaña
// ============================================================
// ============================================================
// Columnas redimensionables
// ============================================================
function makeTableResizable(table) {
  table.querySelectorAll('th').forEach(th => {
    if (th.querySelector('.col-resize-handle')) return;
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);
    let startX = 0, startW = 0;
    handle.addEventListener('mousedown', e => {
      startX = e.clientX;
      startW = th.offsetWidth;
      handle.classList.add('active');
      const onMove = ev => {
        const w = Math.max(50, startW + ev.clientX - startX);
        th.style.width = th.style.minWidth = w + 'px';
      };
      const onUp = () => {
        handle.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
      e.stopPropagation();
    });
  });
}

function mountTopScroll(tw) {
  const old = tw.previousElementSibling;
  if (old?.classList.contains('top-scroll-wrap')) old.remove();
  const wrap  = document.createElement('div');
  wrap.className = 'top-scroll-wrap';
  const inner = document.createElement('div');
  inner.className = 'top-scroll-inner';
  wrap.appendChild(inner);
  tw.parentNode.insertBefore(wrap, tw);
  const sync1 = () => { tw.scrollLeft = wrap.scrollLeft; };
  const sync2 = () => { wrap.scrollLeft = tw.scrollLeft; };
  wrap.addEventListener('scroll', sync1, { passive: true });
  tw.addEventListener('scroll', sync2, { passive: true });
  requestAnimationFrame(() => { inner.style.width = tw.scrollWidth + 'px'; });
}

function renderPostuladosTable(candidates) {
  const tw = document.getElementById('candidates-table-wrap');
  if (!candidates.length) {
    tw.innerHTML = '<p style="padding:20px;color:var(--muted);">Sin candidatos.</p>'; return;
  }
  tw.innerHTML = `<table>
    <thead><tr>
      <th>Postulación</th><th>Candidato</th><th>Ciudad</th>
      <th>Formación</th><th>Experiencia</th><th>Habilidades</th>
      <th>Score</th><th>Calificación</th><th>Acciones</th><th>↗</th>
    </tr></thead>
    <tbody id="candidates-tbody">${candidates.map((c,i) => rowPostulado(c, i+1)).join('')}</tbody>
  </table>`;
  const tbl = tw.querySelector('table');
  if (tbl) { makeTableResizable(tbl); mountTopScroll(tw); }
}

function renderPreseleccionadosTable(candidates) {
  const tw = document.getElementById('candidates-table-wrap');
  if (!candidates.length) {
    tw.innerHTML = '<p style="padding:20px;color:var(--muted);">Ningún candidato preseleccionado aún.</p>'; return;
  }
  tw.innerHTML = `<table>
    <thead><tr>
      <th>Postulación</th><th>Candidato</th><th>Contacto</th>
      <th>Formación</th><th>Experiencia</th>
      <th>Score</th><th>Calificación</th><th>Acciones</th><th>↗</th>
    </tr></thead>
    <tbody>${candidates.map((c,i) => rowPreseleccionado(c, i+1)).join('')}</tbody>
  </table>`;
  const tbl2 = tw.querySelector('table');
  if (tbl2) { makeTableResizable(tbl2); mountTopScroll(tw); }
}

function renderFinalistasTable(candidates) {
  const tw = document.getElementById('candidates-table-wrap');
  if (!candidates.length) {
    tw.innerHTML = '<p style="padding:20px;color:var(--muted);">Ningún finalista aún.</p>'; return;
  }
  tw.innerHTML = `<table>
    <thead><tr>
      <th>Postulación</th><th>Candidato</th><th>Ciudad</th>
      <th>Formación</th><th>Experiencia</th><th>Habilidades</th>
      <th>Score</th><th>Calificación</th><th>Devolver</th><th>↗</th>
    </tr></thead>
    <tbody>${candidates.map((c,i) => rowFinalista(c, i+1)).join('')}</tbody>
  </table>`;
  const tbl3 = tw.querySelector('table');
  if (tbl3) { makeTableResizable(tbl3); mountTopScroll(tw); }
}

function renderNoContinuaTable(candidates) {
  const tw = document.getElementById('candidates-table-wrap');
  if (!candidates.length) {
    tw.innerHTML = '<p style="padding:20px;color:var(--muted);">Sin candidatos en esta categoría.</p>'; return;
  }
  tw.innerHTML = `<table>
    <thead><tr>
      <th>Postulación</th><th>Candidato</th><th>Ciudad</th>
      <th>Score</th><th>Acciones</th><th>↗</th>
    </tr></thead>
    <tbody>${candidates.map((c,i) => rowNoContinua(c, i+1)).join('')}</tbody>
  </table>`;
  const tbl4 = tw.querySelector('table');
  if (tbl4) { makeTableResizable(tbl4); mountTopScroll(tw); }
}

// ============================================================
// Eventos del panel candidatos (delegación)
// ============================================================
document.getElementById('candidates-panel').addEventListener('click', e => {
  // Pestaña de etapa
  const tab = e.target.closest('.stage-tab');
  if (tab) { renderTab(tab.dataset.tab); return; }

  // Botón detalle — abre drawer
  const detail = e.target.closest('.btn-detail');
  if (detail) {
    const c = allCandidatesState.find(x => String(x.id) === String(detail.dataset.cid));
    if (c) openDetailDrawer(c);
    return;
  }

  // Chip +N de habilidades — popup
  const skillsMore = e.target.closest('.js-skills-more');
  if (skillsMore) {
    const c = allCandidatesState.find(x => String(x.id) === String(skillsMore.dataset.cid));
    if (c?.skills?.length) { e.stopPropagation(); openSkillsPopup(skillsMore, c.skills); }
    return;
  }

  // Botón promover
  const promote = e.target.closest('.btn-promote');
  if (promote) {
    const { cid, vid, stage, nombre, email, telefono, ciudad, edad } = promote.dataset;
    promoteCandidate(cid, vid, stage, { nombre, email, telefono, ciudad, edad, vacanteName: currentVacancy?.title || '' }, promote);
    return;
  }

  // Botón devolver (demote)
  const demote = e.target.closest('.btn-demote');
  if (demote) {
    const { cid, vid, stage, nombre, email, telefono, ciudad, edad } = demote.dataset;
    promoteCandidate(cid, vid, stage, { nombre, email, telefono, ciudad, edad, vacanteName: currentVacancy?.title || '' }, demote);
    return;
  }

  // Botón "Ver razón" del score
  const razonBtn = e.target.closest('.btn-score-razon');
  if (razonBtn) {
    e.stopPropagation();
    const expl = razonBtn.dataset.expl || '';
    openScorePopover(razonBtn, expl);
    return;
  }

  // Botón agendar entrevista
  const agBtn = e.target.closest('.btn-agendar');
  if (agBtn) {
    const { cid, vid, email, nombre, vacante } = agBtn.dataset;
    openCalendarModal({ cid, vid, email, nombre, vacante });
    return;
  }

  // Botón No continúa
  const ncBtn = e.target.closest('.btn-no-continua');
  if (ncBtn) {
    const { cid, vid, email, nombre, vacante } = ncBtn.dataset;
    openNoContinuaModal({ cid, vid, email, nombre, vacante });
    return;
  }

  // Estrella de calificación
  const star = e.target.closest('.star-btn');
  if (star) {
    const widget = star.closest('.star-widget');
    if (!widget) return;
    const n    = parseInt(star.dataset.n);
    const cid  = widget.dataset.cid;
    const vid  = widget.dataset.vid;
    const prev = [...widget.querySelectorAll('.star-btn.on')].length;
    const newR = n === prev ? 0 : n;
    widget.querySelectorAll('.star-btn').forEach((s, i) => {
      s.classList.toggle('on',  i < newR);
      s.classList.toggle('off', i >= newR);
    });
    const candidate = allCandidatesState.find(c => String(c.id) === String(cid));
    if (candidate) candidate.calificacion_reclutador = String(newR || '');
    debounceRating(cid, vid, newR, widget.querySelector('.star-note')?.value || '');
  }
});

document.getElementById('candidates-panel').addEventListener('input', e => {
  const note = e.target.closest('.star-note');
  if (!note) return;
  const widget = note.closest('.star-widget');
  if (!widget) return;
  const cid    = widget.dataset.cid;
  const vid    = widget.dataset.vid;
  const rating = [...widget.querySelectorAll('.star-btn.on')].length;
  const candidate = allCandidatesState.find(c => String(c.id) === String(cid));
  if (candidate) candidate.nota_reclutador = note.value;
  debounceRating(cid, vid, rating, note.value);
});

function debounceRating(cid, vid, rating, nota) {
  clearTimeout(_rateTimers[cid]);
  _rateTimers[cid] = setTimeout(async () => {
    try {
      const c = allCandidatesState.find(x => String(x.id) === String(cid));
      await fetch(`${API}/sheets/candidatos/${cid}/rating`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ vacancyId: vid, rating, nota, candidateName: c?.name || '', etapa: c?.etapa || 'POSTULADO' }),
      });
    } catch (e) {
      console.warn('[Rating]', e.message);
    }
  }, 800);
}

async function promoteCandidate(cid, vid, stage, basicData, btn) {
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const res  = await fetch(`${API}/sheets/candidatos/${cid}/stage`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ vacancyId: vid, stage, ...basicData, vacanteName: basicData.vacanteName || currentVacancy?.title || '' }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Error al promover');

    const candidate = allCandidatesState.find(c => String(c.id) === String(cid));
    if (candidate) {
      candidate.etapa           = stage;
      candidate.fecha_promovido = new Date().toISOString().split('T')[0];
    }

    renderTab(currentTab);
    updateTabCounts();

    const LABELS = { PRESELECCIONADO: 'Preseleccionados', FINALISTA: 'Finalistas', POSTULADO: 'Postulados', NO_CONTINUA: 'No continúa' };
    const label = LABELS[stage] || stage;
    const biz   = json.bizneoSynced ? ' · Bizneo ✓' : '';
    showToast(`Candidato movido a ${label}${biz}`, 'success');
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

// ============================================================
// Popover "Razón del score"
// ============================================================
let _scorePopoverEl = null;

function openScorePopover(anchor, texto) {
  closeScorePopover();
  const pop = document.createElement('div');
  pop.id = 'score-popover';
  pop.style.cssText = `position:fixed;z-index:800;background:var(--surface);border:1px solid var(--border-md);border-radius:10px;padding:14px 16px;max-width:320px;box-shadow:0 12px 40px rgba(0,0,0,.45);font-size:12px;color:var(--text-2);line-height:1.6;white-space:normal`;
  pop.textContent = texto;
  document.body.appendChild(pop);
  _scorePopoverEl = pop;

  const rect = anchor.getBoundingClientRect();
  const pw   = pop.offsetWidth || 320;
  let left   = rect.left;
  if (left + pw > window.innerWidth - 12) left = window.innerWidth - pw - 12;
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top  = `${rect.bottom + 6}px`;

  setTimeout(() => document.addEventListener('click', closeScorePopover, { once: true }), 10);
}

function closeScorePopover() {
  if (_scorePopoverEl) { _scorePopoverEl.remove(); _scorePopoverEl = null; }
}

// ============================================================
// Modal Agendar entrevista (flatpickr + Google Calendar URL)
// ============================================================
let _calCurrentData = null;
let _fpInstance = null;

function _initFlatpickr() {
  if (_fpInstance) return;
  if (typeof flatpickr === 'undefined') return;
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  _fpInstance = flatpickr('#cal-start', {
    enableTime:    true,
    dateFormat:    'D d M Y · H:i',
    minDate:       'today',
    time_24hr:     true,
    locale:        window.flatpickr?.l10ns?.es || 'default',
    disableMobile: true,
    onChange: () => { document.getElementById('cal-modal-error').style.display = 'none'; },
  });
}

function openCalendarModal({ cid, vid, email, nombre, vacante }) {
  _calCurrentData = { cid, vid, email, nombre, vacante };
  document.getElementById('cal-modal-cand').textContent = `${nombre}  ·  ${email}`;
  document.getElementById('cal-modal-error').style.display = 'none';
  document.getElementById('cal-modal-overlay').classList.remove('hidden');
  _initFlatpickr();
  // Default: mañana 9am
  const def = new Date(); def.setDate(def.getDate() + 1); def.setHours(9, 0, 0, 0);
  if (_fpInstance) _fpInstance.setDate(def, false);
}

function closeCalendarModal() {
  document.getElementById('cal-modal-overlay').classList.add('hidden');
  _calCurrentData = null;
}

document.getElementById('cal-modal-close').addEventListener('click', closeCalendarModal);
document.getElementById('cal-modal-cancel').addEventListener('click', closeCalendarModal);
document.getElementById('cal-modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('cal-modal-overlay')) closeCalendarModal();
});

document.getElementById('cal-modal-confirm').addEventListener('click', async () => {
  if (!_calCurrentData) return;
  const { cid, vid, email, nombre, vacante } = _calCurrentData;
  const errEl  = document.getElementById('cal-modal-error');
  const startDt = _fpInstance?.selectedDates?.[0];
  if (!startDt) { errEl.textContent = 'Selecciona la fecha y hora'; errEl.style.display = ''; return; }

  const durationMin = parseInt(document.getElementById('cal-duration').value || '60');
  const endDt       = new Date(startDt.getTime() + durationMin * 60000);

  const btn = document.getElementById('cal-modal-confirm');
  btn.disabled = true; btn.textContent = 'Abriendo…';
  errEl.style.display = 'none';

  try {
    const res  = await fetch(`${API}/sheets/candidatos/${cid}/entrevista/calendar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ vacancyId: vid, candidateName: nombre, candidateEmail: email, startDateTime: startDt.toISOString(), endDateTime: endDt.toISOString(), vacancyTitle: vacante }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Error');

    const candidate = allCandidatesState.find(c => String(c.id) === String(cid));
    if (candidate) { candidate.fecha_entrevista = `${String(startDt.getDate()).padStart(2,'0')}/${String(startDt.getMonth()+1).padStart(2,'0')}/${String(startDt.getFullYear()).slice(-2)}`; }

    closeCalendarModal();
    renderTab(currentTab);
    showToast('Fecha guardada ✓ — Google Calendar abierto', 'success');
    window.open(json.calendarUrl, '_blank');
  } catch (e) {
    errEl.textContent = e.message; errEl.style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Abrir en Calendar';
  }
});

// ============================================================
// Modal No continúa
// ============================================================
let _ncCurrentData = null;

function _noContinuaDefaultBody(nombre, vacante) {
  const n = nombre  || 'Estimado/a candidato/a';
  const v = vacante || 'la posición';
  return `Estimado/a ${n},

Agradecemos sinceramente el tiempo e interés que dedicaste a participar en nuestro proceso de selección para el cargo de ${v} en Medicina y Terapias Domiciliarias – MTD.

Después de una cuidadosa evaluación de todos los perfiles, lamentamos informarte que en esta ocasión hemos decidido no continuar con tu candidatura. Esta decisión no refleja tu valor profesional ni el esfuerzo que pusiste en el proceso.

Te animamos a estar atento/a a futuras oportunidades en MTD, ya que tu perfil podría encajar perfectamente en otras posiciones.

Te deseamos mucho éxito en tu camino profesional.

Cordialmente,
Equipo de Reclutamiento MTD
Medicina y Terapias Domiciliarias`;
}

function openNoContinuaModal({ cid, vid, email, nombre, vacante }) {
  _ncCurrentData = { cid, vid, email, nombre, vacante };
  document.getElementById('nc-email-to').value   = email || '';
  document.getElementById('nc-email-body').value = _noContinuaDefaultBody(nombre, vacante);
  document.getElementById('nc-modal-overlay').classList.remove('hidden');
}

function closeNoContinuaModal() {
  document.getElementById('nc-modal-overlay').classList.add('hidden');
  _ncCurrentData = null;
}

document.getElementById('nc-modal-close').addEventListener('click', closeNoContinuaModal);
document.getElementById('nc-modal-cancel').addEventListener('click', closeNoContinuaModal);
document.getElementById('nc-modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('nc-modal-overlay')) closeNoContinuaModal();
});

document.getElementById('nc-modal-send').addEventListener('click', async () => {
  if (!_ncCurrentData) return;
  const { cid, vid, email, nombre, vacante } = _ncCurrentData;
  const body = document.getElementById('nc-email-body').value.trim();
  const btn  = document.getElementById('nc-modal-send');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const res  = await fetch(`${API}/sheets/candidatos/${cid}/no-continua`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ vacancyId: vid, emailTo: email, emailBody: body.replace(/\n/g,'<br>'), candidateName: nombre, vacancyTitle: vacante }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Error al mover candidato');

    const candidate = allCandidatesState.find(c => String(c.id) === String(cid));
    if (candidate) candidate.etapa = 'NO_CONTINUA';
    closeNoContinuaModal();
    renderTab(currentTab);
    updateTabCounts();
    if (json.emailError) {
      showToast(`Candidato movido a No continúa · Correo falló: ${json.emailError}`, 'error');
    } else {
      showToast('Correo enviado · Candidato movido a No continúa ✓', 'success');
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Enviar correo';
  }
});

// ============================================================
// Procesar candidatos con SSE
// ============================================================
document.getElementById('btn-process').addEventListener('click', startSSEProcessing);
document.getElementById('btn-force-reprocess').addEventListener('click', () => {
  const btn = document.getElementById('btn-process');
  btn.dataset.force = '1';
  btn.textContent   = '↺ Forzando re-análisis...';
  startSSEProcessing();
});
document.getElementById('btn-close-panel').addEventListener('click', () => {
  if (activeSSE) { activeSSE.close(); activeSSE = null; }
  document.getElementById('candidates-panel').classList.add('hidden');
  currentVacancy = null;
});

function startSSEProcessing() {
  if (!currentVacancy) return;
  if (activeSSE) { activeSSE.close(); activeSSE = null; }

  const btn          = document.getElementById('btn-process');
  const progressWrap = document.getElementById('progress-wrap');
  const progressFill = document.getElementById('progress-fill-sse');
  const progressLbl  = document.getElementById('progress-label');

  btn.disabled       = true;
  btn.textContent    = 'Procesando...';
  progressWrap.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressLbl.textContent  = 'Conectando...';

  let total       = 0;
  let processed   = 0;
  let fromSheets  = 0;
  let startTime   = null;
  const inProgress = new Set();

  function updateProgressBar() {
    const eff = processed + inProgress.size * 0.5;
    const pct = total > 0 ? (eff / total) * 100 : 0;
    progressFill.style.width = `${Math.min(pct, 99)}%`;
    let label = `${processed}/${total} procesados`;
    if (processed > 0 && startTime && processed < total) {
      const elapsed   = Date.now() - startTime;
      const remaining = Math.round((elapsed / processed) * (total - processed) / 1000);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      label += ` · ~${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`} restantes`;
    }
    progressLbl.textContent = label;
  }

  const forceParam = btn.dataset.force === '1' ? '?force=1' : '';
  activeSSE = new EventSource(`${API}/vacancies/${currentVacancy.id}/procesar${forceParam}`);

  activeSSE.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'total') {
      total     = msg.total;
      startTime = Date.now();
      progressLbl.textContent = `0/${total} procesados${msg.skipped ? ` (${msg.skipped} omitidos)` : ''}`;
    }

    if (msg.type === 'progress') {
      inProgress.add(msg.index);
      updateProgressBar();
    }

    if (msg.type === 'candidate') {
      processed++;
      if (msg._from_sheets) fromSheets++;
      inProgress.delete(msg.index);
      updateProgressBar();

      // Actualizar estado local
      const idx = allCandidatesState.findIndex(c => String(c.id) === String(msg.id));
      if (idx !== -1) {
        Object.assign(allCandidatesState[idx], {
          score:                   msg.score,
          score_vacante:           msg.score_vacante || allCandidatesState[idx].score_vacante,
          vacancy_na:              msg.vacancy_na || false,
          explicacion:             msg.explicacion || allCandidatesState[idx].explicacion || '',
          classification:          msg.classification,
          education:               msg.education || [],
          experience:              msg.experience || [],
          skills:                  msg.skills || [],
          total_experience_months: msg.total_experience_months || 0,
          anos_exp:                msg.years_experience || 0,
          cv_status:               msg.cv_status,
          breakdown:               msg.breakdown || {},
          city:                    msg.city  || allCandidatesState[idx].city,
          phone:                   msg.phone || allCandidatesState[idx].phone,
          edad:                    msg.edad  || allCandidatesState[idx].edad,
          etapa:                   msg.etapa || allCandidatesState[idx].etapa,
          calificacion_reclutador: msg.calificacion_reclutador || allCandidatesState[idx].calificacion_reclutador,
          avatar_url:              msg.avatar_url || allCandidatesState[idx].avatar_url || '',
          fecha_postulacion:       msg.fecha_postulacion || allCandidatesState[idx].fecha_postulacion || '',
          fecha_entrevista:        msg.fecha_entrevista  || allCandidatesState[idx].fecha_entrevista  || '',
          procesado_ia:            true,
          global_etapa:   msg.global_etapa   || allCandidatesState[idx].global_etapa,
          global_vacante: msg.global_vacante || allCandidatesState[idx].global_vacante,
          global_abrev:   msg.global_abrev   || allCandidatesState[idx].global_abrev,
        });
      }

      // Actualizar fila en DOM si estamos en la pestaña postulados
      if (currentTab === 'postulados' && idx !== -1 && !msg._from_sheets) {
        const existing = document.querySelector(`tr[data-cid="${msg.id}"]`);
        if (existing) {
          const rowIdx = existing.querySelector('td:first-child')?.textContent?.trim() || (idx + 1);
          const temp   = document.createElement('tbody');
          temp.innerHTML = rowPostulado(allCandidatesState[idx], rowIdx);
          existing.parentNode.replaceChild(temp.firstElementChild, existing);
        }
      }

      updateTabCounts();
    }

    if (msg.type === 'done') {
      progressFill.style.width = '100%';
      const allFromSheets = processed > 0 && fromSheets === processed;
      if (allFromSheets) {
        progressLbl.textContent  = `✓ ${processed} candidatos ya procesados — usa "↺ Forzar" para re-analizar con IA`;
        progressFill.style.background = 'var(--accent)';
      } else {
        const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        progressLbl.textContent = `${processed} candidatos analizados · ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}`;
      }

      // Re-ordenar y re-renderizar con posición final
      allCandidatesState.sort((a, b) => {
        if (a.procesado_ia && !b.procesado_ia) return -1;
        if (!a.procesado_ia && b.procesado_ia) return 1;
        return (b.score || 0) - (a.score || 0);
      });
      renderTab(currentTab);
      updateTabCounts();

      const pending = allCandidatesState.filter(c => !c.procesado_ia).length;
      btn.disabled    = false;
      btn.dataset.force = '';
      btn.textContent = pending > 0 ? `⚡ Procesar ${pending} pendientes` : '⚡ Recalcular';

      document.getElementById('panel-subtitle').textContent =
        `${processed} analizados · ID: ${currentVacancy.id}`;
      showToast(`${processed} candidatos procesados`, 'success');
      activeSSE.close();
      activeSSE = null;
    }

    if (msg.type === 'error') {
      progressLbl.textContent         = `Error: ${msg.message}`;
      progressFill.style.background   = '#dc2626';
      btn.disabled    = false;
      btn.textContent = '⚡ Reintentar';
      showToast(`Error: ${msg.message}`, 'error');
      activeSSE.close();
      activeSSE = null;
    }
  };

  activeSSE.onerror = () => {
    if (!activeSSE) return; // ya fue cerrado por done/error
    if (activeSSE.readyState === EventSource.CLOSED) return;
    progressLbl.textContent = 'Conexión perdida';
    btn.disabled    = false;
    btn.textContent = '⚡ Reintentar';
    activeSSE.close();
    activeSSE = null;
  };
}

// ============================================================
// Upload CV manual
// ============================================================
const zone      = document.getElementById('upload-zone');
const fileInput = document.getElementById('cv-file-input');

zone.addEventListener('click', () => fileInput.click());
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
zone.addEventListener('drop', e => {
  e.preventDefault(); zone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) processUpload(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) processUpload(fileInput.files[0]); });

async function processUpload(file) {
  const resultDiv = document.getElementById('cv-result');
  zone.innerHTML = `<div class="loading" style="justify-content:center"><div class="spinner"></div><span>Analizando CV con IA...</span></div>`;
  const formData = new FormData();
  formData.append('cv', file);
  try {
    const res  = await fetch(`${API}/cv/upload`, { method: 'POST', body: formData });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    const { parsedCV, score, label } = json;
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = `
      <div class="cv-score-header">
        <div class="cv-score-big" style="background:${label.color}">${score.total}</div>
        <div>
          <div style="font-size:20px;font-weight:700;color:var(--mtd-blue)">${parsedCV.nombre || file.name}</div>
          <div style="margin-top:6px">${classificationBadge({ label: label.label, bg: label.color })}</div>
        </div>
      </div>
      ${parsedCV.education?.length ? `
      <div class="cv-section">
        <h4>Formación</h4>
        ${parsedCV.education.map(e => `<div style="padding:7px 0;border-bottom:1px solid var(--mtd-border)">
          <strong>${e.degree}</strong> · ${e.institution || '—'} · ${e.year || '—'}
          <span class="badge badge-blue" style="margin-left:6px">${e.level}</span>
        </div>`).join('')}
      </div>` : ''}
      ${parsedCV.skills?.length ? `
      <div class="cv-section">
        <h4>Habilidades</h4>
        ${parsedCV.skills.map(s => `<span class="tag">${s}</span>`).join('')}
      </div>` : ''}`;
    zone.innerHTML = `
      <div class="upload-icon">✅</div>
      <p>${file.name}</p>
      <p class="upload-hint">Score: <strong>${score.total}/60</strong> ·
        <span style="cursor:pointer;color:var(--mtd-blue-mid)" onclick="resetUpload()">Analizar otro</span></p>`;
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    resetUpload();
  }
}

function resetUpload() {
  const z = document.getElementById('upload-zone');
  z.innerHTML = `
    <div class="upload-icon">📄</div>
    <p>Arrastra un CV aquí o haz clic para seleccionar</p>
    <p class="upload-hint">PDF · DOC · DOCX · Máximo 10 MB</p>
    <input type="file" id="cv-file-input" accept=".pdf,.doc,.docx" class="hidden" />`;
  const inp = document.getElementById('cv-file-input');
  z.addEventListener('click', () => inp.click());
  inp.addEventListener('change', () => { if (inp.files[0]) processUpload(inp.files[0]); });
  document.getElementById('cv-result').classList.add('hidden');
}

// ============================================================
// Modo claro / oscuro + logo dinámico
// ============================================================
function updateLogoForTheme(theme) {
  const img = document.querySelector('.logo-img');
  if (!img) return;
  const src = theme === 'light' ? '/logo.oscuro.png' : '/logo.claro.png';
  img.style.display = '';
  const fallback = img.nextElementSibling;
  if (fallback) fallback.style.display = 'none';
  img.src = src;
}

(function initTheme() {
  const saved = localStorage.getItem('mtd-theme') || 'dark';
  const input = document.getElementById('theme-input');
  const thumb = document.getElementById('toggle-thumb-icon');
  document.documentElement.dataset.theme = saved;
  if (input) input.checked = saved === 'light';
  if (thumb) thumb.textContent = saved === 'light' ? '☀️' : '🌙';
  updateLogoForTheme(saved);
  if (input) input.addEventListener('change', () => {
    const theme = input.checked ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('mtd-theme', theme);
    if (thumb) thumb.textContent = theme === 'light' ? '☀️' : '🌙';
    updateLogoForTheme(theme);
  });
})();

// ============================================================
// Modal "Base de datos" (solo admin)
// ============================================================
function openSheetsModal() {
  document.getElementById('sheets-backdrop').classList.add('open');
  document.getElementById('sheets-modal').classList.add('open');
}
function closeSheetsModal() {
  document.getElementById('sheets-backdrop').classList.remove('open');
  document.getElementById('sheets-modal').classList.remove('open');
}
document.getElementById('sheets-backdrop').addEventListener('click', closeSheetsModal);
document.getElementById('modal-sheets-cancel').addEventListener('click', closeSheetsModal);
document.getElementById('modal-sheets-confirm').addEventListener('click', () => {
  closeSheetsModal();
  if (_sheetsUrl) window.open(_sheetsUrl, '_blank');
  else showToast('GOOGLE_SPREADSHEET_ID no configurado en .env', 'error');
});

// ============================================================
// Filtro procesados / sin procesar
// ============================================================
document.getElementById('process-filter-bar').addEventListener('click', e => {
  const btn = e.target.closest('.pf-btn');
  if (!btn) return;
  processFilter = btn.dataset.pf;
  document.querySelectorAll('.pf-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.pf === processFilter)
  );
  const filtered = applyProcessFilter(allCandidatesState);
  updatePfCount(filtered.length, allCandidatesState.length);
  renderPostuladosTable(filtered);
});

// ============================================================
// Skills popup
// ============================================================
function openSkillsPopup(btn, skills) {
  closeSkillsPopup();
  const popup = document.createElement('div');
  popup.id = 'skills-popup';
  popup.className = 'skills-popup';
  popup.innerHTML = skills.map(s => `<span class="drawer-skill-tag">${escapeHtml(s)}</span>`).join('');
  document.body.appendChild(popup);
  const rect = btn.getBoundingClientRect();
  const left = Math.min(rect.left + window.scrollX, window.innerWidth - 300);
  popup.style.top  = (rect.bottom + window.scrollY + 6) + 'px';
  popup.style.left = left + 'px';
  setTimeout(() => document.addEventListener('click', _closeSkillsOnOutside, { once: true }), 50);
}
function closeSkillsPopup() { document.getElementById('skills-popup')?.remove(); }
function _closeSkillsOnOutside(e) {
  if (!e.target.closest('#skills-popup') && !e.target.closest('.js-skills-more')) closeSkillsPopup();
}

// ============================================================
// Botón "Base de datos" → Google Sheets
// ============================================================
let _sheetsUrl = '';
fetch(`${API}/config`).then(r => r.json()).then(d => { _sheetsUrl = d.sheetsUrl || ''; }).catch(() => {});

document.getElementById('btn-sheets').addEventListener('click', openSheetsModal);

// ============================================================
// Utilidades
// ============================================================
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ============================================================
// Usuario actual y logout
// ============================================================
async function loadCurrentUser() {
  try {
    const res  = await _origFetch('/api/auth/me');
    const data = await res.json();
    if (!data.success) { window.location.href = '/login'; return; }

    const { nombre, rol } = data.user;
    currentUserRole = rol || 'reclutador';

    const initials = nombre.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const chip   = document.getElementById('user-chip');
    const avatar = document.getElementById('user-avatar');
    const nameEl = document.getElementById('user-name');
    const logout = document.getElementById('btn-logout');
    const sheetsBtn = document.getElementById('btn-sheets');

    if (chip)   { chip.style.display   = 'flex'; }
    if (avatar) { avatar.textContent   = initials; }
    if (nameEl) { nameEl.textContent   = nombre.split(' ')[0]; }
    if (logout) { logout.style.display = 'block'; }
    // "Base de datos" solo visible para administradores
    if (sheetsBtn) sheetsBtn.style.display = currentUserRole === 'admin' ? 'inline-flex' : 'none';
  } catch { window.location.href = '/login'; }
}

document.getElementById('btn-logout')?.addEventListener('click', async () => {
  await _origFetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

// ============================================================
// Stage summary para vacancy cards
// ============================================================
let _vacancyStageSummary = {};

function applyStageCountsToCards() {
  for (const [vid, counts] of Object.entries(_vacancyStageSummary)) {
    const el = document.getElementById(`vstages-${vid}`);
    if (!el) continue;
    const parts = [];
    if (counts.procesados    > 0) parts.push(`<span style="color:var(--muted)">⬤ ${counts.procesados} proc.</span>`);
    if (counts.preseleccionados > 0) parts.push(`<span style="color:var(--accent-2)">✦ ${counts.preseleccionados} presel.</span>`);
    if (counts.finalistas    > 0) parts.push(`<span style="color:var(--green)">★ ${counts.finalistas} final.</span>`);
    el.innerHTML = parts.join('');
  }
}

async function loadVacancyStageSummary() {
  try {
    const res  = await fetch(`${API}/sheets/resumen`);
    const json = await res.json();
    if (!json.success) return;
    _vacancyStageSummary = json.data || {};
    applyStageCountsToCards();
  } catch {}
}

// Arranque
loadCurrentUser();
loadClasificaciones();
loadVacancies();
