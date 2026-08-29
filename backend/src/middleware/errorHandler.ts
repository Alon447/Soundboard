import type { NextFunction, Request, Response } from 'express';

import { isHttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

export function notFound(_req: Request, res: Response): void {
	res.status(404).json({ error: { code: 'not_found', message: 'No such route' } });
}

export function errorHandler(
	error: unknown,
	_req: Request,
	res: Response,
	_next: NextFunction,
): void {
	if (isHttpError(error)) {
		res.status(error.status).json({ error: { code: error.code, message: error.message } });
		return;
	}

	// Never forward the driver's text: it exposes schema, constraint and column names.
	logger.error({ error: error instanceof Error ? error.stack : String(error) }, 'unhandled');
	res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
}
