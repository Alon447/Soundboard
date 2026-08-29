import { Router } from 'express';

import { requireUser } from '../middleware/requireUser.js';
import { meRouter } from './me.js';
import { userSoundsRouter } from './userSounds.js';

export const apiRouter = Router();

// requireUser is applied per mount rather than to the whole router, so an unauthenticated
// route added later has to opt out deliberately instead of by omission.
apiRouter.use('/me', requireUser, meRouter);
apiRouter.use('/user-sounds', requireUser, userSoundsRouter);
