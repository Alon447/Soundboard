import type { NextFunction, Request, Response } from 'express';

import { config } from '../config/index.js';
import { isBlackEnv } from '../utils/envCheck.js';
import { httpError, isHttpError } from '../utils/httpError.js';
import { verifyIdToken } from '../utils/oidc.js';
import { readCookie, SESSION_COOKIE } from '../utils/session.js';

/**
 * Verifies the session cookie on **every** request. Both sibling projects validate once per
 * session and then only decode, so a revoked session keeps working until the cookie expires.
 * Verifying against cached JWKS costs microseconds, so there is no reason to skip it.
 *
 * Under IS_BLACK_ENV the identity comes from MOCK_USER_ID instead. It grants no extra
 * privileges: ownership is checked against `req.user.id` in both modes, or the checks would
 * be untested exactly where development happens.
 */
export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
	if (isBlackEnv()) {
		if (!config.MOCK_USER_ID) {
			next(httpError(500, 'no_mock_identity', 'Set MOCK_USER_ID in backend/.env to develop offline'));
			return;
		}
		req.user = { id: config.MOCK_USER_ID, email: 'dev@localhost', name: 'Local Dev' };
		next();
		return;
	}

	try {
		const token = readCookie(req, SESSION_COOKIE);
		if (!token) throw httpError(401, 'no_session', 'Not signed in');

		const claims = await verifyIdToken(token);

		// `upn` is the identifying claim in this realm, not `sub`. Uppercased once, here.
		const upn = typeof claims.upn === 'string' ? claims.upn.toUpperCase() : '';
		if (!upn) throw httpError(403, 'no_upn', 'Token carries no upn claim');

		req.user = {
			id: upn,
			email: typeof claims.email === 'string' ? claims.email : null,
			name: typeof claims.name === 'string' ? claims.name : null,
		};
		next();
	} catch (error) {
		if (isHttpError(error)) {
			next(error);
			return;
		}

		// jose's own failures mean the token is bad — a 401 the user can fix by signing in.
		// Anything else is Keycloak being unreachable, which is a 502: the client must show a
		// retry rather than redirect, or it loops.
		const code = (error as { code?: unknown }).code;
		next(
			typeof code === 'string' && code.startsWith('ERR_JW')
				? httpError(401, 'invalid_session', 'Session is no longer valid')
				: httpError(502, 'idp_unreachable', 'Cannot reach the identity provider'),
		);
	}
}
