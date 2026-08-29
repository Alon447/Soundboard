import type { NextFunction, Request, Response } from 'express';

import { config } from '../config/index.js';
import { isBlackEnv } from '../utils/envCheck.js';
import { httpError } from '../utils/httpError.js';

export type AuthUser = {
	id: string;
	email: string | null;
	name: string | null;
};

declare module 'express-serve-static-core' {
	interface Request {
		user?: AuthUser;
	}
}

/**
 * Outside the closed environment there is no Keycloak to ask, so the identity comes from
 * MOCK_USER_ID. It grants no extra privileges: every ownership check below runs against
 * `req.user.id` in both modes, or they would be untested where development happens.
 */
export function requireUser(req: Request, _res: Response, next: NextFunction): void {
	if (isBlackEnv()) {
		if (!config.MOCK_USER_ID) {
			next(httpError(500, 'no_mock_identity', 'Set MOCK_USER_ID in backend/.env to develop offline'));
			return;
		}
		req.user = { id: config.MOCK_USER_ID, email: 'dev@localhost', name: 'Local Dev' };
		next();
		return;
	}

	next(httpError(501, 'not_implemented', 'Keycloak session verification is not wired up yet'));
}
