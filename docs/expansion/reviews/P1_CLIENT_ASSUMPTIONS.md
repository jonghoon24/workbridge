# P1 클라이언트 워커의 가정 (2026-10-21, p1-client → 5d1769f)

클라이언트 워커는 서버 없이 BEHAVIOR.md만 보고 화면을 만들었다. 아래는 명세가 말하지 않아 가정한 것이다. 검증 워커가 실제 서버 응답과 대조한다.

1. `GET /api/milestones/:id` → `contract` includes `status`, `clientId`, `freelancerId` and `project.title` (MS11). The payment page relies on these to decide whether to show the pay button.
2. `GET /api/contracts/:id` still includes `projectId`, `clientId`, `freelancerId`, `client.name` and `freelancer.name` as before. CT5 lists the relations but not the scalar fields.
3. The PUT plan response isn't used; the page re-fetches `GET /api/contracts/:id` after saving.
4. The approve response's `contract.status === 'COMPLETED'` triggers the "contract completed" message.
5. Validation messages look like `milestones.<i>.<field>: …`; the editor rewrites them as "N번 마일스톤 <field>: …". Other server messages are shown raw in English, as existing pages do.
6. The 413 response body is assumed to carry `{error:{message}}`; otherwise a Korean fallback is shown.
7. Submissions always go as multipart with repeated `links` fields, and no `links` field when there are none.
8. Confirm sends only `{orderId, paymentKey, amount}` per PY5. `milestoneId` travels in the result page's query string, not the confirm body.
9. Toss appends `paymentKey`, `orderId`, `amount` to `successUrl`, and `code`, `message` to `failUrl`. `successUrl` no longer embeds `orderId` itself.
10. On settlement items, `feeRateBps / 100` is shown as a percent.
11. A `FAILED` settlement with `payoutAttempts < 3` is labelled "재시도 대기", and its `scheduledPayoutAt` is shown as the retry time.
12. The holder-name check (M23) is left to the server. The form only pre-fills the name from the auth store.
13. Each settlement-page call sends `limit` 20 and each `/my/contracts` call sends `limit` 10.

## Spec gaps the client worker noted

1. Submissions can carry up to 5 × 10 MB through the Next proxy; Vercel caps bodies at ~4.5 MB (P4 DEPLOYMENT.md note).
2. MS1/CT6 don't say which contract scalar fields are guaranteed.
3. No message text for the 413 or file-type 400 responses.
4. `/payments` is still not in `protectedRoutes` (pre-existing).
5. No smoke test against a server was possible.
