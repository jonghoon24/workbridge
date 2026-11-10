import { createRequire } from 'node:module';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import { makeFreelancer, makePayoutAccount } from './helpers/factories';
import {
  decryptAccountNumber,
  encryptAccountNumber,
} from '../src/lib/payoutAccountCrypto';
import { setPayoutProvider, LogPayoutProvider } from '../src/lib/payout/provider';
import { encryptLegacyAccountNumbers } from '../src/services/payoutAccount.service';
import { runPayout } from '../src/services/settlements.service';

/**
 * Payout account numbers are encrypted at rest (AES-256-GCM, `PAYOUT_ACCOUNT_ENCRYPTION_KEY`):
 * docs/domain/milestones-payments.md "지급 계좌", docs/DATABASE.md "지급 계좌번호 암호화".
 * Responses, logs and settlements keep showing only the masked number.
 */

const seedCrypto = createRequire(path.join(process.cwd(), 'package.json'))('./prisma/payoutAccountCrypto.js') as {
  encryptAccountNumber: (accountNumber: string, userId: string, keyBase64: string) => string;
};

afterEach(() => {
  setPayoutProvider(new LogPayoutProvider());
});

const put = (user: User, accountNumber: string) =>
  authed(user).put('/api/users/me/payout-account').send({ bankCode: '004', accountNumber, holderName: user.name });

async function storedNumber(userId: string): Promise<string> {
  return (await prisma.payoutAccount.findUniqueOrThrow({ where: { userId } })).accountNumber;
}

async function legacyAccount(userId: string, accountNumber: string) {
  // As a row written before encryption: the digits themselves.
  await prisma.$executeRaw`
    INSERT INTO "PayoutAccount" ("id", "userId", "bankCode", "accountNumber", "holderName", "updatedAt")
    VALUES (gen_random_uuid()::text, ${userId}, '004', ${accountNumber}, 'legacy', now())`;
}

describe('storing the account number', () => {
  it('PUT stores a versioned ciphertext, never the digits, that decrypts to the number', async () => {
    const freelancer = await makeFreelancer();

    const res = await put(freelancer, '110-123-456789');

    expect(res.status).toBe(200);
    expect(res.body.payoutAccount.accountNumberMasked).toBe('********6789');
    const stored = await storedNumber(freelancer.id);
    expect(stored).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(stored).not.toContain('110123456789');
    expect(stored).not.toContain('6789');
    expect(decryptAccountNumber(stored, freelancer.id)).toBe('110123456789');
  });

  it('uses a fresh IV per write: the same number twice gives two different ciphertexts', async () => {
    const freelancer = await makeFreelancer();

    await put(freelancer, '110123456789');
    const first = await storedNumber(freelancer.id);
    await put(freelancer, '110123456789');
    const second = await storedNumber(freelancer.id);

    expect(second).not.toBe(first);
    expect(decryptAccountNumber(second, freelancer.id)).toBe('110123456789');
  });

  it("refuses to decrypt one user's ciphertext as another's", async () => {
    const a = await makeFreelancer();
    const b = await makeFreelancer();
    const ciphertext = encryptAccountNumber('110123456789', a.id);

    expect(() => decryptAccountNumber(ciphertext, b.id)).toThrow();
  });

  it('refuses a tampered ciphertext instead of returning a wrong number', async () => {
    const freelancer = await makeFreelancer();
    const [version, iv, tag, body] = encryptAccountNumber('110123456789', freelancer.id).split(':');
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] ^= 1;

    expect(() => decryptAccountNumber([version, iv, tag, flipped.toString('base64url')].join(':'), freelancer.id)).toThrow();
    expect(() => decryptAccountNumber('v9:a:b:c', freelancer.id)).toThrow('Unknown payout account key version');
    expect(() => decryptAccountNumber('not-a-number', freelancer.id)).toThrow('Malformed payout account number');
  });

  it('refuses a key that is not 32 bytes', () => {
    vi.stubEnv('PAYOUT_ACCOUNT_ENCRYPTION_KEY', Buffer.alloc(16).toString('base64'));
    try {
      expect(() => encryptAccountNumber('110123456789', 'user')).toThrow('must be 32 bytes');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("decrypts what the seed's copy of the cipher writes", async () => {
    const freelancer = await makeFreelancer();
    const key = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY as string;

    const stored = seedCrypto.encryptAccountNumber('3333012345678', freelancer.id, key);

    expect(stored).toMatch(/^v1:/);
    expect(decryptAccountNumber(stored, freelancer.id)).toBe('3333012345678');
  });
});

describe('reading an account stored before encryption', () => {
  it('shows it masked, pays to it, and encrypts it on the next write', async () => {
    const freelancer = await makeFreelancer();
    await legacyAccount(freelancer.id, '94820201234567');

    const shown = await authed(freelancer).get('/api/users/me/payout-account');
    expect(shown.status).toBe(200);
    expect(shown.body.payoutAccount.accountNumberMasked).toBe('**********4567');

    const settlement = await prisma.settlement.create({
      data: {
        freelancerId: freelancer.id,
        periodStart: new Date('2026-10-18T15:00:00.000Z'),
        periodEnd: new Date('2026-10-25T15:00:00.000Z'),
        scheduledPayoutAt: new Date('2026-10-28T01:00:00.000Z'),
        itemCount: 1,
        grossAmount: 1_000_000,
        feeAmount: 100_000,
        feeVatAmount: 10_000,
        netAmount: 890_000,
      },
    });
    const transfer = vi.fn(async () => ({ reference: 'ref' }));
    setPayoutProvider({ transfer });
    expect(await runPayout(settlement.id, settlement.scheduledPayoutAt.toISOString(), new Date())).toBe('paid');
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ accountNumber: '94820201234567' }));
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).accountNumberMasked)
      .toBe('**********4567');

    expect((await put(freelancer, '94820201234567')).status).toBe(200);
    const stored = await storedNumber(freelancer.id);
    expect(stored).toMatch(/^v1:/);
    expect(decryptAccountNumber(stored, freelancer.id)).toBe('94820201234567');
  });
});

describe('encryptLegacyAccountNumbers (the one-off backfill)', () => {
  it('encrypts every plaintext row, leaves encrypted rows alone, and is idempotent', async () => {
    const legacyA = await makeFreelancer();
    const legacyB = await makeFreelancer();
    const current = await makeFreelancer();
    await legacyAccount(legacyA.id, '1101234567');
    await legacyAccount(legacyB.id, '12345678901234');
    await makePayoutAccount(current, { accountNumber: '3333012345678' });
    const currentBefore = await storedNumber(current.id);

    expect(await encryptLegacyAccountNumbers()).toEqual({ scanned: 3, encrypted: 2 });

    for (const [user, digits] of [[legacyA, '1101234567'], [legacyB, '12345678901234']] as const) {
      const stored = await storedNumber(user.id);
      expect(stored).toMatch(/^v1:/);
      expect(decryptAccountNumber(stored, user.id)).toBe(digits);
    }
    expect(await storedNumber(current.id)).toBe(currentBefore);

    expect(await encryptLegacyAccountNumbers()).toEqual({ scanned: 3, encrypted: 0 });
  });
});
