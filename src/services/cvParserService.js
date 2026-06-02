const pdfParse      = require('pdf-parse');
const mammoth       = require('mammoth');
const WordExtractor = require('word-extractor');
const axios         = require('axios');

// ─── Extracción de texto ──────────────────────────────────────────────────────

async function extractTextFromBuffer(buffer) {
  const data = await pdfParse(buffer);
  return data.text || '';
}

async function downloadAndExtractCV(url) {
  const headers = { Accept: 'application/pdf,application/octet-stream,*/*' };
  if (url.includes('bizneo.com')) {
    headers['Authorization'] =
      `Token token=${process.env.BIZNEO_API_TOKEN}, user_email=${process.env.BIZNEO_API_EMAIL}`;
  }

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers,
    maxRedirects: 5,
  });

  const buffer      = Buffer.from(response.data);
  const contentType = (response.headers['content-type'] || '').toLowerCase();
  const rawName     = url.split('?')[0].split('/').pop().toLowerCase();

  const isDocx = contentType.includes('wordprocessingml') ||
                 contentType.includes('msword') ||
                 rawName.endsWith('.docx') ||
                 rawName.endsWith('.doc');

  if (isDocx) {
    const isOldDoc = rawName.endsWith('.doc') && !rawName.endsWith('.docx');
    const wordMime = isOldDoc
      ? 'application/msword'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    let text = '';

    if (isOldDoc) {
      // .doc (formato binario antiguo) — word-extractor
      try {
        const extractor = new WordExtractor();
        const doc       = await extractor.extract(buffer);
        text = doc.getBody() || '';
      } catch (_) {}
      // fallback: intenta con mammoth por si es un .doc guardado como docx
      if (text.trim().length <= 30) {
        try {
          const r = await mammoth.extractRawText({ buffer });
          if (r.value && r.value.trim().length > 30) text = r.value;
        } catch (_) {}
      }
    } else {
      // .docx (Office Open XML) — mammoth
      try {
        const result = await mammoth.extractRawText({ buffer });
        if (result.value && result.value.trim().length > 30) text = result.value;
      } catch (_) {}
    }
    return { text, buffer, wordMime };
  }

  const text = await extractTextFromBuffer(buffer);
  return { text, buffer, wordMime: null };
}

// ─── Preprocesado de texto ────────────────────────────────────────────────────

