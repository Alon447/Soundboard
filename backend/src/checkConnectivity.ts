/**
 * `npm run api:check` — proves the backend can reach its secret store, PostgreSQL and S3.
 * Safe against production: read-only apart from one small object under `healthcheck/` that
 * it deletes again. Prints secret field names, never values.
 */

import { config } from './config/index.js';
import { isBlackEnv } from './utils/envCheck.js';
import { getSecret, LOCAL_SECRETS_DIR, postgresSecretPath, SECRET_PATHS } from './utils/secrets.js';
import { closePool, getPool } from './utils/pg.js';
import { deleteObject, getObjectBytes, getStorage, objectExists, putObject } from './utils/s3.js';

const TABLES = ['sound_assets', 'shared_sounds', 'user_sounds'];
const PROBE_BODY = 'soundboard connectivity check';

const fieldNames = async (name: string) =>
	Object.keys(await getSecret(name)).sort().join(', ');

const checks: { name: string; run: () => Promise<string> }[] = [
	{ name: `secret ${SECRET_PATHS.s3}`, run: () => fieldNames(SECRET_PATHS.s3) },
	{ name: `secret ${postgresSecretPath()}`, run: () => fieldNames(postgresSecretPath()) },
	{
		name: 'postgres',
		run: async () => {
			const pool = await getPool();
			const { rows } = await pool.query<{ table_name: string }>(
				`select table_name from information_schema.tables
				  where table_schema = 'public' and table_name = any($1::text[])`,
				[TABLES],
			);
			const missing = TABLES.filter((table) => !rows.some((row) => row.table_name === table));
			if (missing.length > 0) {
				throw new Error(`missing tables: ${missing.join(', ')} — is db/migrations applied?`);
			}
			return `${TABLES.length} tables present`;
		},
	},
	{
		name: 's3',
		run: async () => {
			const { endpoint, bucket } = await getStorage();
			const key = `healthcheck/${Date.now()}.txt`;

			await putObject(key, new TextEncoder().encode(PROBE_BODY), 'text/plain');
			if (!(await objectExists(key))) throw new Error('object missing right after upload');
			if (new TextDecoder().decode(await getObjectBytes(key)) !== PROBE_BODY) {
				throw new Error('round trip corrupted the bytes');
			}
			await deleteObject(key);

			return `${endpoint} ${bucket} round trip ok`;
		},
	},
];

// Node throws an AggregateError with an empty message when every address family refuses.
function describe(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const first = (error as AggregateError).errors?.[0];
	return error.message || (first instanceof Error ? first.message : error.name);
}

const lines = [
	'',
	`  IS_BLACK_ENV ${isBlackEnv()}   PG_ENV ${config.PG_ENV}`,
	`  secrets from ${isBlackEnv() ? LOCAL_SECRETS_DIR : config.VAULT_PATH}`,
	'',
];
let failed = 0;

for (const check of checks) {
	try {
		lines.push(`  ok    ${check.name} — ${await check.run()}`);
	} catch (error) {
		failed += 1;
		lines.push(`  FAIL  ${check.name} — ${describe(error)}`);
	}
}

await closePool();

lines.push('', `  ${checks.length - failed}/${checks.length} passed`, '');
process.stdout.write(lines.join('\n') + '\n');
process.exitCode = failed === 0 ? 0 : 1;
