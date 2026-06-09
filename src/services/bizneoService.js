const axios = require('axios');

const COMPANY_ID = process.env.BIZNEO_COMPANY_ID || '171780';
const BASE_URL = `https://ats.bizneo.com/api/v3/companies/${COMPANY_ID}`;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Token token=${process.env.BIZNEO_API_TOKEN}, user_email=${process.env.BIZNEO_API_EMAIL}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
  timeout: 15000,
});

const PER_PAGE = 25; // Bizneo capa a 25 sin importar lo que se pida

let _vacanciesInFlight = null;

async function getActiveVacancies() {
  // Deduplicación: si ya hay un fetch en vuelo, ambos esperan el mismo Promise
  if (_vacanciesInFlight) return _vacanciesInFlight;
  _vacanciesInFlight = _fetchAllVacancies().finally(() => { _vacanciesInFlight = null; });
  return _vacanciesInFlight;
}

async function _fetchAllVacancies() {
  // Fetch paralelo "optimista": pide 10 páginas a la vez.
  // Para cuando alguna página devuelve menos de PER_PAGE (última página alcanzada).
  const BATCH  = 10;
  let allJobs  = [];
  let pageFrom = 1;

  while (true) {
    const pages   = Array.from({ length: BATCH }, (_, i) => pageFrom + i);
    const results = await Promise.all(
      pages.map(p =>
        client.get('/jobs.json', { params: { per_page: PER_PAGE, page: p } })
          .catch(() => ({ data: { jobs: [] } }))
      )
    );

    let done = false;
    for (const r of results) {
      const jobs = r.data?.jobs || [];
      allJobs    = allJobs.concat(jobs);
      if (jobs.length < PER_PAGE) { done = true; break; }
    }
    if (done) break;
    pageFrom += BATCH;
  }

  return { jobs: allJobs, total: allJobs.length };
}

async function getCandidatesForJob(jobId, page = 1) {
  const response = await client.get(`/jobs/${jobId}/candidates.json`, {
    params: { page, per_page: 50 },
  });
  return response.data;
}

async function getAllCandidatesForJob(jobId) {
  let page = 1;
  let allCandidates = [];

  while (true) {
    const data = await getCandidatesForJob(jobId, page);
    const candidates = data.candidates || data.data || [];
    allCandidates = allCandidates.concat(candidates);

    const totalPages = data.meta?.total_pages || data.total_pages || 1;
    if (page >= totalPages) break;
    page++;
  }

  return allCandidates;
}

async function getJobDetails(jobId) {
  try {
    const r = await client.get(`/jobs/${jobId}.json`);
    return r.data?.job || null;
  } catch (e) {
    console.warn(`[Bizneo] getJobDetails ${jobId}:`, e.response?.status || e.message);
    return null;
  }
}

// userId = user_id del candidato (distinto al id de candidatura)
async function addCandidateNote(userId, message) {
  try {
    await client.post(`/candidates/${userId}/company_notes`, {
      company_note: { note: message },
    });
    return { ok: true };
  } catch (e) {
    const status = e.response?.status;
    console.warn(`[Bizneo] addCandidateNote → HTTP ${status}:`, e.response?.data || e.message);
    return { ok: false, status };
  }
}

async function setCandidateStageTag(userId, newStage) {
  try {
    const patchRes = await client.patch(`/candidates/${userId}/company_tags`, {});
    console.log(`[Bizneo] PATCH company_tags → HTTP ${patchRes.status}`);
    const r = await client.put(`/candidates/${userId}/company_tags/add_company_tags_by_name`, {
      company_tag: { names: [newStage] },
    });
    console.log(`[Bizneo] tag → ${newStage} (${r.status})`);
    return { ok: true };
  } catch (e) {
    const status = e.response?.status;
    console.warn(`[Bizneo] setCandidateStageTag "${newStage}" → HTTP ${status}:`, e.response?.data || e.message);
    return { ok: false, status };
  }
}

async function loadStageTags() {
  // Ya no es necesario precargar IDs — usamos add_company_tags_by_name
  console.log('  Etiquetas Bizneo: usando company_tags por nombre (no requiere precarga)');
}

module.exports = {
  getActiveVacancies,
  getCandidatesForJob,
  getAllCandidatesForJob,
  getJobDetails,
  addCandidateNote,
  loadStageTags,
  setCandidateStageTag,
};
