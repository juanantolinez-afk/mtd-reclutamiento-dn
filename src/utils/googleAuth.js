const { webcrypto } = require('crypto');
const axios = require('axios');

const _cache = new Map();

// Parsea un DER PKCS#8 RSA y devuelve un JWK con los componentes de la llave.
// importKey('jwk', ...) construye la llave desde BIGNUMs directamente,
// sin pasar por el DECODER framework de OpenSSL 3 que falla con ciertas llaves RSA
// en Node.js 20 (tanto para pkcs8 DER como para PEM via createPrivateKey).
function pkcs8DerToJwk(buf) {
  let p = 0;

  function readLen() {
    const x = buf[p++];
    if (x < 0x80) return x;
    let n = 0, nb = x & 0x7f;
    while (nb--) n = n * 256 + buf[p++];
    return n;
  }

  // Lee el tag, avanza p al inicio del VALUE, devuelve la longitud del VALUE
  function tag(t) {
    if (buf[p] !== t) throw new Error(`ASN.1: esperado 0x${t.toString(16)} en pos ${p}, encontrado 0x${buf[p].toString(16)}`);
    p++;
    return readLen();
  }

  function skipTlv(t) { const n = tag(t); p += n; }

  function readInt() {
    const n   = tag(0x02);
    const end = p + n;
    while (p < end && buf[p] === 0) p++;   // strip leading zero (byte de signo)
    const data = buf.slice(p, end);
    p = end;
    return data;
  }

  const u = b => Buffer.from(b).toString('base64url');

  tag(0x30);     // PKCS#8 outer SEQUENCE
  skipTlv(0x02); // version INTEGER
  skipTlv(0x30); // algorithmIdentifier SEQUENCE
  tag(0x04);     // privateKey OCTET STRING → p apunta al DER PKCS#1
  tag(0x30);     // PKCS#1 RSAPrivateKey SEQUENCE
  skipTlv(0x02); // PKCS#1 version

  return {
    kty: 'RSA', ext: true, key_ops: ['sign'], alg: 'RS256',
    n:  u(readInt()),
    e:  u(readInt()),
    d:  u(readInt()),
    p:  u(readInt()),
    q:  u(readInt()),
    dp: u(readInt()),
    dq: u(readInt()),
    qi: u(readInt()),
  };
}

async function getGoogleAccessToken(scopes) {
  const scopeKey = Array.isArray(scopes) ? scopes.join(' ') : scopes;
  const cached   = _cache.get(scopeKey);
  if (cached && Date.now() < cached.expiry - 60000) return cached.token;

  const email  = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  const rawRaw = process.env.GOOGLE_PRIVATE_KEY || '';

  const rawKey = rawRaw.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');

  const base64 = rawKey
    .split('\n')
    .filter(l => l && !l.startsWith('-----'))
    .map(l => l.trim())
    .join('')
    .replace(/[^A-Za-z0-9+/=]/g, '');

  const derBuf = Buffer.from(base64, 'base64');
  const jwk    = pkcs8DerToJwk(derBuf);

  const key = await webcrypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
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
