import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../utils/pg.js';
import { httpError } from '../utils/httpError.js';

// `::text` on the ownership predicate so these queries work against both the Supabase
// column (still uuid until db/migrations/0002 runs) and the target text column.
const OWNED = 'user_id::text = $1';

// gain is numeric in the pre-0002 schema and node-postgres returns numeric as a string,
// which breaks arithmetic in the client. The cast makes it a JSON number either way.
const COLUMNS = `id, user_id, sound_id, shared_sound_id, name, color, icon,
                 gain::double precision as gain, position, created_at`;

const pad = z.object({
	sound_id: z.string().min(1).max(120),
	name: z.string().min(1).max(120),
	color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
	icon: z.string().min(1).max(60),
	gain: z.number().min(0).max(10).default(1),
});

// An array so one route covers both a single add and seeding a fresh board.
const createBody = z.array(pad).min(1).max(64);

const patchBody = z
	.object({
		name: z.string().min(1).max(120),
		color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		icon: z.string().min(1).max(60),
		gain: z.number().min(0).max(10),
	})
	.partial()
	.refine((body) => Object.keys(body).length > 0, 'no fields to update');

const reorderBody = z.object({
	order: z.array(z.string().uuid()).min(1),
});

export const userSoundsRouter = Router();

userSoundsRouter.get('/', async (req, res, next) => {
	try {
		const pool = await getPool();
		const { rows } = await pool.query(
			`select ${COLUMNS} from user_sounds where ${OWNED} order by position`,
			[req.user!.id],
		);
		res.json(rows);
	} catch (error) {
		next(error);
	}
});

userSoundsRouter.post('/', async (req, res, next) => {
	try {
		const parsed = createBody.safeParse(req.body);
		if (!parsed.success) {
			throw httpError(400, 'invalid_body', 'expected an array of pads');
		}

		// sound_id is not checked against a list of built-ins: the server has no copy of one.
		// A pad naming a sound the client does not know renders silent.
		const pool = await getPool();
		const { rows } = await pool.query(
			`insert into user_sounds (user_id, sound_id, name, color, icon, gain, position)
			 select $1, incoming.sound_id, incoming.name, incoming.color, incoming.icon, incoming.gain,
			        coalesce((select max(position) + 1 from user_sounds where ${OWNED}), 0) + incoming.idx
			   from jsonb_to_recordset($2::jsonb)
			        as incoming(sound_id text, name text, color text, icon text,
			                    gain double precision, idx int)
			 returning ${COLUMNS}`,
			[
				req.user!.id,
				JSON.stringify(parsed.data.map((entry, index) => ({ ...entry, idx: index }))),
			],
		);

		res.status(201).json(rows);
	} catch (error) {
		next(error);
	}
});

userSoundsRouter.patch('/:id', async (req, res, next) => {
	try {
		const parsed = patchBody.safeParse(req.body);
		if (!parsed.success) throw httpError(400, 'invalid_body', 'nothing valid to update');

		const entries = Object.entries(parsed.data);
		const assignments = entries.map(([column], index) => `${column} = $${index + 3}`).join(', ');

		const pool = await getPool();
		const { rows } = await pool.query(
			`update user_sounds set ${assignments}
			  where id = $2 and ${OWNED}
			 returning ${COLUMNS}`,
			[req.user!.id, req.params.id, ...entries.map(([, value]) => value)],
		);

		if (rows.length === 0) throw httpError(404, 'not_found', 'No such pad on your board');
		res.json(rows[0]);
	} catch (error) {
		next(error);
	}
});

userSoundsRouter.post('/reorder', async (req, res, next) => {
	try {
		const parsed = reorderBody.safeParse(req.body);
		if (!parsed.success) throw httpError(400, 'invalid_body', 'order must be an array of pad ids');

		const pool = await getPool();
		const client = await pool.connect();

		try {
			await client.query('begin');

			const owned = await client.query<{ count: string }>(
				`select count(*) from user_sounds where ${OWNED}`,
				[req.user!.id],
			);

			if (Number(owned.rows[0]?.count) !== parsed.data.order.length) {
				throw httpError(400, 'incomplete_order', 'order must list every pad on your board exactly once');
			}

			const updated = await client.query(
				`update user_sounds us set position = ordered.pos - 1
				   from unnest($2::uuid[]) with ordinality as ordered(id, pos)
				  where us.id = ordered.id and us.${OWNED}`,
				[req.user!.id, parsed.data.order],
			);

			if (updated.rowCount !== parsed.data.order.length) {
				throw httpError(400, 'incomplete_order', 'order contains pads that are not yours');
			}

			await client.query('commit');
			res.status(204).end();
		} catch (error) {
			await client.query('rollback').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	} catch (error) {
		next(error);
	}
});

userSoundsRouter.delete('/:id', async (req, res, next) => {
	try {
		const pool = await getPool();
		const { rowCount } = await pool.query(
			`delete from user_sounds where id = $2 and ${OWNED}`,
			[req.user!.id, req.params.id],
		);

		if (!rowCount) throw httpError(404, 'not_found', 'No such pad on your board');
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});