function preprocessText(text) {
  return text
    .replace(/\f/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

const SECTION_PATTERNS = [
  { name: 'educacion',   re: /(?:^|\n)\s*(?:educaci[oó]n|formaci[oó]n\s+acad[eé]mica?|formaci[oó]n\s+profesional|estudios?(?:\s+realizados?)?|t[ií]tulos?\s+obtenidos?)\s*\n/im },
  { name: 'experiencia', re: /(?:^|\n)\s*(?:experiencia(?:\s+(?:laboral|profesional|de\s+trabajo))?|trayectoria\s+laboral|historial\s+laboral|cargos?\s+desempe[nñ]ados?)\s*\n/im },
  { name: 'habilidades', re: /(?:^|\n)\s*(?:habilidades?|competencias?|aptitudes?|destrezas?|conocimientos?)\s*\n/im },
  { name: 'referencias', re: /(?:^|\n)\s*(?:referencias?\s+(?:personales?|laborales?|profesionales?))\s*\n/im },
  { name: 'perfil',      re: /(?:^|\n)\s*(?:perfil|perfil\s+profesional|objetivo\s+profesional|resumen|sobre\s+m[ií])\s*\n/im },
];

function splitIntoSections(text) {
  const allHits = [];
  for (const sp of SECTION_PATTERNS) {
    const re = new RegExp(sp.re.source, 'gim');
    let m;
    while ((m = re.exec(text)) !== null) {
      allHits.push({ name: sp.name, index: m.index, headerLen: m[0].length });
    }
  }
  allHits.sort((a, b) => a.index - b.index);

  const byName = {};
  for (const h of allHits) {
    if (!byName[h.name]) byName[h.name] = [];
    byName[h.name].push(h);
  }

  const chosen = {};
  for (const [name, hits] of Object.entries(byName)) {
    let best = hits[0], bestLen = 0;
    for (const h of hits) {
      const nextAny = allHits.find(x => x.index > h.index + h.headerLen);
      const approxEnd = nextAny ? nextAny.index : text.length;
      const len = approxEnd - (h.index + h.headerLen);
      if (len > bestLen) { bestLen = len; best = h; }
    }
    chosen[name] = best;
  }

  if (byName.educacion && byName.educacion.length > 1) {
    const eduParts = byName.educacion.map(h => {
      const nextAny = allHits.find(x => x.index > h.index + h.headerLen && x.name !== 'educacion');
      const end = nextAny ? nextAny.index : text.length;
      return text.slice(h.index + h.headerLen, end);
    });
    chosen.educacion._merged = eduParts.join('\n');
  }

  const hits = Object.values(chosen).sort((a, b) => a.index - b.index);
  const sections = {};
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index + hits[i].headerLen;
    const end   = i + 1 < hits.length ? hits[i + 1].index : text.length;
    let content = text.slice(start, end);
    if (hits[i].name === 'educacion' && hits[i]._merged) content = hits[i]._merged;
    if (content.trim().length > 30) sections[hits[i].name] = content;
  }

  if (!sections.experiencia) sections.experiencia = text;
  if (!sections.educacion)   sections.educacion   = text;
  return sections;
}

// ─── Extractor de educación ───────────────────────────────────────────────────

const DEGREE_PATTERNS = [
  { re: /auxiliar\s+(?:de\s+)?enfermer[ií]a/i,                         level: 'auxiliar' },
  { re: /auxiliar\s+(?:de\s+)?\w+/i,                                   level: 'auxiliar' },
  { re: /t[eé]cnic[oa]\s+(?:en\s+)?\w[\w\s]{2,40}/i,                  level: 'tecnico' },
  { re: /tecn[oó]log[oa]\s+(?:en\s+)?\w[\w\s]{2,40}/i,                level: 'tecnologo' },
  { re: /especializ(?:aci[oó]n|ado|ada)\s+(?:en\s+)?\w[\w\s]{2,50}/i, level: 'especializacion' },
  { re: /mag[ií]ster\s+(?:en\s+)?\w[\w\s]{2,50}/i,                    level: 'maestria' },
  { re: /maest(?:r[ií]a|ro|ra)\s+(?:en\s+)?\w[\w\s]{2,50}/i,         level: 'maestria' },
  { re: /doctorado?\s+(?:en\s+)?\w[\w\s]{2,50}/i,                     level: 'doctorado' },
  { re: /licenciad[oa]\s+(?:en\s+)?\w[\w\s]{2,50}/i,                  level: 'pregrado' },
  { re: /profesional\s+en\s+\w[\w\s]{2,50}/i,                          level: 'pregrado' },
  { re: /ingenier[ií]a\s+\w[\w\s]{2,40}/i,                             level: 'pregrado' },
  { re: /administraci[oó]n\s+(?:de\s+)?\w[\w\s]{2,40}/i,              level: 'pregrado' },
  { re: /contadur[ií]a\s+p[uú]blica/i,                                 level: 'pregrado' },
  { re: /derecho\b/i,                                                   level: 'pregrado' },
  { re: /^(?:fisioterapeu?ta|enfermero|enfermera|m[eé]dic[oa]|psic[oó]log[oa]|nutricionista|odont[oó]log[oa]|fonoaudi[oó]log[oa]|bacteriólog[oa]|instrumentador\s+quir[uú]rgico|terapeuta\s+(?:respiratorio|ocupacional)|trabajador[a]?\s+social|regente\s+de\s+farmacia|cuidador[a]?)$/im, level: 'pregrado' },
  { re: /fisioterapia/i,       level: 'pregrado' },
  { re: /enfermer[ií]a/i,      level: 'pregrado' },
  { re: /medicina\b/i,         level: 'pregrado' },
  { re: /psicolog[ií]a/i,      level: 'pregrado' },
  { re: /nutrici[oó]n/i,       level: 'pregrado' },
  { re: /odontolog[ií]a/i,     level: 'pregrado' },
  { re: /fonoaudiolog[ií]a/i,  level: 'pregrado' },
  { re: /terapia\s+(?:respiratoria|ocupacional)/i, level: 'pregrado' },
  { re: /bacteriolog[ií]a/i,   level: 'pregrado' },
  { re: /bachiller(?:ato)?/i,  level: 'bachiller' },
  { re: /sena\b/i,             level: 'curso' },
  { re: /diplomado\s+\w[\w\s]{2,60}/i,                          level: 'curso' },
  { re: /curso\s+(?:de\s+|especial\s+en\s+)?\w[\w\s]{2,60}/i,  level: 'curso' },
  { re: /certificaci[oó]n\s+\w[\w\s]{2,60}/i,                   level: 'curso' },
];

const INSTITUTION_RE = /(?:universidad|universitaria|polit[eé]cnico|fundaci[oó]n\s+universitaria|instituci[oó]n\s+universitaria|colegio|escuela\s+superior|sena|corporaci[oó]n|instituto)[^,\n.]{0,60}/i;

function extractEducation(eduText) {
  const found = [], seen = new Set();
  const lines = eduText.split(/\n/).map(l => l.trim()).filter(l => l.length > 3);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 120) continue;
    for (const dp of DEGREE_PATTERNS) {
      const m = line.match(dp.re);
      if (!m) continue;
      const degree = line.length < 80 ? line : m[0];
      const key = degree.toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
      if (seen.has(key)) break;
      seen.add(key);
      const ctx   = lines.slice(Math.max(0, i - 2), i + 4).join(' ');
      const instM = ctx.match(INSTITUTION_RE);
      const institution = instM ? instM[0].trim().replace(/\s*(?:19|20)\d{2}.*$/, '').trim() : null;
      const yearM = ctx.match(/(?:19|20)\d{2}/);
      const year  = yearM ? yearM[0] : null;
      const cleanDegree = degree.replace(/\s+/g, ' ').trim().replace(/^[^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]+/, '');
      found.push({ degree: cleanDegree, institution, year, level: dp.level });
      break;
    }
  }
  return found.slice(0, 10);
}

