const emailService = require('./emailService');

// Evita enviar el mismo recordatorio más de una vez por ejecución del servidor
const _sent = new Set();

async function checkAndSendReminders(sheetsService) {
  try {
    const upcoming = await sheetsService.getCandidatesWithUpcomingInterviews(2);
    const recruiterEmail = process.env.GMAIL_IMPERSONATE;
    if (!recruiterEmail) return;

    for (const c of upcoming) {
      const key = `${c.candidato_id}_${c.fecha_entrevista}_${c.diffDays}`;
      if (_sent.has(key)) continue;

      await emailService.sendMail({
        to:      recruiterEmail,
        subject: `Recordatorio entrevista ${c.diffDays === 0 ? 'HOY' : `en ${c.diffDays} día${c.diffDays > 1 ? 's' : ''}`} · ${c.nombre}`,
        html:    emailService.entrevistaReminderBody({
          candidateName:    c.nombre,
          vacancyTitle:     c.vacante_nombre,
          fechaEntrevista:  c.fecha_entrevista,
          diasRestantes:    c.diffDays,
        }),
      });

      _sent.add(key);
      console.log(`[Recordatorio] Enviado a ${recruiterEmail} — ${c.nombre} (en ${c.diffDays} días)`);
    }
  } catch (e) {
    console.warn('[Recordatorio] checkAndSendReminders:', e.message);
  }
}

module.exports = { checkAndSendReminders };
