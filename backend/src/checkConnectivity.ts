/**
 * `npm run api:check` — proves the backend can reach Vault (or the local secret files) and
 * round-trip an object through S3, and names the likely misconfiguration when it cannot.
 *
 * Safe against production: it writes one small object under `healthcheck/`, reads it back
 * and deletes it. Secret field names are printed, never values.
 */

import { config } from './config/index.js';
import { isBlackEnv } from './utils/envCheck.js';
import { getSecret, LOCAL_SECRETS_DIR, postgresSecretPath, SECRET_PATHS } from './utils/secrets.js';
import { deleteObject, getObjectBytes, getStorage, objectExists, putObject } from './utils/s3.js';

type Result = { name: string; ok: boolean; detail: string };

const HEALTHCHECK_BODY = 'soundboard connectivity check';

/**
 * Node throws an AggregateError with an *empty* message when every address family is
 * refused, and the AWS SDK buries detail in `cause`. Reporting `error.message` alone
 * prints nothing at all for the most common failure here.
 */
function describe(error: unknown): string {
	if (!(error instanceof Error)) return String(error);

	const parts: string[] = [error.message];

	for (const entry of (error as AggregateError).errors ?? []) {
		const code = (entry as NodeJS.ErrnoException)?.code;
		const message = entry instanceof Error ? entry.message : String(entry);
		parts.push(code ? `${code} ${message}`.trim() : message);
	}

	for (let cause = error.cause; cause instanceof Error; cause = cause.cause) {
		parts.push(cause.message);
	}

	const code = (error as NodeJS.ErrnoException).code;
	if (code) parts.push(`code ${code}`);

	return [...new Set(parts.filter(Boolean))].join(' — ') || error.name;
}

async function attempt(name: string, run: () => Promise<string>): Promise<Result> {
	try {
		return { name, ok: true, detail: await run() };
	} catch (error) {
		return { name, ok: false, detail: describe(error) };
	}
}

async function run(): Promise<Result[]> {
	const results: Result[] = [];

	const s3Secret = await attempt(`secret: ${SECRET_PATHS.s3}`, async () => {
		const secret = await getSecret(SECRET_PATHS.s3);
		return `fields: ${Object.keys(secret).sort().join(', ')}`;
	});
	results.push(s3Secret);

	results.push(
		await attempt(`secret: ${postgresSecretPath()}`, async () => {
			const secret = await getSecret(postgresSecretPath());
			return `fields: ${Object.keys(secret).sort().join(', ')}`;
		}),
	);

	if (!s3Secret.ok) {
		results.push({
			name: 's3: round trip',
			ok: false,
			detail: 'skipped — the s3 secret could not be read',
		});
		return results;
	}

	const client = await attempt('s3: client', async () => {
		const { endpoint, bucket } = await getStorage();
		return `endpoint ${endpoint}, bucket ${bucket}, path-style`;
	});
	results.push(client);
	if (!client.ok) return results;

	const key = `healthcheck/${Date.now()}.txt`;

	const put = await attempt('s3: put', async () => {
		await putObject(key, new TextEncoder().encode(HEALTHCHECK_BODY), 'text/plain');
		return key;
	});
	results.push(put);
	if (!put.ok) return results;

	results.push(
		await attempt('s3: head', async () => {
			if (!(await objectExists(key))) {
				throw new Error('object reported missing immediately after upload');
			}
			return 'present';
		}),
	);

	results.push(
		await attempt('s3: get', async () => {
			const bytes = await getObjectBytes(key);
			const text = new TextDecoder().decode(bytes);
			if (text !== HEALTHCHECK_BODY) {
				throw new Error(`round trip corrupted: got ${JSON.stringify(text)}`);
			}
			return `${bytes.byteLength} bytes matched`;
		}),
	);

	// Attempted even if the read failed, so a partial run leaves nothing behind.
	results.push(
		await attempt('s3: delete', async () => {
			await deleteObject(key);
			return 'cleaned up';
		}),
	);

	return results;
}

function report(results: Result[]): string {
	const lines = [
		'',
		'Soundboard backend connectivity check',
		`  IS_BLACK_ENV : ${isBlackEnv()}  (${isBlackEnv() ? 'local files + MinIO' : 'Vault + internal S3'})`,
		`  PG_ENV       : ${config.PG_ENV}`,
		`  secrets from : ${isBlackEnv() ? LOCAL_SECRETS_DIR : config.VAULT_PATH}`,
		'',
	];

	for (const result of results) {
		lines.push(`  ${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
	}

	const failed = results.filter((result) => !result.ok);
	lines.push('');

	if (failed.length === 0) {
		lines.push(`  All ${results.length} checks passed.`, '');
		return lines.join('\n');
	}

	lines.push(
		`  ${failed.length} of ${results.length} checks failed.`,
		'',
		'  Common causes:',
		'    ECONNREFUSED on localhost:9010   MinIO is not running',
		'    untrusted internal CA            set NODE_EXTRA_CA_CERTS to the CA bundle',
		'    Vault 403 / permission denied    VAULT_TOKEN expired, or lacks read on the path',
		'    Vault "no data.data"             VAULT_PATH is not a KV v2 mount',
		'    S3 DNS failure on a bucket host  check S3_DOMAIN is the endpoint, not the bucket',
		'    S3 SignatureDoesNotMatch         wrong S3_SECRET_KEY, or a proxy rewrote the request',
		'',
	);

	return lines.join('\n');
}

const results = await run();

// One synchronous write. Per-line console.log lost output on both streams after a failed
// AWS SDK call, and a diagnostics script that loses its diagnostics is worse than useless.
process.stdout.write(report(results) + '\n');

// Set the code rather than calling process.exit(), which can truncate a pending write.
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
