/**
 * The one form an email address is stored and compared in: surrounding spaces removed, lowercased
 * (docs/domain/accounts.md "가입과 로그인"). Signup, login, the Google callback and the login
 * failure limit all use it, so `Victim@x.com` and `victim@x.com` are one account.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
