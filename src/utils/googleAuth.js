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
  const rawKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  // Extraer bytes DER del PEM (sin headers ni espacios)
  const base64 = rawKey
    .split('\n')
    .filter(l => l && !l.startsWith('-----'))
    .map(l => l.trim())
    .join('');

  const derBuf = Buffer.from(base64, 'base64');
  // Slice a un ArrayBuffer independiente — Buffer puede ser vista de un pool compartido
  // y WebCrypto en Node.js 20 puede leer el pool completo si no se aisla
  const der = derBuf.buffer.slice(derBuf.byteOffset, derBuf.byteOffset + derBuf.byteLength);

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
