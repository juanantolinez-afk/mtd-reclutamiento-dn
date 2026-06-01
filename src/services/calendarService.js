const { google } = require('googleapis');
const emailService = require('./emailService');

function _auth() {
  return new google.auth.JWT({
    email:   process.env.GOOGLE_CLIENT_EMAIL,
    key:     (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes:  ['https://www.googleapis.com/auth/calendar'],
  });
}

// El ID del calendario del reclutador (debe haber compartido su calendar con el service account)
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

async function createInterviewEvent({ candidateName, candidateEmail, recruiterEmail, startDateTime, endDateTime, vacancyTitle }) {
  const calendar = google.calendar({ version: 'v3', auth: _auth() });

  // Se crea en el calendario del service account (primary).
  // Sin attendees: el service account no tiene DWD para invitar.
  // El reclutador recibe el link del evento para abrirlo y agregar invitados manualmente.
  const event = {
    summary:     `Entrevista · ${candidateName} · ${vacancyTitle || ''}`,
    description: `Candidato: ${candidateName}\nEmail: ${candidateEmail}\nVacante: ${vacancyTitle || ''}\nReclutador: ${recruiterEmail || ''}`,
    start: { dateTime: startDateTime, timeZone: 'America/Bogota' },
    end:   { dateTime: endDateTime,   timeZone: 'America/Bogota' },
    reminders: { useDefault: true },
  };

  const res = await calendar.events.insert({ calendarId: 'primary', requestBody: event });
  return res.data;
}

async function getUpcomingInterviews() {
  const calendar = google.calendar({ version: 'v3', auth: _auth() });
  const now      = new Date();
  const in3Days  = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId:   'primary',
    timeMin:      now.toISOString(),
    timeMax:      in3Days.toISOString(),
    singleEvents: true,
    orderBy:      'startTime',
    q:            'Entrevista ·',
  });
  return res.data.items || [];
}

// Verifica entrevistas próximas y envía recordatorios por email
async function checkAndSendReminders(sheetsService) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  try {
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!calendarId) return;

    const events = await getUpcomingInterviews();
    const today  = new Date();
    today.setHours(0, 0, 0, 0);

    for (const ev of events) {
      const start = new Date(ev.start?.dateTime || ev.start?.date);
      if (isNaN(start)) continue;

      start.setHours(0, 0, 0, 0);
      const diffDays = Math.round((start - today) / (1000 * 60 * 60 * 24));
      if (![0, 1, 2].includes(diffDays)) continue;

      const candidateName = (ev.summary || '').replace('Entrevista · ', '').split(' · ')[0];
      const vacancyTitle  = (ev.summary || '').split(' · ')[1] || '';
      const fechaStr      = new Date(ev.start?.dateTime || ev.start?.date)
        .toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' });

      const recruiterEmail = ev.organizer?.email || process.env.SMTP_USER;

      await emailService.sendMail({
        to:      recruiterEmail,
        subject: `Recordatorio entrevista ${diffDays === 0 ? 'HOY' : `en ${diffDays} día${diffDays > 1 ? 's' : ''}`} · ${candidateName}`,
        html:    emailService.entrevistaReminderBody({ candidateName, vacancyTitle, fechaEntrevista: fechaStr, diasRestantes: diffDays }),
        text:    `Recordatorio: entrevista con ${candidateName} el ${fechaStr}`,
      });

      console.log(`[Calendar] Recordatorio enviado a ${recruiterEmail} para entrevista con ${candidateName} (en ${diffDays} días)`);
    }
  } catch (e) {
    console.warn('[Calendar] checkAndSendReminders:', e.message);
  }
}

module.exports = { createInterviewEvent, getUpcomingInterviews, checkAndSendReminders };
