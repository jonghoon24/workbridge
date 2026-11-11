#!/usr/bin/env node
// 앱이 읽는 환경변수와 패키지의 `.env.example`이 어긋나면 실패한다(CI의 server·client 잡이 돌린다).
//
// 사용법: node scripts/check-env-example.mjs [server|client]   (인자가 없으면 둘 다)
//
// 두 방향을 검사한다.
//   빠짐: 코드가 읽는데 `.env.example`에 없는 변수.
//   남음: `.env.example`에 있는데 아무 코드도 읽지 않는 변수.
// `.env.example`에서 `KEY=...`와 주석 처리한 `# KEY=...`를 모두 "적혀 있음"으로 센다. 플랫폼이 넣어 주는 변수
// (VERCEL_ENV 등)는 주석 줄로 적는다.
//
// 코드에서 읽는 변수는 주석을 지운 소스에서 다음 모양으로 찾는다.
//   process.env.KEY, process.env?.KEY, process.env['KEY'], const { KEY } = process.env,
//   const { env } = process; env.KEY
//   서버 src/env.ts의 required('KEY'), withDefault('KEY', ...)
//   서버 prisma/schema.prisma의 env("KEY")
// `process.env[name]`처럼 이름을 알 수 없는 접근은 src/env.ts의 도우미 안에서만 허용한다.
// test/와 scripts/는 보지 않는다. 개발 도구는 자기가 읽는 변수를 스스로 설명한다.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// NODE_ENV는 Node·Next·Vercel이 정하므로 `.env.example`에 두지 않는다.
const IGNORED = new Set(['NODE_ENV']);

const PACKAGES = {
  server: {
    dir: 'workbridge-server',
    sources: ['src', 'prisma/seed.js', 'prisma/schema.prisma'],
    // 이 파일만 process.env[name]으로 읽고, 이름은 도우미 호출에 문자열로 있다.
    envModule: 'src/env.ts',
  },
  client: {
    dir: 'workbridge-client',
    sources: ['src', 'next.config.js', 'next.config.mjs'],
    envModule: null,
  },
};

const SOURCE_EXT = /\.(c|m)?(j|t)sx?$|\.prisma$/;
const NAME = '[A-Z_][A-Z0-9_]*';

function listFiles(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const full = join(path, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return SOURCE_EXT.test(entry.name) ? [full] : [];
  });
}

const LITERAL_OR_COMMENT =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

// 주석을 지운다(주석 속 `process.env.FOO` 예시를 읽은 것으로 세지 않으려고). `code`는 문자열을 남겨
// required('KEY') 같은 이름을 찾고, `bare`는 '…'·"…" 문자열의 내용도 비워 문자열 속 `process.env.X`를 세지 않는다.
// 템플릿 리터럴은 `${process.env.X}`가 실제로 읽는 것이라 남긴다.
function stripComments(source) {
  const code = source.replace(LITERAL_OR_COMMENT, (match, literal) => literal ?? '');
  const bare = source.replace(LITERAL_OR_COMMENT, (match, literal) =>
    literal === undefined ? '' : literal.startsWith('`') ? literal : '""',
  );
  return { code, bare };
}

