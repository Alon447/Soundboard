import { Router } from 'express';

export const meRouter = Router();

// Shaped for the frontend's useAuth context, so App.tsx needs no changes.
meRouter.get('/', (req, res) => {
	const user = req.user!;
	res.json({ id: user.id, email: user.email, user_metadata: { name: user.name } });
});
