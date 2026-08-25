#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve('test/fixtures/response-corpus.json');
const text = readFileSync(path, 'utf8');
const forbidden = [
  ['email address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['JWT', /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['access credential', /CF-ACCESS-CLIENT-(?:ID|SECRET)/i],
  ['Huly production URL', /huly\.bgx4k3p\.site/i],
  ['credential field', /"(?:password|token|secret|apiKey)"\s*:/i]
];
const matches = forbidden.filter(([, pattern]) => pattern.test(text));
if (matches.length > 0) {
  console.error(`Response fixture privacy scan failed: ${matches.map(([name]) => name).join(', ')}`);
  process.exit(1);
}
console.log(`Response fixture privacy scan passed: ${path}`);
