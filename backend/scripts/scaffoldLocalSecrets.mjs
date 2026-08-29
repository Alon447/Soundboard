#!/usr/bin/env node
/**
 * `npm run secrets:example` — sets up local development: copies
 * backend/local_secrets.example/ into backend/local_secrets/, the files getSecret() reads
 * when IS_BLACK_ENV=true, and creates backend/.env from .env.example.
 *
 * Existing files are never overwritten, so re-running is safe once you have edited them.
 * In the closed environment you do not run this at all: secrets come from Vault and the
 * platform injects the environment.
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

// IS_BLACK_ENV defaults to false, meaning "assume the closed environment". Local dev needs
// the .env that turns it on, or config validation fails demanding Vault settings.
await cp(path.join(backendRoot, '.env.example'), path.join(backendRoot, '.env'), {
	force: false,
	errorOnExist: false,
});

console.log('local_secrets/ and .env ready, existing files untouched. Next: npm run api:check');
