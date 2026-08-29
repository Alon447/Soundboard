export type HttpError = Error & { status: number; code: string };

export function httpError(status: number, code: string, message: string): HttpError {
	return Object.assign(new Error(message), { status, code });
}

export function isHttpError(error: unknown): error is HttpError {
	return error instanceof Error && typeof (error as HttpError).status === 'number';
}
