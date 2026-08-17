import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
} from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';

import { migrateSource } from './pipeline.ts';
import type { LintState } from './pipeline.ts';
import { MIGRATIONS } from './migrations/index.ts';
import { versioningDisabled } from './context.ts';
import { errorMessage, parseWorkflow } from './migrate.ts';
import type { Context, Migration, ReportEntry, RunStatus } from './migrate.ts';

export const WORKFLOW_PATH = '.github/workflows/flowzone.yml';

/**
 * A complete caller workflow, matching the usage snippet flowzone documents. It
 * stands on its own rather than relying on the migrations to finish it — a test
 * asserts it needs no migration, so it cannot drift from them.
 *
 * Repository-specific additions, such as the npm publishing permissions, are
 * still left to the migrations, since only they know what the repository is.
 */
export const CALLER_TEMPLATE = `name: Flowzone

on:
  # Internal and fork PRs both run here; forks run with no secrets.
  pull_request:
    types: [opened, synchronize, closed]
    branches: [main, master]
  # Fork contributions are rebuilt and published from the push to the default
  # branch after merge.
  push:
    branches: [main, master]

jobs:
  flowzone:
    name: Flowzone
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    secrets: inherit
`;

/**
 * The facts about the surrounding repository that migrations are allowed to see.
 * Deliberately small: the transform stays a function of the workflow file plus a
 * couple of booleans, not of the whole repository.
 */
function repoContext(cwd: string): Context {
	return {
		isNpmPackage: publishesToNpm(cwd),
		customActions: customActions(cwd),
	};
}

/**
 * The custom actions this repository defines. Flowzone decides which custom jobs
 * exist by looking for these directories, so migrations that reason about custom
 * jobs look in the same place. Reports whatever is there rather than a known
 * list: the context supplies the fact, each migration owns the policy.
 */
