import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { env } from '../env';

/**
 * At-rest encryption of `PayoutAccount.accountNumber` (docs/DATABASE.md "지급 계좌번호 암호화").
 *
 * Stored form: `v1:<iv>:<tag>:<ciphertext>`, each part base64url. AES-256-GCM with a random 12-byte
 * IV per write and a 16-byte tag. The account's `userId` is the additional authenticated data, so a
 * ciphertext copied onto another user's row fails to decrypt instead of paying that user's
 * settlement into someone else's account.
 *
 * The version prefix names the key: `v1` is `PAYOUT_ACCOUNT_ENCRYPTION_KEY`. Rotating the key means
 * a new version (`v2` and its own variable) that `encryptAccountNumber` writes, while `v1` keeps
 * decrypting until the backfill rewrites those rows — see docs/DEPLOYMENT.md "지급 계좌 암호화 키".
 *
 * Rows written before encryption hold the plain digits. `decryptAccountNumber` still reads them
 * (a deploy and the one-off backfill cannot happen at the same instant); the next write of the
 * account, or `npm run payout:encrypt-accounts`, encrypts them.
 *
 * `prisma/payoutAccountCrypto.js` is the seed's copy of `encryptAccountNumber` (the seed is plain
 * JavaScript and cannot import this file). `test/payout-account-crypto.test.ts` keeps them in step.
 */

export const CURRENT_KEY_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** The digits validation stores (10–14). A value that is neither this nor `v<n>:…` is corrupt. */
const LEGACY_PLAINTEXT = /^\d{10,14}$/;

function keyFor(version: string): Buffer {
  if (version !== 'v1') {
    throw new Error(`Unknown payout account key version: ${version}`);
  }
  const key = Buffer.from(env.PAYOUT_ACCOUNT_ENCRYPTION_KEY, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('PAYOUT_ACCOUNT_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }
  return key;
}

/** True for a value stored before encryption: plain digits, still readable. */
export function isLegacyPlaintextAccountNumber(stored: string): boolean {
  return LEGACY_PLAINTEXT.test(stored);
}

export function encryptAccountNumber(accountNumber: string, userId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFor(CURRENT_KEY_VERSION), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(accountNumber, 'utf8'), cipher.final()]);
  return [
    CURRENT_KEY_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * The account number of `userId`'s stored value. Throws on a wrong key, a tampered value, another
 * user's ciphertext or an unknown format — never returns a wrong number.
 */
export function decryptAccountNumber(stored: string, userId: string): string {
  if (isLegacyPlaintextAccountNumber(stored)) return stored;

  const parts = stored.split(':');
  if (parts.length !== 4) {
    throw new Error('Malformed payout account number');
  }
  const [version, iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv(ALGORITHM, keyFor(version), Buffer.from(iv, 'base64url'), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(userId, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
