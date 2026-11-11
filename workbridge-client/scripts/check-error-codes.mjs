// 클라이언트가 쓰는 오류 코드를 서버의 OpenAPI 문서(workbridge-server/openapi.json)와 대조한다.
//
//   npm run check:error-codes
//
// 1. 서버의 모든 오류 코드(ErrorCode)에 화면 문구가 있다 — lib/errorMessages.js의 CODE_MESSAGES, 또는 상태 코드별
//    기본 문구로 충분하다고 적은 STATUS_DEFAULT_CODES.
// 2. 그 두 표와 공용 필드 표(FIELD_MESSAGES)에 서버에 없는 코드가 없다(이름이 바뀌었거나 없어진 코드).
// 3. 화면 코드가 쓰는 코드도 서버에 있다: `errorCode(…)`가 있는 줄의 'UPPER_SNAKE' 문자열, `*_CODES` 배열,
//    `codes:`(오류 코드)와 `fields:`(필드 코드) override 객체의 키. override를 상수로 넘기면 같은 파일의 그 상수를 읽는다.
//
// 빌드도 린트도 모르는 어긋남(서버에 새 코드가 생겼는데 문구가 없음, 화면이 없는 코드로 분기함)을 CI에서 잡는다.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODE_MESSAGES, FIELD_MESSAGES, STATUS_DEFAULT_CODES } from '../src/lib/errorMessages.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const openapi = JSON.parse(readFileSync(join(root, '../workbridge-server/openapi.json'), 'utf8'));
const ERROR_CODES = new Set(openapi.components.schemas.ErrorCode.enum);
const FIELD_CODES = new Set(openapi.components.schemas.FieldErrorCode.enum);

const problems = [];

// 1·2. 표
for (const code of ERROR_CODES) {
  if (!(code in CODE_MESSAGES) && !STATUS_DEFAULT_CODES.includes(code)) {
    problems.push(`서버 코드 ${code}의 화면 문구가 없습니다 — lib/errorMessages.js의 CODE_MESSAGES에 넣으세요.`);
  }
}
for (const code of [...Object.keys(CODE_MESSAGES), ...STATUS_DEFAULT_CODES]) {
  if (!ERROR_CODES.has(code)) problems.push(`lib/errorMessages.js: 서버에 없는 오류 코드 ${code}`);
}
for (const [path, entry] of Object.entries(FIELD_MESSAGES)) {
  if (typeof entry === 'string') continue;
  for (const code of Object.keys(entry)) {
    if (!FIELD_CODES.has(code)) problems.push(`lib/errorMessages.js: FIELD_MESSAGES.${path}에 서버에 없는 필드 코드 ${code}`);
  }
}

// 3. 화면 코드
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(js|jsx)$/.test(name) ? [path] : [];
  });
}

/** `text[open]`이 `{`나 `[`일 때 짝이 맞는 닫는 괄호의 위치. 문자열 안의 괄호는 센다지 않는다. */
function closing(text, open) {
  const pairs = { '{': '}', '[': ']' };
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** 객체 리터럴 본문에서 `depth`단계 키(UPPER_SNAKE)만. */
function keysAtDepth(block, depth) {
  const keys = [];
  let level = 0;
  let quote = null;
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '{') level += 1;
    else if (ch === '}') level -= 1;
    else if (level === depth) {
      const match = /^([A-Z][A-Z0-9_]*[A-Z0-9])\s*:/.exec(block.slice(i));
      if (match && !/[A-Za-z0-9_$]/.test(block[i - 1] ?? '')) {
        keys.push(match[1]);
        i += match[1].length;
      }
    }
  }
  return keys;
}

/** `codes:`·`fields:` 다음의 객체 리터럴, 또는 그 자리에 쓴 상수(`const NAME = {…}`)의 본문. */
function overrideBlocks(text, property) {
  const blocks = [];
  const pattern = new RegExp(`\\b${property}:\\s*(\\{|[A-Za-z_$][A-Za-z0-9_$]*)`, 'g');
  for (const match of text.matchAll(pattern)) {
    let start = match.index + match[0].length - 1;
    if (match[1] !== '{') {
      const declaration = new RegExp(`const ${match[1]}\\s*=\\s*\\{`).exec(text);
      if (!declaration) continue;
      start = declaration.index + declaration[0].length - 1;
    }
    blocks.push(text.slice(start, closing(text, start) + 1));
  }
  return blocks;
}

for (const file of sourceFiles(join(root, 'src'))) {
  if (file.endsWith(join('lib', 'errorMessages.js'))) continue;
  const text = readFileSync(file, 'utf8');
  const where = relative(root, file);

  const used = new Set();
  for (const line of text.split('\n').filter((l) => l.includes('errorCode('))) {
    for (const [, code] of line.matchAll(/'([A-Z][A-Z0-9_]*[A-Z0-9])'/g)) used.add(code);
  }
  for (const match of text.matchAll(/const [A-Z0-9_]*_CODES\s*=\s*\[/g)) {
    const start = match.index + match[0].length - 1;
    for (const [, code] of text.slice(start, closing(text, start)).matchAll(/'([A-Z][A-Z0-9_]*)'/g)) used.add(code);
  }
  for (const block of overrideBlocks(text, 'codes')) keysAtDepth(block, 1).forEach((code) => used.add(code));
  for (const code of used) {
    if (!ERROR_CODES.has(code)) problems.push(`${where}: 서버에 없는 오류 코드 ${code}`);
  }

  for (const block of overrideBlocks(text, 'fields')) {
    for (const code of keysAtDepth(block, 2)) {
      if (!FIELD_CODES.has(code)) problems.push(`${where}: 서버에 없는 필드 코드 ${code}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`오류 코드 ${ERROR_CODES.size}개, 필드 코드 ${FIELD_CODES.size}개 — 클라이언트와 맞습니다.`);
