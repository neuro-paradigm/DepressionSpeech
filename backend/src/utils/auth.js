const crypto = require('crypto');

const TOKEN_SECRET = () => process.env.JWT_SECRET || 'development-secret-change-me';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash = '') {
  const [salt, hash] = String(storedHash).split(':');
  if (!salt || !hash) return false;
  try {
    const candidate = hashPassword(password, salt).split(':')[1];
    const candidateBuffer = Buffer.from(candidate, 'hex');
    const storedBuffer = Buffer.from(hash, 'hex');
    if (candidateBuffer.length !== storedBuffer.length) return false;
    return crypto.timingSafeEqual(candidateBuffer, storedBuffer);
  } catch {
    return false;
  }
}

function base64Url(input) {
  return Buffer.from(JSON.stringify(input)).toString('base64url');
}

function signToken(payload) {
  const header = base64Url({ alg: 'HS256', typ: 'JWT' });
  const body = base64Url({ ...payload, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 });
  const signature = crypto.createHmac('sha256', TOKEN_SECRET()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;

    const expected = crypto.createHmac('sha256', TOKEN_SECRET()).update(`${header}.${body}`).digest('base64url');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    // timingSafeEqual throws when lengths differ, so compare sizes first.
    if (signatureBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || !payload.id) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
};
