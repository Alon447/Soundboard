import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ZodType, ZodTypeDef } from 'zod';

import { config } from '../config/index.js';
import { isBlackEnv } from './envCheck.js';
import { logger } from './logger.js';

export type Secret = Record<string, string>;

export const SECRET_PATHS = {
	/** S3_DOMAIN, S3_ACCESS_ID, S3_SECRET_KEY, S3_BUCKET_NAME */
	s3: 's3',
	/** host, database, user, password, writePort */
	postgresDev: 'db/postgres/dev',
	postgresProd: 'db/postgres/prod',
	/** client_id, client_secret */
	oidc: 'idp/keycloak/soundboard',
} as const;

export type SecretPath = (typeof SECRET_PATHS)[keyof typeof SECRET_PATHS];

export const postgresSecretPath = (): SecretPath =>
	config.PG_ENV === 'prod' ? SECRET_PATHS.postgresProd : SECRET_PATHS.postgresDev;

// Two levels up, not three: the container copies backend/ to /app, so anything resolved
// above the backend root points outside the image.
export const LOCAL_SECRETS_DIR = path.resolve(import.meta.dirname, '..', '..', 'local_secrets');

type CacheEntry = { value: Secret; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Secret>>();

/**
 * Resolved at call time, never at import: the process must boot with the secret store
 * unreachable. Pass a schema to validate the shape — the type argument alone is a cast.
 */
export async function getSecret<Fields extends Secret = Secret>(
	name: string,
	schema?: ZodType<Fields, ZodTypeDef, unknown>,
): Promise<Fields> {
	const cached = cache.get(name);
	if (cached && cached.expiresAt > Date.now()) {
		return (schema ? schema.parse(cached.value) : cached.value) as Fields;
	}

	let pending = inFlight.get(name);
	if (!pending) {
		pending = loadSecret(name)
			.then((value) => {
				cache.set(name, { value, expiresAt: Date.now() + config.SECRET_TTL_MS });
				return value;
			})
			.finally(() => {
				inFlight.delete(name);
			});
		inFlight.set(name, pending);
	}

	const value = await pending;
	return (schema ? schema.parse(value) : value) as Fields;
}

export function invalidateSecret(name?: string): void {
	if (name === undefined) cache.clear();
	else cache.delete(name);
}

async function loadSecret(name: string): Promise<Secret> {
	const source = isBlackEnv() ? 'file' : 'vault';
	logger.debug({ function: 'getSecret', secret: name, source }, 'reading secret');
	return isBlackEnv() ? readFromFile(name) : readFromVault(name);
}

async function readFromFile(name: string): Promise<Secret> {
	const file = path.resolve(LOCAL_SECRETS_DIR, name);

	// Names are internal constants today, but keep the containment check so a future
	// caller-supplied name cannot escape the directory.
	if (!file.startsWith(LOCAL_SECRETS_DIR + path.sep)) {
		throw new Error(`Invalid secret name: ${name}`);
	}

	let raw: string;
	try {
		raw = await readFile(file, 'utf8');
	} catch (cause) {
		throw new Error(
			`Cannot read secret ${name} from ${file}. Create it, or unset IS_BLACK_ENV to use Vault.`,
			{ cause },
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new Error(`Secret ${name} is not valid JSON: ${(cause as Error).message}`, { cause });
	}

	return toSecret(parsed, name);
}

async function readFromVault(name: string): Promise<Secret> {
	// Non-null: config.superRefine requires both unless IS_BLACK_ENV.
	const base = config.VAULT_PATH!.replace(/\/+$/, '');
	const url = `${base}/data/${name}`;

	let response: Response;
	try {
		response = await fetch(url, {
			headers: { 'X-Vault-Token': config.VAULT_TOKEN!, Accept: 'application/json' },
			signal: AbortSignal.timeout(config.VAULT_TIMEOUT_MS),
		});
	} catch (cause) {
		// Never put the token or the response body in the message.
		throw new Error(`Cannot reach Vault at ${url}: ${(cause as Error).message}`, { cause });
	}

	if (!response.ok) {
		throw new Error(
			`Vault returned ${response.status} ${response.statusText} for secret ${name} at ${url}`,
		);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		throw new Error(`Vault response for secret ${name} is not JSON`, { cause });
	}

	// KV v2 nests twice: { data: { data: {...}, metadata: {...} } }.
	const data = (body as { data?: { data?: unknown } })?.data?.data;
	if (data === undefined) {
		throw new Error(
			`Vault response for secret ${name} has no data.data — is ${base} a KV v2 mount?`,
		);
	}

	return toSecret(data, name);
}

/**
 * Numbers and booleans are stringified: a port written as 6543 rather than "6543" is
 * normal in a hand-authored local file, and Vault returns whatever was stored. Callers
 * therefore always get strings.
 */
function toSecret(value: unknown, name: string): Secret {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`Secret ${name} must be a JSON object`);
	}

	const secret: Secret = {};
	const invalid: string[] = [];

	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === 'string') secret[key] = entry;
		else if (typeof entry === 'number' || typeof entry === 'boolean') secret[key] = String(entry);
		else invalid.push(`${key} (${entry === null ? 'null' : typeof entry})`);
	}

	if (invalid.length > 0) {
		throw new Error(
			`Secret ${name} has fields that are not string, number or boolean: ${invalid.join(', ')}`,
		);
	}

	return secret;
}
