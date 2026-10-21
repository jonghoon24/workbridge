/**
 * Banks a payout account may use (BEHAVIOR.md M23). The client keeps the same list in
 * `constants/banks.js` — the duplication is intended.
 */
export const BANKS = {
  '004': 'KB국민',
  '088': '신한',
  '020': '우리',
  '081': '하나',
  '011': 'NH농협',
  '003': 'IBK기업',
  '090': '카카오뱅크',
  '092': '토스뱅크',
  '089': '케이뱅크',
  '023': 'SC제일',
  '031': '대구',
  '032': '부산',
} as const;

export type BankCode = keyof typeof BANKS;

export function isBankCode(code: string): code is BankCode {
  return Object.prototype.hasOwnProperty.call(BANKS, code);
}

export function bankName(code: string): string {
  return isBankCode(code) ? BANKS[code] : code;
}

/** M23: every digit but the last four replaced by `*` (`110123456789` → `********6789`). */
export function maskAccountNumber(accountNumber: string): string {
  const visible = accountNumber.slice(-4);
  return '*'.repeat(Math.max(accountNumber.length - 4, 0)) + visible;
}
