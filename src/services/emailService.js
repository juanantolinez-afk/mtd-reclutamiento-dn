const { google } = require('googleapis');
const axios      = require('axios');

// Codifica string en RFC 2047 para headers con caracteres UTF-8
function encodeHeaderUTF8(str) {
  const encoded = Buffer.from(str, 'utf-8').toString('base64');
  return `=?UTF-8?B?${encoded}?=`;
}

// ── Gmail API via Service Account + DWD ───────────────────────────────────────
async function _sendViaGmail({ to, subject, html }) {
  const auth = new google.auth.JWT({
    email:   process.env.GMAIL_SA_EMAIL,
    key:     (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n'),
    scopes:  ['https://www.googleapis.com/auth/gmail.send'],
    subject: process.env.GMAIL_IMPERSONATE, // impersonar al reclutador vía DWD
  });

  const gmail = google.gmail({ version: 'v1', auth });
  const from  = process.env.EMAIL_FROM || `Reclutamiento MTD <${process.env.GMAIL_IMPERSONATE}>`;

  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderUTF8(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

// ── Brevo HTTP API (fallback) ─────────────────────────────────────────────────
async function _sendViaBrevo({ to, subject, html }) {
  const raw   = process.env.EMAIL_FROM || 'Reclutamiento MTD <juan.antolinez@mtd.net.co>';
  const match = raw.match(/^(.*?)\s*<(.+)>$/);
  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender:      { name: match ? match[1].trim() : 'MTD', email: match ? match[2].trim() : raw },
    to:          [{ email: to }],
    subject,
    htmlContent: html,
  }, {
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

// ── Función pública: intenta Gmail primero, cae a Brevo ───────────────────────
async function sendMail({ to, subject, html, text }) {
  const body = html || `<p>${text || ''}</p>`;
  if (process.env.GMAIL_SA_EMAIL && process.env.GMAIL_SA_KEY) {
    await _sendViaGmail({ to, subject, html: body });
  } else {
    await _sendViaBrevo({ to, subject, html: body });
  }
}

// ── SMS via Brevo ─────────────────────────────────────────────────────────────
async function sendSMS({ phone, message }) {
  const digits = String(phone).replace(/\D/g, '');
  const intl   = digits.startsWith('57') ? `+${digits}` : `+57${digits}`;
  await axios.post('https://api.brevo.com/v3/transactionalSMS/sms', {
    sender: 'MTD', recipient: intl, content: message, type: 'transactional',
  }, {
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

// ── Plantillas ────────────────────────────────────────────────────────────────
function noContinuaBody({ candidateName, vacancyTitle }) {
  const name  = candidateName || 'candidato/a';
  const cargo = vacancyTitle  || 'la posición';
  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
  <p>Buen día, <strong>${name}</strong>,</p>
  <p>Queremos contarte el resultado del proceso de selección para el cargo de <strong>${cargo}</strong> en <strong>Medicina y Terapias Domiciliarias – MTD</strong>.</p>
  <p>Luego de revisar cuidadosamente todos los perfiles, en esta oportunidad fue seleccionada la persona que mejor se ajustó a los requisitos del cargo. Queremos que sepas que esto no significa que hayas hecho algo mal; en estos procesos solo puede elegirse a una persona entre muchos candidatos valiosos, y la decisión se basa en el ajuste al perfil en ese momento específico.</p>
  <p>Agradecemos sinceramente el tiempo, el interés y el esfuerzo que dedicaste al proceso. Nos alegró mucho conocerte, y conservaremos tu hoja de vida en nuestra base de datos para tenerte en cuenta en futuros procesos donde tu perfil pueda encajar.</p>
  <p>¡Te deseamos muchos éxitos en tu camino profesional!</p>
  <p>Feliz día.</p>
  <p>Cordialmente,<br><strong>Equipo de Reclutamiento MTD</strong><br>Medicina y Terapias Domiciliarias</p>
</div>`.trim();
}

function entrevistaReminderBody({ candidateName, vacancyTitle, fechaEntrevista, diasRestantes }) {
  const cuando = diasRestantes === 0 ? 'HOY' : `en ${diasRestantes} día${diasRestantes > 1 ? 's' : ''}`;
  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
  <p>Hola,</p>
  <p>Recordatorio: tienes una entrevista programada <strong>${cuando}</strong> (${fechaEntrevista}) con <strong>${candidateName}</strong> para el cargo de <strong>${vacancyTitle}</strong>.</p>
  <p>— Sistema MTD Reclutamiento</p>
</div>`.trim();
}

module.exports = { sendMail, sendSMS, noContinuaBody, entrevistaReminderBody };
