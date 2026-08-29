import { z } from 'zod';
import dotenv from 'dotenv';

// Loads backend/.env locally; a no-op in containers, where the platform injects the env.
dotenv.config();

/** Treats whitespace-only as absent, so a blank line in .env behaves like no line. */
const blank = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const optionalEnv = z.preprocess(blank, z.string().trim().min(1).optional());

/** "true" in any case is true; everything else, including absent, is false. */
const boolEnv = z.preprocess(
	blank,
	z
		.string()
		.default('false')
		.transform((value) => value.toLowerCase() === 'true'),
);

const intEnv = (fallback: number) =>
	z.preprocess(
		blank,
		z
			.string()
			.default(String(fallback))
			.transform((value) => Number(value))
			.pipe(z.number().int().positive()),
	);

const configSchema = z
	.object({
		NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
		PORT: intEnv(3001),

		/**
		 * True outside the closed environment: secrets from local files, identity mocked,
		 * S3 pointed at MinIO. It must never grant privileges — a mock user is an ordinary
		 * user. See docs/house-conventions.md.
		 */
		IS_BLACK_ENV: boolEnv,

		PG_ENV: z.enum(['dev', 'prod']).default('dev'),

		/**
		 * The `user_sounds.user_id` the mock identity owns, used only when IS_BLACK_ENV.
		 * Set it to your Supabase user UUID to develop against your real board; it becomes
		 * a Keycloak `upn` once db/migrations/0002 has rewritten the column.
		 */
		MOCK_USER_ID: optionalEnv,

		// Optional here, then required by superRefine unless IS_BLACK_ENV. Declaring them
		// unconditionally required would force dummy values on every developer.
		/** KV v2 mount, e.g. https://vault.internal/v1/kv — /data/<name> is appended. */
		VAULT_PATH: optionalEnv,
		VAULT_TOKEN: optionalEnv,

		SECRET_TTL_MS: intEnv(5 * 60 * 1000),
		VAULT_TIMEOUT_MS: intEnv(5_000),

		/** Must be byte-identical to the `iss` claim, or every verification fails. */
		OIDC_ISSUER_URL: optionalEnv,
		OIDC_REDIRECT_URI: optionalEnv,
		OIDC_SCOPE: z.preprocess(blank, z.string().trim().min(1).default('openid')),
		OIDC_TIMEOUT_MS: intEnv(5_000),

		/** Only the region the SDK insists on signing with; on-prem stores ignore it. */
		S3_REGION: z.preprocess(blank, z.string().trim().min(1).default('us-east-1')),

		MAX_UPLOAD_BYTES: intEnv(15 * 1024 * 1024),
	})
	.superRefine((value, ctx) => {
		if (value.IS_BLACK_ENV) return;

		for (const key of ['VAULT_PATH', 'VAULT_TOKEN', 'OIDC_ISSUER_URL', 'OIDC_REDIRECT_URI'] as const) {
			if (!value[key]) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [key],
					message: 'required unless IS_BLACK_ENV=true',
				});
			}
		}
	});

export type Config = z.infer<typeof configSchema>;

const parseConfig = (): Config => {
	const result = configSchema.safeParse(process.env);

	if (!result.success) {
		const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
		console.error(`Invalid environment configuration:\n${issues}`);
		process.exit(1);
	}

	return result.data;
};

export const config: Config = parseConfig();