// ─── Extractor de experiencia ─────────────────────────────────────────────────

const _MES  = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic';
const _MSEP = '(?:\\s*de[l]?\\s+|\\s*[\\/\\-]\\s*|\\.+\\s*|\\s+)';
const _DATE = `(?:(?:el\\s+)?\\d{1,2}\\s*(?:de\\s+|[\\s\\/\\-]\\s*))?(?:${_MES})${_MSEP}(?:19|20)\\d{2}|(?:19|20)\\d{2}`;
const _OPEN = 'actual(?:mente)?|presente|vigente|la\\s+fecha|a\\s+la\\s+fecha|hoy';
const YEAR_RANGE_RE = new RegExp(
  `(?:${_DATE})(?:\\s*[-–—\\/]\\s*|\\s+(?:a|al|hasta(?:\\s+el)?)\\s+)(?:${_DATE}|${_OPEN})`,
  'gi'
);

function parseYearRange(str) {
  const now  = new Date().getFullYear();
  const nums = str.match(/(?:19|20)\d{2}/g) || [];
  const startY = parseInt(nums[0]) || null;
  if (!startY || startY < 1970 || startY > now) return null;
  const isOpen = /actual|presente|vigente|fecha|hoy/.test(str.toLowerCase());
  const endY   = isOpen ? now : (parseInt(nums[1]) || now);
  if (endY < startY || endY > now + 1) return null;
  return { startY, endY, months: Math.max(1, Math.min(120, (endY - startY) * 12)) };
}

