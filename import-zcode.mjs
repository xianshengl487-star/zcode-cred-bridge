#!/usr/bin/env node
/**
 * Bring the ZCode desktop client's BigModel sign-in into DSH.
 *
 * The ZCode client stores its OAuth result in `~/.zcode/v2/credentials.json`,
 * encrypted with AES-256-GCM under a key derived from
 * `ZCODE_CREDENTIAL_SECRET` (or, when that variable is absent, from machine
 * identity). DSH's zcode plugin keeps its own credential records in
 * `~/.dsh/.credentials.yaml`. Nothing connected the two, so `zcode-cn` reported
 * AUTH_REQUIRED on a machine that was already signed in.
 *
 * This script closes that gap: decrypt, verify against the live endpoint, write
 * the DSH record through the same shape the plugin's own sign-in uses.
 *
 * Usage:
 *   node import-zcode.mjs              import (verifies first)
 *   node import-zcode.mjs --check      decrypt and verify, write nothing
 *   node import-zcode.mjs --dry-run    show what would be written
 *   node import-zcode.mjs --route zcode-cn
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { homedir, platform, userInfo } from 'node:os';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ENC_PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

const BIGMODEL_MESSAGES = 'https://open.bigmodel.cn/api/anthropic/v1/messages';

/** Same derivation the client uses: sha256 of the secret, machine-identity fallback. */
function deriveKey() {
  const secret = process.env.ZCODE_CREDENTIAL_SECRET || (() => {
    let user = 'unknown';
    try { user = userInfo().username; } catch { /* container without a passwd entry */ }
    return `zcode-credential-fallback:${platform()}:${homedir()}:${user}`;
  })();
  return createHash('sha256').update(secret).digest();
}

function decrypt(value, key) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  const parts = value.slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('ciphertext has the wrong number of parts');
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== IV_LEN) throw new Error('IV has the wrong length');
  if (tag.length !== TAG_LEN) throw new Error('auth tag has the wrong length');
  const d = createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf-8');
}

/** Decode a JWT payload without verifying it — used only for display. */
function jwtPayload(token) {
  try {
    const [, body] = token.split('.');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
  } catch { return undefined; }
}

function readZcodeCredentials() {
  const file = join(homedir(), '.zcode', 'v2', 'credentials.json');
  if (!existsSync(file)) {
    throw new Error(`ZCode credentials not found at ${file} — sign in to the ZCode client first.`);
  }
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  const key = deriveKey();
  const out = {};
  const failures = [];
  for (const [k, v] of Object.entries(raw)) {
    try { out[k] = decrypt(v, key); } catch (e) { failures.push(`${k}: ${e.message}`); }
  }
  return { values: out, failures, file };
}

/** Map the ZCode client's provider keys onto DSH zcode routes. */
function resolveRoute(values) {
  const active = values['oauth:active_provider'];
  if (typeof active === 'string' && active.trim() !== '') return active.trim();
  const candidates = ['bigmodel', 'zai'];
  for (const c of candidates) if (values[`oauth:${c}:access_token`]) return c;
  return undefined;
}

async function verifyToken(token) {
  const res = await fetch(BIGMODEL_MESSAGES, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'glm-5.3',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, ok: res.ok, body, text };
}

/**
 * Explain a failed verification in terms a person can act on.
 *
 * The codes below are the ones this endpoint actually returns for a signed-in
 * account that cannot spend: they are why a live probe is worth doing before
 * writing a credential that would only fail later at request time.
 */
function explain(status, body) {
  const code = body?.error?.code;
  const message = body?.error?.message ?? '';
  if (code === 1309 || /套餐已到期/.test(message)) {
    return 'GLM Coding Plan 已到期（429 code 1309）。凭据本身有效，续订后即可使用：https://bigmodel.cn/claude-code';
  }
  if (code === 1113 || /Insufficient balance|无可用资源包/.test(message)) {
    return '套餐额度/资源包不足（code 1113）。凭据有效，需充值或确认套餐覆盖面。';
  }
  if (status === 401) {
    return 'token 被拒绝（401）。可能是登录态过期，请在 ZCode 客户端重新登录后重跑本脚本。';
  }
  if (status === 403) {
    return 'token 无权访问该端点（403）。检查账号是否有 Anthropic 兼容通道的权限。';
  }
  if (status === 200) return '可用';
  return `未预期的响应（HTTP ${status}）：${message || '（无消息）'}`;
}

/** The record shape the zcode plugin's own sign-in writes. */
function buildRecord(token, values, route) {
  const user = (() => {
    try { return JSON.parse(values['oauth:bigmodel:user_info'] ?? '{}'); } catch { return {}; }
  })();
  const claims = jwtPayload(token) ?? {};
  const now = Date.now();
  return {
    kind: 'grant',
    payload: {
      apiKey: token,
      keyId: `zcode-client-${claims.user_id ?? user.id ?? route}`,
      organizationId: claims.user_id ?? user.id ?? route,
      projectId: 'zcode-client',
      organizationName: user.displayName || user.username || 'ZCode 客户端',
      projectName: 'BigModel Coding Plan',
      plan: route,
      provisionedAt: now,
      importedFrom: 'zcode-desktop',
    },
  };
}

