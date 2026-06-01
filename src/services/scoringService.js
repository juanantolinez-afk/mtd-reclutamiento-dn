// Puntaje por nivel educativo mas alto detectado (0-20)
const LEVEL_SCORE = {
  bachiller:       3,
  curso:           6,
  auxiliar:        9,
  tecnico:        12,
  tecnologo:      14,
  pregrado:       17,
  especializacion:20,
  maestria:       20,
  doctorado:      20,
};

const CITIES_HIGH = [
  'bucaramanga','floridablanca','girón','giron','piedecuesta',
  'sogamoso','duitama','santander',
];

function scoreFormacion(education = []) {
  if (education.length === 0) return 0;
  const max = Math.max(...education.map(e => LEVEL_SCORE[e.level] || 0));
  return max;
}

// Basado en meses totales de experiencia detectada (0-25)
function scoreExperiencia(totalMonths = 0) {
  if (totalMonths <= 0)  return 0;
  if (totalMonths <= 12) return 8;
  if (totalMonths <= 36) return 15;
  if (totalMonths <= 60) return 20;
  return 25;
}

// Bonus por experiencia en salud (0-5) — solo si empresa o cargo son claramente sanitarios
const HC_COMPANY_RE = /(?:cl[ií]nica|clinica|hospital|ips\b|eps\b|centro\s+(?:m[eé]dico|de\s+salud)|laboratorio\s+cl[ií]nico)/i;
const HC_ROLE_RE    = /(?:fisioterapeu?ta|enfermero|enfermera|m[eé]dic[oa]|psic[oó]log|nutricionista|terapeuta\s+(?:f[ií]sic[ao]|respirator|ocupacional)|bacteriólog|fonoaudi[oó]log|instrumentador\s+quir|auxiliar\s+de\s+enfermer)/i;

function scoreHealthcare(experience = []) {
  return experience.some(e =>
    (e.company && HC_COMPANY_RE.test(e.company)) || (e.role && HC_ROLE_RE.test(e.role))
  ) ? 5 : 0;
}

function scoreUbicacion(cityStr = '') {
  const h = cityStr.toLowerCase();
  if (!h.trim()) return 0;
  if (CITIES_HIGH.some(c => h.includes(c))) return 10;
  return 5;
}

function scoreCompletitud(candidate, llmData) {
  const meta = candidate.professional_metadata || {};
  const user = candidate.user_metadata || {};
  const loc  = candidate.location || {};
  let pts = 0;
  if (candidate.email)                pts += 2;
  if (meta.phone)                     pts += 2;
  if (loc.city || loc.province)       pts += 2;
  if (user.birth_date)                pts += 2;
  if (llmData?.education?.length > 0) pts += 2;
  return pts;
}

function classify(score, education, totalMonths) {
  if (education.length === 0 && totalMonths === 0) {
    return { label: 'INCOMPLETO', bg: '#742A2A' };
  }
  if (score >= 40) return { label: 'COMPLETO',   bg: '#22543D' };
  if (score >= 22) return { label: 'REVISAR',    bg: '#744210' };
  return              { label: 'INCOMPLETO',    bg: '#742A2A' };
}

function calculateScore(candidate, llmData) {
  const loc     = candidate.location || {};
  const cityStr = `${loc.city || ''} ${loc.province || ''}`;

  const meta       = candidate.professional_metadata || {};
  const education  = llmData?.education  ?? meta.professional_educations  ?? [];

  const llmExp     = llmData?.experience ?? [];
  const bizneoExp  = meta.professional_experiences ?? [];
  // Para detección de salud: usar LLM si tiene entradas, sino Bizneo (aunque sin fechas)
  // Si Bizneo tiene start_date en sus registros se usaría para calcular duración, pero si no,
  // el total_experience_months de la IA (que puede estimarlo por contexto) es preferible.
  const experience = llmExp.length > 0 ? llmExp : bizneoExp;

  const calcTotal  = llmExp.reduce((s, e) => s + (e.duration_months || 0), 0);
  // Math.max: si IA estimó años por contexto aunque no extrajo entradas específicas, respetar ese valor
  const totalMonths = Math.max(llmData?.total_experience_months || 0, calcTotal);

  const breakdown = {
    formacion:   scoreFormacion(education),
    experiencia: scoreExperiencia(totalMonths),
    healthcare:  scoreHealthcare(experience),
    ubicacion:   scoreUbicacion(cityStr),
    completitud: scoreCompletitud(candidate, llmData),
  };

  // Max: 20 + 25 + 5 + 10 + 10 = 70 → normalizar a 60
  const raw   = Object.values(breakdown).reduce((s, v) => s + v, 0);
  const total = Math.round(Math.min(60, raw * (60 / 70)));

  const classification = classify(total, education, totalMonths);

  return { total, breakdown, classification };
}

module.exports = { calculateScore };