function extractExperience(expText) {
  const results = [];
  const re = new RegExp(YEAR_RANGE_RE.source, 'gi');
  const roleRe         = /(?:^|\b)(fisioterapeu?ta|enfermero|enfermera|m[eé]dic[oa]|psic[oó]log|nutricionista|auxiliar|terapeuta|cuidador|instrumentador|bacteriólog|fonoaudi[oó]log|coordinador|jefe\s+de|director|supervisor|profesional|t[eé]cnic[oa]|tecnólog[oa]|ingenier[oa]|contador|administrador|promotor|asesor|analista|gestor|operador)\b/i;
  const supervisorRe   = /(?:jefe\s+inmediato|supervisor\s+inmediato|nombre\s+del\s+jefe|reporta\s+a|supervisad[ao]\s+por)/i;
  const rolePrefixRe   = /^(?:cargo|posici[oó]n|rol|puesto|funci[oó]n)\s*:?\s*/i;
  const companyRe      = /(?:cl[ií]nica|clinica|hospital|ips\b|eps\b|fundaci[oó]n\s+(?!universitaria)[a-záéíóúü]{3,}|centro\s+(?:m[eé]dico|de\s+salud)|laboratorio|empresa\b|s\.?a\.?s?\.?\b|ltda\.?\b|medicina\s+y\s+terapias|mtd\b)/i;

  let m;
  while ((m = re.exec(expText)) !== null) {
    const range = parseYearRange(m[0]);
    if (!range) continue;
    const ctx = expText.slice(Math.max(0, m.index - 400), m.index + 300);
    const ctxLines = ctx.split('\n').map(l => l.trim()).filter(l => l.length > 2);
    let role = null;
    for (const ln of ctxLines) {
      if (ln.length < 80 && roleRe.test(ln) && !supervisorRe.test(ln)) {
        role = ln.replace(/^[^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]+/, '').replace(rolePrefixRe, '').replace(/\s+/g, ' ').trim();
        break;
      }
    }
    let company = null;
    for (const ln of ctxLines) {
      if (ln.length < 100 && companyRe.test(ln)) {
        const cleaned = ln
          .replace(/^[^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]+/, '')
          .replace(/^(?:empresa|instituci[oó]n|empleador)\s*:?\s*/i, '')
          .replace(/\s+/g, ' ').trim();
        if (cleaned.length > 2) { company = cleaned; break; }
      }
    }
    results.push({ role: role || null, company: company || null, duration_months: range.months, startY: range.startY, endY: range.endY });
  }

  const unique = [];
  for (const r of results) {
    const dup = unique.some(u => {
      const overlap = Math.max(0, (Math.min(u.endY, r.endY) - Math.max(u.startY, r.startY)) * 12);
      if (overlap > 6) return true;
      const uCo = (u.company || '').toLowerCase().slice(0, 15);
      const rCo = (r.company || '').toLowerCase().slice(0, 15);
      return (uCo || rCo) && Math.abs(u.duration_months - r.duration_months) <= 3 && uCo === rCo;
    });
    if (!dup) unique.push(r);
  }
  return unique.slice(0, 10).map(({ startY, endY, ...rest }) => rest);
}

