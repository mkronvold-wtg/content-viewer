#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadAndValidateExceptions } from './security-exceptions.mjs';

const root = resolve(import.meta.dirname, '..');
const configPath = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'security/trivy-exceptions.json');
const registerPath = process.argv[3] ? resolve(process.argv[3]) : resolve(root, 'docs/security-exceptions.md');

try {
  const exceptions = await loadAndValidateExceptions({ configPath, registerPath });
  console.log(`Security exception configuration is valid (${exceptions.length} exception(s)).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
