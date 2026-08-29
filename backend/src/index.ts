import { app } from './app.js';
import { config } from './config/index.js';
import { isBlackEnv } from './utils/envCheck.js';
import { logger } from './utils/logger.js';
import { closePool, getPool } from './utils/pg.js';

// Fail before listening: a process that accepts requests with no database only produces
// 500s and a confusing incident.
try {
	await getPool();
} catch (error) {
	logger.error(
		{ error: error instanceof Error ? error.message : String(error) },
		'startup failed: no database',
	);
	process.exit(1);
}

const server = app.listen(config.PORT, () => {
	logger.info({ port: config.PORT, mockIdentity: isBlackEnv() }, 'API listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		server.close(() => {
			void closePool().then(() => process.exit(0));
		});
	});
}
