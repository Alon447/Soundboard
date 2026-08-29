import { createHash, randomBytes } from 'node:crypto';

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import { config } from '../config/index.js';
import { getSecret, SECRET_PATHS } from './secrets.js';
import { logger } from './logger.js';

const oidcSecretSchema = z.object({
	client_id: z.string().min(1),
	client_secret: z.string().min(1),
});

const discoverySchema = z.object({
	issuer: z.string().min(1),
	authorization_endpoint: z.string().url(),
	token_endpoint: z.string().url(),
	jwks_uri: z.string().url(),
});

type Oidc = {
	clientId: string;
	clientSecret: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwks: ReturnType<typeof createRemoteJWKSet>;
};

const issuer = () => config.OIDC_ISSUER_URL!.replace(/\/+$/, '');

let pending: Promise<Oidc> | null = null;

/** Discovered lazily, not at import: Keycloak being down must not stop the process booting. */
export function getOidc(): Promise<Oidc> {
	pending ??= build().catch((error) => {
		pending = null;
		throw error;
	});
	return pending;
}

async function build(): Promise<Oidc> {
	const secret = await getSecret(SECRET_PATHS.oidc, oidcSecretSchema);
	const base = issuer();

	const response = await fetch(`${base}/.well-known/openid-configuration`, {
		signal: AbortSignal.timeout(config.OIDC_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`OIDC discovery failed at ${base}: ${response.status} ${response.statusText}`);
	}

	const doc = discoverySchema.parse(await response.json());

	if (doc.issuer !== base) {
		throw new Error(
			`OIDC_ISSUER_URL is "${base}" but Keycloak reports "${doc.issuer}". These must match exactly or every token verification fails.`,
		);
	}

	logger.info({ function: 'getOidc', issuer: doc.issuer }, 'OIDC discovery complete');

	return {
		clientId: secret.client_id,
		clientSecret: secret.client_secret,
		authorizationEndpoint: doc.authorization_endpoint,
		tokenEndpoint: doc.token_endpoint,
		// Caches keys and refetches on an unseen `kid`, so key rotation needs no restart.
		jwks: createRemoteJWKSet(new URL(doc.jwks_uri)),
	};
}

export async function verifyIdToken(token: string, nonce?: string): Promise<JWTPayload> {
	const oidc = await getOidc();

	const { payload } = await jwtVerify(token, oidc.jwks, {
		issuer: issuer(),
		audience: oidc.clientId,
		clockTolerance: '30s',
	});

	if (nonce !== undefined && payload.nonce !== nonce) {
		throw new Error('ID token nonce does not match the login attempt');
	}

	return payload;
}

const tokenResponseSchema = z.object({ id_token: z.string().min(1) });

/** Authenticated with `client_secret_basic`, as the sibling projects' Keycloak expects. */
export async function exchangeCode(code: string, codeVerifier: string): Promise<string> {
	const oidc = await getOidc();
	const credentials = Buffer.from(`${oidc.clientId}:${oidc.clientSecret}`).toString('base64');

	const response = await fetch(oidc.tokenEndpoint, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${credentials}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: config.OIDC_REDIRECT_URI!,
			code_verifier: codeVerifier,
		}),
		signal: AbortSignal.timeout(config.OIDC_TIMEOUT_MS),
	});

	if (!response.ok) {
		// The body of a failed exchange can echo the request back. Never log or forward it.
		throw new Error(`Token exchange rejected with ${response.status} ${response.statusText}`);
	}

	return tokenResponseSchema.parse(await response.json()).id_token;
}

export function newPkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	return {
		verifier,
		challenge: createHash('sha256').update(verifier).digest('base64url'),
	};
}

export const randomToken = (): string => randomBytes(32).toString('base64url');
