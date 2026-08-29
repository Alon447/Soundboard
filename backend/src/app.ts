import express from 'express';

import { errorHandler, notFound } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';
import { authRouter } from './routes/auth.js';

export const app = express();

app.use(express.json({ limit: '1mb' }));
// /auth is browser-facing redirects, /api is the JSON surface. Neither is nested in the other.
app.use('/auth', authRouter);
app.use('/api', apiRouter);
app.use(notFound);
app.use(errorHandler);
