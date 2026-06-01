const calendarService = require('./calendarService');

let schedulerRunning = false;

// Inicia el scheduler de recordatorios cada 1 hora
function startReminderScheduler(sheetsService) {
  if (schedulerRunning) return;
  schedulerRunning = true;

  // Ejecutar inmediatamente al iniciar
  checkRemindersNow(sheetsService);

  // Luego cada 1 hora
  setInterval(() => checkRemindersNow(sheetsService), 60 * 60 * 1000);

  console.log('[Scheduler] Iniciado — verificará recordatorios cada 1 hora');
}

async function checkRemindersNow(sheetsService) {
  try {
    await calendarService.checkAndSendReminders(sheetsService);
  } catch (e) {
    console.error('[Scheduler] Error al verificar recordatorios:', e.message);
  }
}

module.exports = { startReminderScheduler };
