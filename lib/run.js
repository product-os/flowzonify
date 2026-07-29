import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';

import { migrateSource } from './pipeline.js';
import { MIGRATIONS } from './migrations/index.js';

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
function repoContext(cwd = process.cwd()) {
	return { isNpmPackage: publishesToNpm(cwd), customActions: customActions(cwd) };
}

/**
 * The custom actions this repository defines. Flowzone decides which custom jobs
 * exist by looking for these directories, so migrations that reason about custom
 * jobs look in the same place. Reports whatever is there rather than a known
 * list: the context supplies the fact, each migration owns the policy.
 */
function customActions(cwd) {
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
 */
function repoRootFor(path) {
	const parts = resolve(path).split(sep);
	return parts.at(-2) === 'workflows' && parts.at(-3) === '.github'
		? parts.slice(0, -3).join(sep) || sep
		: dirname(path);
}

function publishesToNpm(cwd) {
	try {
		// A package marked private is never published.
		return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).private !== true;
	} catch {
		return false;
	}
}

export function selectMigrations(only) {
	if (!only) {
		return MIGRATIONS;
	}

	const unknown = only.filter((id) => !MIGRATIONS.some((unit) => unit.id === id));
	if (unknown.length > 0) {
		throw new Error(`unknown migration id: ${unknown.join(', ')}`);
	}

	return MIGRATIONS.filter((unit) => only.includes(unit.id));
}

/**
 * Migrate one workflow file. Anything short of a clean, validated result leaves
 * the file exactly as it was: a half-migrated workflow is worse than an old one.
 */
export function migrateFile(path, { only, lint = true, cwd } = {}) {
	const units = selectMigrations(only);
	const root = cwd ?? repoRootFor(path);

	let before;
	try {
		before = readFileSync(path, 'utf8');
	} catch (error) {
		return { path, status: 'error', changed: false, report: [], error: error.message };
	}

	const { outcome, result, detail, lintChecked } = migrateSource(before, {
		units,
		context: repoContext(root),
		lint,
	});

	if (outcome === 'unparseable' || outcome === 'failed' || outcome === 'not a caller') {
		const status = outcome === 'not a caller' ? 'skipped' : 'error';
		return { path, status, changed: false, report: result?.report ?? [], error: detail };
	}

	if (outcome === 'blocked') {
		return { path, status: 'blocked', changed: false, report: result.report };
	}

	if (result.changed) {
		writeFileSync(path, result.source);
	}

	return { path, status: result.status, changed: result.changed, report: result.report, lintChecked };
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
export function needsRepoType(cwd = process.cwd()) {
	return !existsSync(join(cwd, 'repo.yml')) && !existsSync(join(cwd, 'package.json'));
}

/** Dev dependencies a karma project needs to test under flowzone. */
const KARMA_PACKAGES = [
	'balena-config-karma@4.0.0',
	'@types/chai@^4.3.0',
	'@types/chai-as-promised@^7.1.5',
	'@types/mocha@^9.1.1',
	'chai@^4.3.4',
	'mocha@^10.0.0',
	'ts-node@^10.0.0',
	'karma@^5.0.0',
];

/**
 * Bootstrap a repository that has never used flowzone: the job the old
 * flowzonify.sh did, minus the branch-and-commit, which belongs to whoever runs
 * this rather than to the tool.
 */
export function initRepo(cwd = process.cwd(), { install = true, type } = {}) {
	const workflow = join(cwd, WORKFLOW_PATH);

	if (type && !REPO_TYPES.includes(type)) {
		throw new Error(`unknown repo type: ${type}. Expected one of: ${REPO_TYPES.join(', ')}`);
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
	const removedResinci = existsSync(resinci);
	if (removedResinci) {
		rmSync(resinci);
	}

	const created = !existsSync(workflow);
	if (created) {
		mkdirSync(dirname(workflow), { recursive: true });
		writeFileSync(workflow, CALLER_TEMPLATE);
	}

	// An explicit type overrides inference; only an existing repo.yml wins over it.
	const wroteRepoType = Boolean(type) && !existsSync(join(cwd, 'repo.yml'));
	if (wroteRepoType) {
		writeFileSync(join(cwd, 'repo.yml'), `type: ${type}\n`);
	}

	const karmaPackages = existsSync(join(cwd, 'karma.conf.js')) ? KARMA_PACKAGES : [];
	const installedKarmaPackages =
		karmaPackages.length > 0 && install ? installDevDependencies(cwd, karmaPackages) : false;

	// Whatever the workflow still needs — the npm publishing permissions, say — is
	// a migration, so let the migrations decide rather than duplicating them here.
	const migration = migrateFile(workflow, { cwd, lint: false });

	return {
		created,
		removedResinci,
		wroteRepoType,
		repoType: wroteRepoType ? type : undefined,
		karmaPackages,
		installedKarmaPackages,
		workflow,
		migration,
	};
}

function installDevDependencies(cwd, packages) {
	const result = spawnSync('npm', ['install', '-D', ...packages], { cwd, stdio: 'inherit' });
	return result.status === 0;
}
