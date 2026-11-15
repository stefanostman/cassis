const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(scryptCallback);

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password, hash) {
  const [salt, encodedKey] = hash.split(':');
  if (!salt || !encodedKey || !/^[0-9a-f]{128}$/.test(encodedKey)) return false;
  const key = await scrypt(password, salt, 64);
  return timingSafeEqual(key, Buffer.from(encodedKey, 'hex'));
}

module.exports = { hashPassword, verifyPassword };
