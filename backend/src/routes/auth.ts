import { Router } from 'express';
import { z } from 'zod';

import { config } from '../config/index.js';
import { httpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';
import { exchangeCode, getOidc, newPkce, randomToken, verifyIdToken } from '../utils/oidc.js';
import { clearLoginTx, LOGIN_TX_COOKIE, readCookie, setLoginTx, setSession } from '../utils/session.js';

export const authRouter = Router();

const loginTxSchema = z.object({
	state: z.string().min(1),
	nonce: z.string().min(1),
	verifier: z.string().min(1),
	returnTo: z.string().min(1),
});

/**
 * Strips any origin, leaving a path on this host. `state` doubles as the return URL, so
 * without this an attacker could hand us an absolute URL and get an open redirect.
 */
function safeReturnTo(raw: unknown): string {
	if (typeof raw !== 'string' || raw.length === 0) return '/';
	try {
		const url = new URL(raw, 'http://placeholder.invalid');
		return `${url.pathname}${url.search}${url.hash}` || '/';
	} catch {
		return '/';
	}
}

authRouter.get('/login', async (req, res, next) => {
	try {
		const oidc = await getOidc();
		const { verifier, challenge } = newPkce();
		const state = randomToken();
		const nonce = randomToken();

		setLoginTx(res, { state, nonce, verifier, returnTo: safeReturnTo(req.query.state) });

		const url = new URL(oidc.authorizationEndpoint);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('client_id', oidc.clientId);
		url.searchParams.set('redirect_uri', config.OIDC_REDIRECT_URI!);
		url.searchParams.set('scope', config.OIDC_SCOPE);
		url.searchParams.set('state', state);
		url.searchParams.set('nonce', nonce);
		url.searchParams.set('code_challenge', challenge);
		url.searchParams.set('code_challenge_method', 'S256');

		res.redirect(url.toString());
	} catch (error) {
		next(error);
	}
});

authRouter.get('/callback', async (req, res, next) => {
	const tx = loginTxSchema.safeParse(JSON.parse(readCookie(req, LOGIN_TX_COOKIE) ?? 'null') as unknown);
	clearLoginTx(res);

	try {
		if (typeof req.query.error === 'string') {
			logger.warn({ error: req.query.error }, 'Keycloak returned an error to /auth/callback');
			throw httpError(401, 'login_failed', 'Sign-in was refused or cancelled');
		}

		if (!tx.success) {
			throw httpError(400, 'login_expired', 'That sign-in attempt expired. Try again.');
		}

		if (req.query.state !== tx.data.state) {
			throw httpError(400, 'state_mismatch', 'Sign-in state did not match. Try again.');
		}

		if (typeof req.query.code !== 'string') {
			throw httpError(400, 'missing_code', 'No authorization code in the callback');
		}

		const idToken = await exchangeCode(req.query.code, tx.data.verifier);
		const claims = await verifyIdToken(idToken, tx.data.nonce);

		setSession(res, idToken, claims.exp);
		res.redirect(tx.data.returnTo);
	} catch (error) {
		next(error);
	}
});