function collectReads(pkg) {
  const reads = new Map(); // 변수 -> 처음 읽은 파일
  const dynamic = [];
  const add = (name, file) => {
    if (!IGNORED.has(name) && !reads.has(name)) reads.set(name, file);
  };

  for (const source of pkg.sources) {
    for (const file of listFiles(join(ROOT, pkg.dir, source))) {
      const rel = relative(join(ROOT, pkg.dir), file);
      const { code, bare } = stripComments(readFileSync(file, 'utf8'));
      const isEnvModule = rel === pkg.envModule;

      if (file.endsWith('.prisma')) {
        for (const m of code.matchAll(new RegExp(`\\benv\\(\\s*"(${NAME})"\\s*\\)`, 'g'))) add(m[1], rel);
        continue;
      }
      for (const m of bare.matchAll(new RegExp(`process\\??\\.env\\??\\.(${NAME})\\b`, 'g'))) add(m[1], rel);
      for (const m of code.matchAll(new RegExp(`process\\??\\.env(?:\\?\\.)?\\[\\s*['"\`](${NAME})['"\`]\\s*\\]`, 'g'))) add(m[1], rel);
      // const { env } = process; env.KEY
      if (/\{[^{}]*\benv\b[^{}]*\}\s*=\s*process\b(?!\s*\??\.)/.test(bare)) {
        for (const m of bare.matchAll(new RegExp(`(?<![\\w.])env\\??\\.(${NAME})\\b`, 'g'))) add(m[1], rel);
      }
      for (const m of bare.matchAll(/\{([^{}]*)\}\s*=\s*process\??\.env\b/g)) {
        for (const part of m[1].split(',')) {
          const key = part.split(/[:=]/)[0].trim();
          if (new RegExp(`^${NAME}$`).test(key)) add(key, rel);
        }
      }
      if (isEnvModule) {
        for (const m of code.matchAll(new RegExp(`\\b(?:required|withDefault)\\(\\s*['"](${NAME})['"]`, 'g'))) add(m[1], rel);
      } else {
        for (const m of code.matchAll(/process\??\.env(?:\?\.)?\[\s*(?!['"`][A-Z_][A-Z0-9_]*['"`]\s*\])[^\]]*\]/g)) {
          dynamic.push(`${pkg.dir}/${rel}: ${m[0]}`);
        }
      }
    }
  }
  return { reads, dynamic };
}

function collectDocumented(examplePath) {
  const keys = new Set();
  for (const line of readFileSync(examplePath, 'utf8').split('\n')) {
    const m = line.match(new RegExp(`^\\s*(?:#\\s*)?(?:export\\s+)?(${NAME})\\s*=`));
    if (m) keys.add(m[1]);
  }
  return keys;
}

function check(name) {
  const pkg = PACKAGES[name];
  const examplePath = join(ROOT, pkg.dir, '.env.example');
  const example = `${pkg.dir}/.env.example`;
  if (!existsSync(examplePath)) {
    console.error(`✗ ${example}이 없습니다.`);
    return false;
  }

  const { reads, dynamic } = collectReads(pkg);
  const documented = collectDocumented(examplePath);
  const missing = [...reads.keys()].filter((key) => !documented.has(key)).sort();
  const stale = [...documented].filter((key) => !reads.has(key) && !IGNORED.has(key)).sort();

  if (missing.length === 0 && stale.length === 0 && dynamic.length === 0) {
    console.log(`✓ ${example}: 코드가 읽는 변수 ${reads.size}개와 맞습니다.`);
    return true;
  }

  console.error(`✗ ${example}이 코드와 맞지 않습니다.`);
  if (missing.length > 0) {
    console.error(`\n  코드가 읽는데 ${example}에 없는 변수:`);
    for (const key of missing) console.error(`    - ${key}  (${pkg.dir}/${reads.get(key)})`);
    console.error(
      `  → ${example}에 \`${missing[0]}=<예시 값>\`과 의미·기본값을 설명하는 주석을 더합니다.\n` +
        '    플랫폼이 넣어 주는 변수(VERCEL_ENV 등)는 `# KEY=` 주석 줄로 적습니다.',
    );
  }
  if (stale.length > 0) {
    console.error(`\n  ${example}에 있는데 ${pkg.sources.join(', ')}에서 아무도 읽지 않는 변수:`);
    for (const key of stale) console.error(`    - ${key}`);
    console.error(`  → 더 이상 쓰지 않는 변수면 ${example}에서 지웁니다. 쓰는 변수면 읽는 코드를 확인합니다.`);
  }
  if (dynamic.length > 0) {
    console.error('\n  이름을 알 수 없는 process.env 접근(이 검사가 변수를 찾지 못합니다):');
    for (const where of dynamic) console.error(`    - ${where}`);
    console.error(
      `  → 변수 이름을 문자열 그대로 씁니다(process.env.KEY).` +
        (pkg.envModule ? ` 서버는 ${pkg.envModule}의 도우미로 읽습니다.` : ''),
    );
  }
  return false;
}

const targets = process.argv.slice(2);
for (const target of targets) {
  if (!PACKAGES[target]) {
    console.error(`알 수 없는 패키지: ${target} (server 또는 client)`);
    process.exit(2);
  }
}
const results = (targets.length > 0 ? targets : Object.keys(PACKAGES)).map(check);
process.exit(results.every(Boolean) ? 0 : 1);
