import { Pool } from 'pg';
import { z } from 'zod';

import { getSecret, postgresSecretPath } from './secrets.js';
import { logger } from './logger.js';

const pgSecretSchema = z.object({
	host: z.string().min(1),
	database: z.string().min(1),
	user: z.string().min(1),
	password: z.string().min(1),
	writePort: z.string().min(1),
});

let poolPromise: Promise<Pool> | null = null;

/** One pool for the process. Never build a pool per request. */
export function getPool(): Promise<Pool> {
	poolPromise ??= build().catch((error) => {
		poolPromise = null;
		throw error;
	});
	return poolPromise;
}

async function build(): Promise<Pool> {
	const { host, database, user, password, writePort } = await getSecret(
		postgresSecretPath(),
		pgSecretSchema,
	);

	const pool = new Pool({
		host,
		database,
		user,
		password,
		port: Number(writePort),
		ssl: { rejectUnauthorized: false },
	});

	// Without a listener, a dropped idle client takes the process down.
	pool.on('error', (error) => logger.error({ error: error.message }, 'idle client error'));

	try {
		await pool.query('select 1');
	} catch (error) {
		await pool.end().catch(() => {});
		throw error;
	}

	logger.info({ host, database, port: writePort }, 'PostgreSQL pool ready');
	return pool;
}

export async function closePool(): Promise<void> {
	const existing = poolPromise;
	poolPromise = null;
	await existing?.then((pool) => pool.end()).catch(() => {});
}
