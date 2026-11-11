// CommonJS, run by `node` like seed.js. The seed's copy of `encryptAccountNumber` in
// src/lib/payoutAccountCrypto.ts, which a plain JS file cannot import: same format
// (`v1:<iv>:<tag>:<ciphertext>`, base64url), AES-256-GCM, the user id as additional authenticated
// data. test/payout-account-crypto.test.ts decrypts its output with the server's code.
const { createCipheriv, randomBytes } = require('node:crypto');

function encryptAccountNumber(accountNumber, userId, keyBase64) {
  const key = Buffer.from(keyBase64 || '', 'base64');
  if (key.length !== 32) {
    throw new Error('PAYOUT_ACCOUNT_ENCRYPTION_KEY must be set to 32 bytes, base64-encoded (workbridge-server/.env.example)');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(accountNumber, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
}

module.exports = { encryptAccountNumber };
