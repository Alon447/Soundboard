import express, { type NextFunction, type Request, type Response } from 'express';

import { config } from './config/index.js';
import { isBlackEnv } from './utils/envCheck.js';
import { logger } from './utils/logger.js';
import { closePool, getPool } from './utils/pg.js';
import { isHttpError } from './utils/httpError.js';
import { requireUser } from './middleware/requireUser.js';
import { userSoundsRouter } from './routes/userSounds.js';

const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
	res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
	const user = req.user!;
	res.json({ id: user.id, email: user.email, user_metadata: { name: user.name } });
});

app.use('/api/user-sounds', requireUser, userSoundsRouter);

app.use((_req, res) => {
	res.status(404).json({ error: { code: 'not_found', message: 'No such route' } });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
	if (isHttpError(error)) {
		res.status(error.status).json({ error: { code: error.code, message: error.message } });
		return;
	}

	// Never forward the driver's text: it exposes schema, constraint and column names.
	logger.error({ error: error instanceof Error ? error.stack : String(error) }, 'unhandled');
	res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
});

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
