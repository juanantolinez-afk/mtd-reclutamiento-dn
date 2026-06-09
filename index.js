require('dotenv').config();
const app             = require('./src/app');
const bizneoService   = require('./src/services/bizneoService');
const cache           = require('./src/utils/cache');
const userService     = require('./src/services/userService');
const sheetsService   = require('./src/services/sheetsService');
const calendarService = require('./src/services/calendarService');

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`\n  MTD Reclutamiento corriendo en http://localhost:${PORT}`);
  console.log(`  Ambiente: ${process.env.NODE_ENV || 'development'}`);

  // Sembrar usuarios, sincronizar hashes y clasificaciones
  await userService.seedDefaultUsers().catch(() => {});
  await userService.syncPasswordHashes().catch(() => {});
  sheetsService.ensureClasificacionesSheet().catch(() => {});
  sheetsService.setupSheetsFormatting().catch(e => console.warn('  [Sheets] Formato:', e.message));

  // Cargar IDs de etiquetas Bizneo (POSTULADO / PRESELECCIONADO / FINALISTA)
  bizneoService.loadStageTags().catch(() => {});

  // Recordatorios de entrevistas — lee fecha_entrevista desde Sheets, sin necesidad de Google Calendar
  const hasEmail = process.env.BREVO_API_KEY || (process.env.GMAIL_SA_EMAIL && process.env.GMAIL_SA_KEY);
  if (hasEmail) {
    async function checkRemindersDynamic() {
      try {
        await calendarService.checkAndSendReminders(sheetsService).catch(() => {});
      } catch (e) {
        console.error('[Recordatorio] Error:', e.message);
      }
      setTimeout(checkRemindersDynamic, 6 * 60 * 60 * 1000); // cada 6 horas
    }
    checkRemindersDynamic();
    console.log('  Recordatorios de entrevistas: activos (basado en Sheets, cada 6h)');
  } else {
    console.log('  Recordatorios: deshabilitados (sin BREVO_API_KEY ni GMAIL configurados)');
  }

  // Pre-calentar caché de vacantes
  console.log('  Precalentando caché de vacantes...');
  try {
    const raw  = await bizneoService.getActiveVacancies();
    const slim = (v) => ({
      id: v.id, title: v.title, friendly_title: v.friendly_title,
      status: v.status, created_at: v.created_at,
      department: v.department, department_translation: v.department_translation,
      contract_type_translation: v.contract_type_translation,
      location: v.locations?.[0]?.city?.name || null,
    });
    const data = { jobs: raw.jobs.map(slim), total: raw.total };
    cache.set('bizneo:vacancies', data);
    console.log(`  Caché listo: ${data.total} vacantes\n`);
  } catch (err) {
    console.warn(`  Advertencia: no se pudo precargar vacantes — ${err.message}\n`);
  }
});
