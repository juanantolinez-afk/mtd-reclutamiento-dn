const { webcrypto } = require('crypto');
const axios = require('axios');

const _cache = new Map();

// Obtiene un access token de Google usando WebCrypto para firmar el JWT.
// webcrypto.subtle.importKey('pkcs8', ...) usa una ruta interna diferente a
// crypto.createPrivateKey(), evitando el error de DECODER de OpenSSL 3.
async function getGoogleAccessToken(scopes) {
  const scopeKey = Array.isArray(scopes) ? scopes.join(' ') : scopes;
  const cached   = _cache.get(scopeKey);
  if (cached && Date.now() < cached.expiry - 60000) return cached.token;

  const email  = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  const rawRaw = process.env.GOOGLE_PRIVATE_KEY || '';

  // Limpiar comillas externas y convertir \n literales a newlines reales
  const rawKey = rawRaw.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');

  // Extraer base64 puro: filtrar headers y quitar cualquier char no-base64
  // (\r embebido en el medio de una línea no lo elimina .trim(), sí este replace)
  const base64 = rawKey
    .split('\n')
    .filter(l => l && !l.startsWith('-----'))
    .map(l => l.trim())
    .join('')
    .replace(/[^A-Za-z0-9+/=]/g, '');

  const derBuf = Buffer.from(base64, 'base64');

  // Calcular longitud exacta del DER desde la cabecera SEQUENCE de ASN.1.
  // Node.js 20 WebCrypto es estricto: rechaza bytes sobrantes al final del buffer.
  // Node.js 24 es permisivo, por eso funcionaba local pero no en Railway (v20.20.2).
  let derLen = derBuf.length;
  if (derBuf[0] === 0x30 && derBuf[1] === 0x82) {
    derLen = 4 + ((derBuf[2] << 8) | derBuf[3]);
  } else if (derBuf[0] === 0x30 && derBuf[1] === 0x81) {
    derLen = 3 + derBuf[2];
  } else if (derBuf[0] === 0x30) {
    derLen = 2 + (derBuf[1] & 0x7f);
  }

  // Slice a ArrayBuffer independiente del tamaño exacto
  const trimmed = derBuf.slice(0, derLen);
  const der = trimmed.buffer.slice(trimmed.byteOffset, trimmed.byteOffset + trimmed.byteLength);

  // Importar llave via WebCrypto (bypasses OpenSSL DECODER framework)
  const key = await webcrypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({
    iss: email, scope: scopeKey,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  })).toString('base64url');

  const data      = `${hdr}.${pay}`;
  const sigBuffer = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(data));
  const assertion = `${data}.${Buffer.from(sigBuffer).toString('base64url')}`;

  const res = await axios.post(
    'https://oauth2.googleapis.com/token',
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const token = res.data.access_token;
  _cache.set(scopeKey, { token, expiry: Date.now() + res.data.expires_in * 1000 });
  return token;
}

module.exports = { getGoogleAccessToken };
