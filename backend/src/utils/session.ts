import type { Request, Response } from 'express';

import { isBlackEnv } from './envCheck.js';

export const SESSION_COOKIE = 'id_token';
export const LOGIN_TX_COOKIE = 'oidc_tx';

/** `Secure` only outside development, where the dev server is plain http on localhost. */
const base = { httpOnly: true, secure: !isBlackEnv(), sameSite: 'lax' } as const;

export function readCookie(req: Request, name: string): string | undefined {
	const header = req.headers.cookie;
	if (!header) return undefined;

	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
	}

	return undefined;
}

/**
 * Expires with the token rather than on a fixed lifetime. yanshuf3 uses a flat 12 hours,
 * which can outlive the JWT and turns a clean redirect into a 401 the client cannot fix.
 */
export function setSession(res: Response, idToken: string, exp: number | undefined): void {
	const remaining = exp === undefined ? undefined : exp * 1000 - Date.now();

	res.cookie(SESSION_COOKIE, idToken, {
		...base,
		path: '/',
		...(remaining === undefined || remaining <= 0 ? {} : { maxAge: remaining }),
	});
}

/**
 * `state`, `nonce` and the PKCE verifier have to survive the round trip to Keycloak. A
 * short-lived cookie rather than process memory, so this works behind more than one replica.
 */
export function setLoginTx(res: Response, value: object): void {
	res.cookie(LOGIN_TX_COOKIE, JSON.stringify(value), {
		...base,
		path: '/auth',
		maxAge: 10 * 60 * 1000,
	});
}

export function clearLoginTx(res: Response): void {
	res.clearCookie(LOGIN_TX_COOKIE, { ...base, path: '/auth' });
}
