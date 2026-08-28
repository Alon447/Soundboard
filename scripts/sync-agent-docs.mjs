#!/usr/bin/env node
/**
 * Mirrors .kiro/skills/ -> .claude/skills/ so Kiro and Claude Code never drift.
 *
 * .kiro/skills is the source of truth. Both tools implement the same open
 * Agent Skills standard (SKILL.md + frontmatter + references/), so the files are
 * byte-identical and a copy is all that is needed.
 *
 *   node scripts/sync-agent-docs.mjs           # copy, reporting what changed
 *   node scripts/sync-agent-docs.mjs --check   # report drift, exit 1, copy nothing
 *
 * Wired into `npm run docs:sync` / `npm run docs:check` and the Kiro Stop hook
 * at .kiro/hooks/sync-agent-docs.json.
 *
 * Prose docs in docs/ and the Copilot files in .github/ are NOT mechanically
 * derived and are not touched here — see .kiro/skills/docs-sync/SKILL.md.
 */

import { readdir, readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(repoRoot, '.kiro', 'skills');
const TARGET = join(repoRoot, '.claude', 'skills');

const checkOnly = process.argv.includes('--check');

/** Every file under `dir`, as paths relative to `dir`, POSIX-separated. */
async function listFiles(dir) {
	const out = [];
	async function walk(current) {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (err) {
			if (err.code === 'ENOENT') return;
			throw err;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) out.push(relative(dir, full).split('\\').join('/'));
		}
	}
	await walk(dir);
	return out.sort();
}

async function readOrNull(path) {
	try {
		return await readFile(path);
	} catch (err) {
		if (err.code === 'ENOENT') return null;
		throw err;
	}
}

try {
	await stat(SOURCE);
} catch {
	console.error(`error: source ${relative(repoRoot, SOURCE)} does not exist`);
	process.exit(1);
}

const sourceFiles = await listFiles(SOURCE);
const targetFiles = await listFiles(TARGET);

if (sourceFiles.length === 0) {
	console.error(`error: no files found under ${relative(repoRoot, SOURCE)}`);
	process.exit(1);
}

const added = [];
const changed = [];
const removed = targetFiles.filter((f) => !sourceFiles.includes(f));

for (const file of sourceFiles) {
	const src = await readFile(join(SOURCE, file));
	const dest = await readOrNull(join(TARGET, file));
	if (dest === null) added.push(file);
	else if (!src.equals(dest)) changed.push(file);
}

const drifted = added.length + changed.length + removed.length;

if (drifted === 0) {
	console.log(`agent skills in sync (${sourceFiles.length} files)`);
	process.exit(0);
}

for (const f of added) console.log(`${checkOnly ? 'missing' : 'added  '}  .claude/skills/${f}`);
for (const f of changed) console.log(`${checkOnly ? 'stale  ' : 'updated'}  .claude/skills/${f}`);
for (const f of removed) console.log(`${checkOnly ? 'orphan ' : 'removed'}  .claude/skills/${f}`);

if (checkOnly) {
	console.error(`\n${drifted} file(s) out of sync. Run: npm run docs:sync`);
	process.exit(1);
}

for (const file of [...added, ...changed]) {
	const destPath = join(TARGET, file);
	await mkdir(dirname(destPath), { recursive: true });
	await writeFile(destPath, await readFile(join(SOURCE, file)));
}
for (const file of removed) {
	await rm(join(TARGET, file), { force: true });
}

console.log(`\nsynced ${drifted} file(s) from .kiro/skills to .claude/skills`);