function extractExperienceTiempoLaborado(text) {
  const results = [];
  const tiempoRe  = /TIEMPO\s+LABORAD[OA]?\s*:?\s*(\d+)\s*(MES(?:ES)?|A[ÑN]OS?|D[ÍI]AS?|DIAS?)/gi;
  const entidadRe = /ENTIDAD\s*:\s*(.+?)(?=\s{3,}|CARGO[\s:]|JEFE[\s:]|TIEMPO[\s:]|[\n]|$)/i;
  const cargoRe   = /CARGO\s+(?:QUE\s+)?DESEMPE[ÑN][OA]?\s*:?\s*(.+?)(?=\s{3,}|TIEMPO[\s:]|JEFE[\s:]|[\n]|$)/i;
  let m;
  while ((m = tiempoRe.exec(text)) !== null) {
    const cantidad = parseInt(m[1]);
    const unidad   = m[2].toUpperCase();
    const months   = /^A[ÑN]/.test(unidad) ? cantidad * 12 : /^D/.test(unidad) ? Math.max(1, Math.round(cantidad / 30)) : cantidad;
    if (months <= 0 || months > 120) continue;
    const ctxBefore = text.slice(Math.max(0, m.index - 350), m.index);
    results.push({
      role:            ctxBefore.match(cargoRe)?.[1]?.trim() || null,
      company:         ctxBefore.match(entidadRe)?.[1]?.trim() || null,
      duration_months: months,
    });
  }
  const seen = new Set();
  return results.filter(r => {
    const key = `${(r.company || '').slice(0, 20)}|${r.duration_months}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 10);
}

// ─── Auxiliares ───────────────────────────────────────────────────────────────

const COLOMBIAN_CITIES = [
  'bogotá','bogota','medellín','medellin','cali','barranquilla','bucaramanga','cartagena',
  'cúcuta','cucuta','pereira','manizales','ibagué','ibague','santa marta','villavicencio',
  'pasto','montería','monteria','neiva','armenia','sincelejo','popayán','popayan','valledupar',
  'tunja','floridablanca','girón','giron','piedecuesta','sogamoso','duitama',
  'bello','itagüí','itagui','envigado','rionegro','soledad',
];

function extractCity(text) {
  const lower = text.toLowerCase();
  for (const c of COLOMBIAN_CITIES) {
    if (new RegExp('\\b' + c.replace(' ', '\\s+') + '\\b').test(lower)) {
      return c.charAt(0).toUpperCase() + c.slice(1).replace(/\s+/g, ' ');
    }
  }
  return null;
}

const HEALTH_SKILLS_LIST = [
  'ventilación mecánica','soporte vital','cuidado intensivo','uci','urgencias',
  'hospitalización','atención domiciliaria','terapia respiratoria','terapia física',
  'manejo de heridas','curaciones','sondas','glucometría','administración de medicamentos',
  'signos vitales','electrocardiograma','primeros auxilios','rcp','rehabilitación',
  'trabajo en equipo','liderazgo','comunicación asertiva','paciente ventilado','gases arteriales',
];

function extractSkills(text) {
  const lower = text.toLowerCase();
  return HEALTH_SKILLS_LIST.filter(s => lower.includes(s)).slice(0, 10);
}

// ─── Parser heurístico ────────────────────────────────────────────────────────

function parseCVHeuristic(cvText) {
  if (!cvText || cvText.trim().length < 30) return null;
  const text     = preprocessText(cvText);
  const sections = splitIntoSections(text);
  const eduSection = extractEducation(sections.educacion);
  const eduFull    = sections.educacion !== text ? extractEducation(text) : [];
  const education  = eduSection.length >= eduFull.length ? eduSection : eduFull;
  const experience = extractExperience(text);
  const finalExp   = experience.length > 0 ? experience : extractExperienceTiempoLaborado(text);
  const skills     = extractSkills(text);
  const city       = extractCity(text);
  const totalMonths = Math.min(300, finalExp.reduce((s, e) => s + (e.duration_months || 0), 0));
  return { education, experience: finalExp, skills, city, total_experience_months: totalMonths };
}

// ─── OpenRouter ───────────────────────────────────────────────────────────────

const SECTION_HEADER_RE = /^(DATOS\s+PERSONALES?|FORMACI[OÓ]N\s+(?:ACAD[EÉ]MICA?|PROFESIONAL)|EDUCACI[OÓ]N|EXPERIENCIA\s+(?:LABORAL|PROFESIONAL|DE\s+TRABAJO)?|TRAYECTORIA\s+LABORAL|HABILIDADES?|COMPETENCIAS?|APTITUDES?|REFERENCIAS?(?:\s+(?:PERSONALES?|LABORALES?|PROFESIONALES?))?|PERFIL(?:\s+PROFESIONAL)?|OBJETIVO(?:\s+PROFESIONAL)?|RESUMEN|CURSOS?\s*(?:Y\s*CERTIFICACIONES?)?|IDIOMAS?|LOGROS?|SOBRE\s+M[IÍ])$/i;

function preprocessToMarkdown(text) {
  const lines = text.split('\n');
  const result = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { result.push(''); continue; }
    if (SECTION_HEADER_RE.test(t) && t.length <= 50) {
      result.push('', `## ${t.toUpperCase()}`, '');
      continue;
    }
    const kvM = t.match(/^([A-ZÁÉÍÓÚÜÑ][A-Za-záéíóúüñ\s]{1,35})\s*:\s*(.+)$/);
    if (kvM && t.length < 120) { result.push(`**${kvM[1].trim()}:** ${kvM[2].trim()}`); continue; }
    result.push(t);
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const LEVEL_MAP = {
  bachiller: 'bachiller', secundaria: 'bachiller', bachillerato: 'bachiller',
  curso: 'curso', capacitacion: 'curso', diplomado: 'curso', certificacion: 'curso',
  auxiliar: 'auxiliar',
  tecnico: 'tecnico', 'técnico': 'tecnico',
  tecnologo: 'tecnologo', 'tecnólogo': 'tecnologo',
  pregrado: 'pregrado', profesional: 'pregrado', licenciatura: 'pregrado', undergraduate: 'pregrado',
  especializacion: 'especializacion', 'especialización': 'especializacion', especialidad: 'especializacion',
  maestria: 'maestria', 'maestría': 'maestria', master: 'maestria',
  doctorado: 'doctorado', phd: 'doctorado',
};

function normalizeLLMOutput(raw) {
  const education = (raw.education || raw.educacion || []).map(e => ({
    degree:      String(e.degree || e.titulo || e.title || '').slice(0, 100),
    institution: e.institution || e.institucion || null,
    year:        e.year || e.año || null,
    level:       LEVEL_MAP[(e.level || e.nivel || '').toLowerCase().replace(/\s+/g, '')] || 'curso',
  })).filter(e => e.degree);

  const experience = (raw.experience || raw.experiencia || []).map(e => ({
    role:            e.role || e.cargo || null,
    company:         e.company || e.empresa || null,
    duration_months: Math.min(120, Math.max(1, Number(e.duration_months || e.meses || 1))),
  })).filter(e => e.role || e.company);

  const totalMonths = Math.min(300,
    Number(raw.total_experience_months || raw.total_meses || 0) ||
    experience.reduce((s, e) => s + (e.duration_months || 0), 0)
  );

  return {
    education,
    experience,
    skills:                 (raw.skills || raw.habilidades || []).slice(0, 15).map(String),
    city:                   raw.city || raw.ciudad || null,
    total_experience_months: totalMonths,
    birth_date:             raw.birth_date || raw.fecha_nacimiento || null,
    age:                    Number(raw.age || raw.edad || 0) || null,
    _via_llm: true,
  };
}

const CV_PROMPT = `Eres un extractor experto de hojas de vida colombianas. Devuelves ÚNICAMENTE JSON válido, sin texto adicional, sin bloques de código markdown.

Extrae toda la información de esta hoja de vida con máxima precisión.

REGLAS:
1. Extrae TODOS los títulos, cursos, diplomados y certificaciones.
2. Para cada trabajo: cargo exacto, empresa exacta y duración en meses.
   - "6 meses" → 6  |  "1 año" → 12  |  "1 año 6 meses" → 18  |  "2 años" → 24
   - Rango "ene 2020 - dic 2021" → calcula los meses exactos (24 en este caso)
   - "TIEMPO LABORADO: X MESES" → usa X directamente
   - Sin duración clara: estima mínimo 6 meses por trabajo mencionado
3. total_experience_months: suma de todos los meses sin contar superposiciones evidentes.
4. skills: habilidades técnicas, blandas, software, herramientas, idiomas, conocimientos clínicos.
5. city: ciudad de residencia actual del candidato.
6. Niveles: "último semestre"/"en curso" → pregrado; Sena técnico → tecnico; Sena tecnólogo → tecnologo; Diplomado → curso.

CASO ESPECIAL: Si el documento está completamente vacío, es ilegible o no contiene información de hoja de vida, devuelve ÚNICAMENTE:
{"unreadable": true, "reason": "descripción breve"}

RESPONDE SOLO con este JSON (sin texto extra, sin \`\`\`json):
{
  "education": [{"degree":"string","institution":"string|null","year":"string|null","level":"bachiller|auxiliar|curso|tecnico|tecnologo|pregrado|especializacion|maestria|doctorado"}],
  "experience": [{"role":"string|null","company":"string|null","duration_months":number}],
  "skills": ["string"],
  "city": "string|null",
  "total_experience_months": number,
  "birth_date": "YYYY-MM-DD|null",
  "age": number|null
}`;

const NETWORK_ERRORS = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED', 'EPIPE']);

async function callOpenRouter(cvText) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const model    = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const mdText   = preprocessToMarkdown(cvText);
  const truncated = mdText.slice(0, 12000);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model,
          messages: [{ role: 'user', content: `${CV_PROMPT}\n\nHOJA DE VIDA:\n${truncated}` }],
          temperature: 0.1,
          max_tokens: 4096,
        },
        { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 60000 }
      );
      return res.data?.choices?.[0]?.message?.content || '';
    } catch (e) {
      const status = e.response?.status;
      const meta   = e.response?.data?.error?.metadata;
      const errMsg = e.response?.data?.error?.message || e.message || '';
      const isNet  = NETWORK_ERRORS.has(e.code || '') || errMsg.includes('timeout');
      const is429  = status === 429;
      if ((isNet || is429) && attempt < 3) {
        const retryAfter = meta?.retry_after_seconds;
        const waitMs = is429
          ? (retryAfter ? Math.ceil(retryAfter) * 1000 + 2000 : 20000)
          : 5000;
        console.warn(`[OpenRouter] intento ${attempt} — ${is429 ? '429' : 'red'} — esperando ${Math.round(waitMs/1000)}s`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
}

// ─── Parser principal ─────────────────────────────────────────────────────────

async function parseCVWithLLM(cvInput) {
  const isObj = cvInput && typeof cvInput === 'object' && !Buffer.isBuffer(cvInput);
  const text  = isObj ? (cvInput.text || '') : (cvInput || '');

  if (!process.env.OPENROUTER_API_KEY) return null;
  if (text.trim().length <= 100) return null;

  try {
    const raw = await callOpenRouter(text);
    if (!raw) return null;

    const clean  = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(clean);

    if (parsed.unreadable) {
      return { _unreadable: true, _reason: parsed.reason || 'ilegible', _via_llm: true };
    }

    return { ...normalizeLLMOutput(parsed), _via_llm: true };
  } catch (e) {
    console.error('[LLM] Fallo:', e.response?.data?.error?.message || e.message);
    return null;
  }
}

// Elimina etiquetas HTML para limpiar descripción de vacante
function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// Evalúa qué tan bien un candidato encaja con la descripción de la vacante
// Devuelve un número 0-100 o null si no se puede evaluar
async function scoreMatchWithVacancy(candidateProfile, vacancyDescription) {
  if (!process.env.OPENROUTER_API_KEY) return null;
  if (!vacancyDescription || vacancyDescription.trim().length < 80) return null;

  const profile = {
    formacion:    (candidateProfile.education  || []).map(e => `${e.level}: ${e.degree}`).join('; '),
    experiencia:  (candidateProfile.experience || []).map(e => `${e.role} en ${e.company} (${e.duration_months}m)`).join('; '),
    habilidades:  (candidateProfile.skills     || []).join(', '),
    ciudad:       candidateProfile.city || '',
    meses_exp:    candidateProfile.total_experience_months || 0,
  };

  const prompt = `Eres un reclutador de salud domiciliaria en Colombia. Evalúa qué tan bien encaja el candidato con la vacante.

DESCRIPCIÓN DE LA VACANTE:
${vacancyDescription.slice(0, 2000)}

PERFIL DEL CANDIDATO:
- Formación: ${profile.formacion || 'No especificada'}
- Experiencia: ${profile.experiencia || 'No especificada'} (Total: ${profile.meses_exp} meses)
- Habilidades: ${profile.habilidades || 'No especificadas'}
- Ciudad: ${profile.ciudad || 'No especificada'}

Evalúa del 0 al 100 qué tan bien cumple el candidato los requisitos de la vacante:
0-30: No cumple requisitos mínimos
31-55: Cumple parcialmente
56-75: Buena coincidencia
76-100: Excelente coincidencia

RESPONDE SOLO con este JSON (sin texto extra, sin \`\`\`):
{"score": number, "explicacion": "Una o dos frases específicas que expliquen el puntaje: qué cumple y qué falta del candidato respecto a la vacante."}`;

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model  = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      { model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 200 },
      { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 30000 }
    );
    const raw    = res.data?.choices?.[0]?.message?.content || '';
    const clean  = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(clean);
    const score  = parseInt(parsed.score);
    if (isNaN(score)) return null;
    return { score: Math.max(0, Math.min(100, score)), explicacion: parsed.explicacion || '' };
  } catch {
    return null;
  }
}

module.exports = {
  downloadAndExtractCV,
  parseCVWithLLM,
  scoreMatchWithVacancy,
  stripHtml,
};
