/**
 * Object-first structured logging, matching the sibling projects' call shape. Kept
 * dependency-free rather than using pino: in a closed environment every dependency is one
 * more package to mirror into Nexus, and pino is a drop-in replacement later if wanted.
 *
 * Never log a secret value — log its path.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

type Fields = Record<string, unknown>;

const write = (level: Level, fields: Fields, message: string) => {
	const line = JSON.stringify({ level, time: new Date().toISOString(), ...fields, message });
	if (level === 'error' || level === 'warn') console.error(line);
	else console.log(line);
};

const at = (level: Level) =>
	function log(fieldsOrMessage: Fields | string, maybeMessage?: string): void {
		if (typeof fieldsOrMessage === 'string') write(level, {}, fieldsOrMessage);
		else write(level, fieldsOrMessage, maybeMessage ?? '');
	};

export const logger = {
	debug: at('debug'),
	info: at('info'),
	warn: at('warn'),
	error: at('error'),
};
