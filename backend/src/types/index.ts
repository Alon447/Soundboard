export type AuthUser = {
	id: string;
	email: string | null;
	name: string | null;
};

// Keep this the only augmentation of Request. A second one elsewhere merges silently and
// the next reader cannot tell where `req.user` comes from.
declare module 'express-serve-static-core' {
	interface Request {
		user?: AuthUser;
	}
}