function customActions(cwd: string): string[] {
	try {
		return readdirSync(join(cwd, '.github', 'actions'), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/**
 * The repository a workflow belongs to, so that context comes from the file being
 * migrated rather than from wherever the tool happened to be invoked.
 *
 * GitHub reads workflows only from `.github/workflows/` at the repository root, so
 * for a real caller the path already holds the root exactly and no filesystem search
 * is needed. Walking up for a `.git` instead would be worse: it is a file rather than
 * a directory in a worktree or a submodule, and it still needs this fallback for a
 * path that is not a workflow location at all.
 *
 * That fallback stays deliberately dumb. A path outside `.github/workflows/` yields a
 * directory with no `package.json` and no `.github/actions`, and the migrations that
 * want those skip rather than guess.
 */
function repoRootFor(path: string): string {
	const parts = resolve(path).split(sep);
	return parts.at(-2) === 'workflows' && parts.at(-3) === '.github'
		? parts.slice(0, -3).join(sep) || sep
		: dirname(path);
}

function publishesToNpm(cwd: string): boolean {
	try {
		// A package marked private is never published.
		return (
			JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).private !==
			true
		);
	} catch {
		return false;
	}
}

function selectMigrations(only?: string[]): Migration[] {
	if (only == null) {
		return MIGRATIONS;
	}

	// An explicit selection with nothing in it is a caller bug, and neither reading
	// of it is safe to guess at: running every migration would write a file nobody
	// asked to change, and running none would report a stale caller as up to date.
	if (only.length === 0) {
		throw new Error(
			'no migration ids given; omit --only to run every migration',
		);
	}

	const unknown = only.filter(
		(id) => !MIGRATIONS.some((unit) => unit.id === id),
	);
	if (unknown.length > 0) {
		throw new Error(`unknown migration id: ${unknown.join(', ')}`);
	}

	return MIGRATIONS.filter((unit) => only.includes(unit.id));
}

interface MigrateFileOptions {
	only?: string[];
	lint?: boolean;
	cwd?: string;
}

export interface FileResult {
	path: string;
	status: RunStatus | 'error' | 'skipped';
	changed: boolean;
	report: ReportEntry[];
	error?: string;
	lintChecked?: LintState;
	/**
	 * Whether the migrated caller turns flowzone's versioning off. Reported for a
	 * workflow that got as far as a result, so whoever commits it knows whether the
	 * commit needs a versionist footer.
	 */
	versioningDisabled?: boolean;
}

/**
 * Migrate one workflow file. Anything short of a clean, validated result leaves
 * the file exactly as it was: a half-migrated workflow is worse than an old one.
 */
export function migrateFile(
	path: string,
	{ only, lint = true, cwd }: MigrateFileOptions = {},
): FileResult {
	const units = selectMigrations(only);
	const root = cwd ?? repoRootFor(path);

	let before: string;
	try {
		before = readFileSync(path, 'utf8');
	} catch (error) {
		return {
			path,
			status: 'error',
			changed: false,
			report: [],
			error: errorMessage(error),
		};
	}

	const decision = migrateSource(before, {
		units,
		context: repoContext(root),
		lint,
	});

	switch (decision.outcome) {
		case 'unparseable':
		case 'not a caller':
			return {
				path,
				status: decision.outcome === 'not a caller' ? 'skipped' : 'error',
				changed: false,
				report: [],
				error: decision.detail,
			};
		// The only refusal that got far enough to have a report worth keeping: the
		// migrations ran, and then a gate turned the result down.
		case 'failed':
			return {
				path,
				status: 'error',
				changed: false,
				report: decision.result?.report ?? [],
				error: decision.detail,
			};
		case 'blocked':
			return {
				path,
				status: 'blocked',
				changed: false,
				report: decision.result.report,
			};
	}

	const { result } = decision;
	if (result.changed) {
		writeFileSync(path, result.source, { encoding: 'utf8' });
	}

	return {
		path,
		status: result.status,
		changed: result.changed,
		report: result.report,
		// Of the migrated source rather than the original, since that is the file whoever
		// commits this will be committing. No migration touches the input either way.
		versioningDisabled: versioningDisabled(parseWorkflow(result.source)),
		lintChecked:
			decision.outcome === 'migrated' ? decision.lintChecked : undefined,
	};
}

/**
 * The repository types balena-versionist ships a strategy for, from its
 * `lib/repo-type-mappings/` directory. Without a `repo.yml` declaring one,
 * versionist falls back to its own defaults — the node strategy — which needs a
 * `package.json` to anchor the version, so a non-node repository silently gets
 * the wrong strategy.
 */
export const REPO_TYPES = [
	'balena-engine',
	'composite',
	'datestamp',
	'dbt-project',
	'docker',
	'electron',
	'generic',
	'node',
	'public-docs',
	'python-poetry',
	'rust-module',
	'yocto-based-OS-image',
	'yocto-layer',
];

/** Whether this repository has to declare its type for versionist to work. */
export function needsRepoType(cwd: string): boolean {
	return (
		!existsSync(join(cwd, 'repo.yml')) && !existsSync(join(cwd, 'package.json'))
	);
}

/**
 * Bootstrap a repository that has never used flowzone: the job the old
 * flowzonify.sh did, minus the branch-and-commit, which belongs to whoever runs
 * this rather than to the tool.
 */
export function initRepo(cwd: string, { type }: { type?: string } = {}) {
	const workflow = join(cwd, WORKFLOW_PATH);

	if (type && !REPO_TYPES.includes(type)) {
		throw new Error(
			`unknown repo type: ${type}. Expected one of: ${REPO_TYPES.join(', ')}`,
		);
	}

	// Refuse before touching anything: a repository versionist would mis-handle is
	// worth stopping for, and a half-initialised one is nobody's idea of helpful.
	if (!type && needsRepoType(cwd)) {
		throw new Error(
			'cannot tell what kind of repository this is: there is no repo.yml, and no package.json ' +
				'for balena-versionist to fall back on.\n' +
				`  re-run with --type <${REPO_TYPES.join('|')}>`,
		);
	}

	const resinci = join(cwd, '.resinci.yml');
	const resinciExists = existsSync(resinci);
	if (resinciExists) {
		rmSync(resinci);
	}

	const created = !existsSync(workflow);
	if (created) {
		mkdirSync(dirname(workflow), { recursive: true });
		writeFileSync(workflow, CALLER_TEMPLATE, { encoding: 'utf8' });
	}

	// An explicit type overrides inference; only an existing repo.yml wins over it.
	const wroteRepoType = Boolean(type) && !existsSync(join(cwd, 'repo.yml'));
	if (wroteRepoType) {
		writeFileSync(join(cwd, 'repo.yml'), `type: ${type}\n`, {
			encoding: 'utf8',
		});
	}

	// Whatever the workflow still needs — the npm publishing permissions, say — is
	// a migration, so let the migrations decide rather than duplicating them here.
	const migration = migrateFile(workflow, { cwd, lint: false });

	return {
		created,
		removedResinci: resinciExists,
		wroteRepoType,
		repoType: wroteRepoType ? type : undefined,
		workflow,
		migration,
	};
}