/** Minimal writer for the credential store's records section. */
function writeCredentialRecord(storePath, recordKey, record) {
  const text = readFileSync(storePath, 'utf-8');
  if (!text.startsWith('version:')) {
    throw new Error(`${storePath} does not start with "version:" — refusing to rewrite an unfamiliar file.`);
  }

  const backup = `${storePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(storePath, backup);

  const headerEnd = text.indexOf('records:');
  if (headerEnd < 0) {
    throw new Error(`${storePath} has no "records:" section — refusing to guess its layout.`);
  }
  const header = text.slice(0, headerEnd);
  const body = text.slice(headerEnd + 'records:'.length);

  const lines = body.split(/\r?\n/);
  const blocks = [];
  let current;
  for (const line of lines) {
    const top = /^ {2}([^ ].*):\s*$/.exec(line);
    if (top) {
      if (current) blocks.push(current);
      current = { key: top[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);

  const rendered = `  ${recordKey}:\n${serializeRecord(record, 4)}`;
  const index = blocks.findIndex((b) => b.key === recordKey);
  if (index >= 0) {
    blocks[index] = { key: recordKey, lines: rendered.split('\n') };
  } else {
    blocks.push({ key: recordKey, lines: rendered.split('\n') });
  }

  const rebuilt = header + 'records:\n' + blocks
    .map((b) => b.lines.join('\n').replace(/\s+$/, ''))
    .join('\n') + '\n';
  writeFileSync(storePath, rebuilt, 'utf-8');
  return backup;
}

function serializeRecord(record, indent) {
  const pad = ' '.repeat(indent);
  const out = [`${pad}kind: ${record.kind}`, `${pad}payload:`];
  for (const [k, v] of Object.entries(record.payload)) {
    if (v === undefined) continue;
    const value = typeof v === 'string' ? quoteIfNeeded(v) : String(v);
    out.push(`${pad}  ${k}: ${value}`);
  }
  return out.join('\n');
}

function quoteIfNeeded(value) {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

async function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const dryRun = argv.includes('--dry-run');
  const routeArgIdx = argv.indexOf('--route');
  const storeOverride = (() => {
    const i = argv.indexOf('--store');
    return i >= 0 ? argv[i + 1] : undefined;
  })();

  console.log('ZCode → DSH 凭据桥');

  const { values, failures, file } = readZcodeCredentials();
  console.log(`  读取: ${file}`);
  if (failures.length) {
    console.log('  解密失败（该机器的密钥与写入时不一致）:');
    for (const f of failures) console.log(`    - ${f}`);
  }

  const provider = routeArgIdx >= 0 ? argv[routeArgIdx + 1] : resolveRoute(values);
  if (!provider) throw new Error('存活的登录态里找不到 provider（既无 active_provider，也无 oauth:bigmodel / oauth:zai）');

  const token = values[`oauth:${provider}:access_token`];
  if (!token) throw new Error(`oauth:${provider}:access_token 不存在（可用的键: ${Object.keys(values).join(', ')}）`);

  const userInfo_ = (() => {
    try { return JSON.parse(values[`oauth:${provider}:user_info`] ?? '{}'); } catch { return {}; }
  })();
  const claims = jwtPayload(token) ?? {};
  console.log(`  provider: ${provider}`);
  console.log(`  账号: ${userInfo_.displayName || userInfo_.username || '未知'} (id ${claims.user_id ?? userInfo_.id ?? '?'})`);
  console.log(`  token: ${token.slice(0, 12)}… (长度 ${token.length})`);

  const route = routeArgIdx >= 0 ? provider === 'bigmodel' ? 'zcode-cn' : 'zcode'
    : provider === 'bigmodel' ? 'zcode-cn' : 'zcode';
  console.log(`  目标 DSH 路由: llm-zcode/${route}`);

  console.log('  实测端点…');
  const verdict = await verifyToken(token);
  const meaning = explain(verdict.status, verdict.body);
  console.log(`  HTTP ${verdict.status} — ${meaning}`);

  if (checkOnly) {
    console.log(verdict.ok ? '检查通过，可以导入。' : '检查未通过，未写入。');
    process.exitCode = verdict.ok ? 0 : 1;
    return;
  }

  const record = buildRecord(token, values, route);
  const storePath = storeOverride ?? join(homedir(), '.dsh', '.credentials.yaml');
  if (!existsSync(storePath)) throw new Error(`找不到 DSH 凭据库: ${storePath}`);

  if (dryRun) {
    console.log('  --dry-run，不写入。将写入的记录:');
    console.log(serializeRecord({ kind: record.kind, payload: { ...record.payload, apiKey: `${token.slice(0, 12)}…` } }, 4));
    return;
  }

  // A credential that fails verification would only move the failure to the next
  // request, so the write is refused unless the probe actually succeeded.
  if (!verdict.ok) {
    console.log('  未写入：凭据通过了认证但无法消费额度。');
    console.log('  续订后重新运行本脚本即可完成导入。');
    process.exitCode = 2;
    return;
  }

  const backup = writeCredentialRecord(storePath, `llm-zcode/${route}`, record);
  console.log(`  已写入 ${storePath}`);
  console.log(`  备份: ${backup}`);
  console.log(`  下一步：重启 DSH（或重新加载插件）即可在模型选择器使用 ${route}。`);
}

main().catch((error) => {
  console.error(`失败: ${error.message}`);
  process.exitCode = 1;
});
