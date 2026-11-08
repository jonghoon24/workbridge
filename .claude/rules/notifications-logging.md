---
paths:
  - "workbridge-server/src/**/*.ts"
---

# Notifications and logging

## Notifications

- Create notifications only through `notify()` / `notifyMany()` / `notifyRecipients()`
  (`src/lib/notifications/notify.ts`), passing the **transaction client** of the state change.
  It applies the channel policy (`lib/notifications/policy.ts`) and the recipient's preferences,
  and writes the in-app row, the `EmailDelivery` and its `notification.email` job together (NC9).
- Never `tx.notification.create(...)` directly in new code. Never address a soft-deleted user.
- New types: add to `lib/notifications/types.ts`, `policy.ts` and `templates.ts`.
- The four pre-existing types keep their Korean wording inline in the old controllers on purpose
  (the client and E2E match on that text).
- Email is log-only: with `MAIL_PROVIDER` unset or `log`, each email is one `mail.sent` info line.

## Logging — `src/lib/logger.ts`

- Use `logger.debug|info|warn|error(msg, fields)`, never `console.*` (a PostToolUse hook flags it).
  Logs are single-line JSON; `Error`s in fields are serialized by `serializeError`.
- `error` level is reserved for `errorHandler`'s 500s and job failures. The suite asserts
  "a 500 is logged exactly once" with a `console.error` spy, and a 4xx never logs at error.
  Use `warn`/`info` for everything else.
- Known exceptions that stay: `auth.controller.ts` `googleCallback` (logs the failure it swallows
  into a redirect) and `jobs/cli.ts` (prints the run result for the CLI).
