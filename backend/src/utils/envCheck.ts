import { config } from '../config/index.js';

/** True outside the closed environment. Read the flag here so every branch is greppable. */
export const isBlackEnv = (): boolean => config.IS_BLACK_ENV;
