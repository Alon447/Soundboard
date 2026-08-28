import { createHash } from 'node:crypto';

import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

import { config } from '../config/index.js';
import { getSecret, SECRET_PATHS } from './secrets.js';
import { logger } from './logger.js';

// The SDK's default credential chain probes EC2 instance metadata at 169.254.169.254,
// which in a closed network hangs rather than refuses. Credentials are passed explicitly
// below; this is belt-and-braces.
process.env.AWS_EC2_METADATA_DISABLED = 'true';

const s3SecretSchema = z.object({
	S3_DOMAIN: z.string().url(),
	S3_ACCESS_ID: z.string().min(1),
	S3_SECRET_KEY: z.string().min(1),
	S3_BUCKET_NAME: z.string().min(1),
});

export type S3Secret = z.infer<typeof s3SecretSchema>;

export type Storage = {
	client: S3Client;
	bucket: string;
	endpoint: string;
};

let storage: Storage | null = null;
let pending: Promise<Storage> | null = null;

export async function getStorage(): Promise<Storage> {
	if (storage) return storage;
	pending ??= build().finally(() => {
		pending = null;
	});
	return pending;
}

async function build(): Promise<Storage> {
	const secret = await getSecret(SECRET_PATHS.s3, s3SecretSchema);

	const client = new S3Client({
		endpoint: secret.S3_DOMAIN,
		// On-prem stores ignore the region, but the SDK refuses to sign without one.
		region: config.S3_REGION,
		// https://endpoint/bucket/key. The default https://bucket.endpoint/key needs
		// wildcard DNS, which on-prem object stores generally lack.
		forcePathStyle: true,
		credentials: {
			accessKeyId: secret.S3_ACCESS_ID,
			secretAccessKey: secret.S3_SECRET_KEY,
		},
	});

	storage = { client, bucket: secret.S3_BUCKET_NAME, endpoint: secret.S3_DOMAIN };
	logger.info({ function: 'getStorage', endpoint: storage.endpoint, bucket: storage.bucket }, 'S3 client ready');
	return storage;
}

/** For credential rotation: the next getStorage() rebuilds from a freshly read secret. */
export function resetStorage(): void {
	storage?.client.destroy();
	storage = null;
}

/**
 * `sounds/<first 2 hex>/<sha256>.<ext>`. Content addressing deduplicates identical
 * uploads and makes a retried PutObject a no-op; the 2-hex prefix spreads the keyspace.
 */
export function buildObjectKey(sha256Hex: string, ext: string): string {
	if (!/^[0-9a-f]{64}$/.test(sha256Hex)) {
		throw new Error(`Expected a 64-character lowercase hex sha256, got: ${sha256Hex}`);
	}
	const clean = ext.replace(/^\.+/, '').toLowerCase();
	if (!/^[a-z0-9]{1,8}$/.test(clean)) {
		throw new Error(`Unexpected file extension: ${ext}`);
	}
	return `sounds/${sha256Hex.slice(0, 2)}/${sha256Hex}.${clean}`;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** Call before inserting rows: a failure here leaves no row pointing at nothing. */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
	const { client, bucket } = await getStorage();
	await client.send(
		new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
	);
	logger.info({ function: 'putObject', key, bytes: body.byteLength }, 'uploaded');
}

/** Preferred for the audio route. */
export async function getObjectStream(key: string): Promise<{
	body: NodeJS.ReadableStream;
	contentType: string | undefined;
	contentLength: number | undefined;
}> {
	const { client, bucket } = await getStorage();
	const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

	if (!result.Body) throw new Error(`Object ${key} has no body`);

	return {
		body: result.Body as NodeJS.ReadableStream,
		contentType: result.ContentType,
		contentLength: result.ContentLength,
	};
}

export async function getObjectBytes(key: string): Promise<Uint8Array> {
	const { client, bucket } = await getStorage();
	const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	if (!result.Body) throw new Error(`Object ${key} has no body`);
	return new Uint8Array(await result.Body.transformToByteArray());
}

export async function objectExists(key: string): Promise<boolean> {
	const { client, bucket } = await getStorage();
	try {
		await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
		return true;
	} catch (error) {
		const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
		if (status === 404) return false;
		throw error;
	}
}

/** Call after the rows are gone, best-effort: an orphaned object is harmless. */
export async function deleteObject(key: string): Promise<void> {
	const { client, bucket } = await getStorage();
	await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	logger.info({ function: 'deleteObject', key }, 'deleted');
}
