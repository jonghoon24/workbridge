// 서버 오류 응답({ error: { message } })을 한국어로 바꿔 보여주는 공용 헬퍼.
// 화면마다 예측 가능한 오류만 overrides로 넘기고, 나머지는 서버 문구(또는 fallback)를 보여준다.
//
// overrides
// - status: { 413: '…' }                HTTP 상태로 가장 먼저 판단한다.
// - messages: { 'Server message': '…' }  서버 문구 전체, 또는 `<필드>: ` 접두어를 뗀 문구와 정확히 비교한다.
// - patterns: [[/정규식/, '…']]          접두어를 뗀 문구에 차례로 맞춰 본다.
// - rewrite: (message) => '…' | null     위에서 못 바꾼 서버 문구를 화면이 직접 고친다.
// - passthrough: false                   못 바꾼 문구 대신 fallback을 보여준다(기본은 서버 문구 그대로).
const FIELD_PREFIX = /^[A-Za-z.0-9]+: /;

export function describeServerError(err, fallback, overrides = {}) {
  const { status = {}, messages = {}, patterns = [], rewrite, passthrough = true } = overrides;
  const code = err?.response?.status;
  if (code && status[code]) return status[code];

  const message = err?.response?.data?.error?.message;
  if (!message) return fallback;

  const bare = message.replace(FIELD_PREFIX, '');
  if (messages[message]) return messages[message];
  if (messages[bare]) return messages[bare];

  const match = patterns.find(([pattern]) => pattern.test(bare));
  if (match) return match[1];

  const rewritten = rewrite?.(message);
  if (rewritten) return rewritten;

  return passthrough ? message : fallback;
}
