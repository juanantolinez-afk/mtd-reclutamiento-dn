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

  // Diagnóstico — se puede remover una vez confirmado que funciona
  console.log('[GoogleAuth] Node:', process.version);
  console.log('[GoogleAuth] rawRaw.length:', rawRaw.length);
  console.log('[GoogleAuth] primeros 60 chars:', JSON.stringify(rawRaw.slice(0, 60)));
  console.log('[GoogleAuth] tiene \\\\n literales:', rawRaw.includes('\\n'));
  console.log('[GoogleAuth] tiene newlines reales:', rawRaw.includes('\n'));

  // Limpiar comillas externas (si Railway guarda el valor con " alrededor)
  const cleaned = rawRaw.replace(/^["']|["']$/g, '');
  const rawKey  = cleaned.replace(/\\n/g, '\n');

  // Extraer bytes DER del PEM (sin headers ni espacios)
  const base64 = rawKey
    .split('\n')
    .filter(l => l && !l.startsWith('-----'))
    .map(l => l.trim())
    .join('');

  console.log('[GoogleAuth] base64.length:', base64.length, '(esperado ~1624)');
  console.log('[GoogleAuth] base64 inicio:', base64.slice(0, 20));

  const derBuf = Buffer.from(base64, 'base64');
  // Slice a un ArrayBuffer independiente — Buffer puede ser vista de un pool compartido
  const der = derBuf.buffer.slice(derBuf.byteOffset, derBuf.byteOffset + derBuf.byteLength);

  console.log('[GoogleAuth] der.byteLength:', der.byteLength, '(esperado ~1216)');
  console.log('[GoogleAuth] der[0..4] hex:', Buffer.from(der).slice(0, 5).toString('hex'));

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
