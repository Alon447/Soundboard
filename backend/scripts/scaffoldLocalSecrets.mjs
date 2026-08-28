#!/usr/bin/env node
/**
 * `npm run secrets:example` — copies backend/local_secrets.example/ into
 * backend/local_secrets/, the files getSecret() reads when IS_BLACK_ENV=true.
 *
 * Existing files are never overwritten, so re-running is safe once you have edited them.
 * In the closed environment you do not run this at all: secrets come from Vault.
 */

import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await cp(path.join(backendRoot, 'local_secrets.example'), path.join(backendRoot, 'local_secrets'), {
	recursive: true,
	force: false,
	errorOnExist: false,
});

console.log('local_secrets/ populated, existing files left untouched. Next: npm run api:check');
