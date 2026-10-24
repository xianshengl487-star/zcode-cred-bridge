/**
 * Add one entry to the credential store's `refs` section.
 *
 * `refs` is the half of the store that provider rows reach through `apiKeyEnv`,
 * which is why a plain API key belongs there rather than in `records` (records
 * are the harness's own grant-shaped credentials). The edit is line-based and
 * fails closed on an unfamiliar file, so a store this script does not understand
 * is never rewritten.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const storePath = process.argv[2] ?? join(homedir(), '.dsh', '.credentials.yaml');
const refName = process.argv[3];
const refValue = process.argv[4];

if (!refName || !refValue) {
  console.error('usage: add-ref.mjs <store> <NAME> <value>');
  process.exit(1);
}

const text = readFileSync(storePath, 'utf-8');
if (!text.startsWith('version:')) throw new Error('unfamiliar store: no version header');

const refsStart = text.indexOf('refs:');
const recordsStart = text.indexOf('records:');
if (refsStart < 0 || recordsStart < 0) throw new Error('unfamiliar store: missing refs or records');

const head = text.slice(0, refsStart);
const refsBlock = text.slice(refsStart, recordsStart);
const tail = text.slice(recordsStart);

// The refs section is a YAML flow mapping printed one entry per line, so entries
// must stay comma-separated: append the separator to the previous entry before
// adding the new one. Inserting before the closing brace keeps existing lines
// otherwise untouched.
const closeIdx = refsBlock.lastIndexOf('}');
if (closeIdx < 0) throw new Error('unfamiliar store: refs is not a flow mapping');

const existing = new RegExp(`^\\s*${refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm');
if (existing.test(refsBlock)) {
  console.log(`ref ${refName} already present — leaving it alone`);
  process.exit(0);
}

const body = refsBlock.slice(0, closeIdx).replace(/\s+$/, '');
const closing = refsBlock.slice(closeIdx);
const needsComma = !/,\s*$/.test(body);
const updatedRefs = `${body}${needsComma ? ',' : ''}\n    ${refName}: ${refValue}\n  ${closing}`;

const backup = `${storePath}.bak-refs-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(storePath, backup);

writeFileSync(storePath, head + updatedRefs + tail, 'utf-8');
console.log(`added ref ${refName}`);
console.log(`backup: ${backup}`);
