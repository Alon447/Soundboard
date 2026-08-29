import axios, { type AxiosError } from 'axios';

const client = axios.create({
	baseURL: '/api',
	// The session is an httpOnly cookie; there is no token to attach.
	withCredentials: true,
});

/**
 * Collapse the server's `{ error: { code, message } }` into a plain Error here, so no call
 * site unwraps it. react-query turns the throw into `error` state on its own.
 */
client.interceptors.response.use(undefined, (error: AxiosError<{ error?: { message?: string } }>) => {
	throw new Error(error.response?.data?.error?.message ?? error.message);
});

export const api = {
	get: async <T>(path: string) => (await client.get<T>(path)).data,
	post: async <T>(path: string, body?: unknown) => (await client.post<T>(path, body)).data,
	patch: async <T>(path: string, body?: unknown) => (await client.patch<T>(path, body)).data,
	remove: async (path: string) => {
		await client.delete(path);
	},
};
