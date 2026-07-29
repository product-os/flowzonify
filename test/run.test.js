import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
	migrateFile,
	initRepo,
	needsRepoType,
	CALLER_TEMPLATE,
	REPO_TYPES,
	WORKFLOW_PATH,
} from '../lib/run.js';
import { migrate } from '../lib/migrate.js';
import { MIGRATIONS } from '../lib/migrations/index.js';
import { PUSH_TRIGGER_COMMENT } from '../lib/migrations/add-push-trigger.js';
import { repo, BLOCKED_CALLER, BROKEN_WORKFLOW, LEGACY_CALLER, NON_CALLER } from './helpers.js';

test('migrates a caller workflow in place', () => {
	const dir = repo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	const result = migrateFile(join(dir, WORKFLOW_PATH));

	assert.equal(result.status, 'ok');
	assert.equal(result.changed, true);

	const written = readFileSync(join(dir, WORKFLOW_PATH), 'utf8');
	assert.ok(written.includes('  push:'));
	assert.ok(!written.includes('pull_request_target'));
});

test('reports no change for a workflow that is already migrated', () => {
	const dir = repo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	migrateFile(join(dir, WORKFLOW_PATH));
	const again = migrateFile(join(dir, WORKFLOW_PATH));

	assert.equal(again.status, 'ok');
	assert.equal(again.changed, false);
});



test('skips a workflow that does not call flowzone', () => {
	const dir = repo({ [WORKFLOW_PATH]: NON_CALLER });
	const result = migrateFile(join(dir, WORKFLOW_PATH));

	assert.equal(result.status, 'skipped');
	assert.equal(readFileSync(join(dir, WORKFLOW_PATH), 'utf8'), NON_CALLER);
});

test('reports an error and writes nothing for a workflow that does not parse', () => {
	const dir = repo({ [WORKFLOW_PATH]: BROKEN_WORKFLOW });
	const result = migrateFile(join(dir, WORKFLOW_PATH));

	assert.equal(result.status, 'error');
	assert.match(result.error, /valid YAML/);
	assert.equal(readFileSync(join(dir, WORKFLOW_PATH), 'utf8'), BROKEN_WORKFLOW);
});

test('reports blocked and writes nothing when a unit needs a human', () => {
	const dir = repo({ [WORKFLOW_PATH]: BLOCKED_CALLER });
	const result = migrateFile(join(dir, WORKFLOW_PATH));

	assert.equal(result.status, 'blocked');
	assert.equal(readFileSync(join(dir, WORKFLOW_PATH), 'utf8'), BLOCKED_CALLER);
	assert.ok(result.report.some((entry) => entry.status === 'blocked' && entry.note));
});

test('reports an error for a path that does not exist', () => {
	const dir = repo();
	const result = migrateFile(join(dir, WORKFLOW_PATH));
	assert.equal(result.status, 'error');
	assert.match(result.error, /ENOENT|no such file/i);
});

test('honours a restricted set of migrations', () => {
	const dir = repo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	migrateFile(join(dir, WORKFLOW_PATH), { only: ['add-push-trigger'] });

	const written = readFileSync(join(dir, WORKFLOW_PATH), 'utf8');
	assert.ok(written.includes('  push:'));
	assert.ok(written.includes('pull_request_target'), 'other migrations should not have run');
});

test('rejects an unknown migration id rather than silently doing nothing', () => {
	const dir = repo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	assert.throws(() => migrateFile(join(dir, WORKFLOW_PATH), { only: ['nope'] }), /nope/);
});

test('init creates a caller workflow that needs no migration', () => {
	const dir = repo();
	const result = initRepo(dir, { type: 'generic' });

	assert.equal(result.created, true);
	const created = readFileSync(join(dir, WORKFLOW_PATH), 'utf8');
	assert.ok(created.includes('  push:'));
	assert.ok(!created.includes('pull_request_target'));

	writeFileSync(join(dir, WORKFLOW_PATH), created);
	assert.equal(migrateFile(join(dir, WORKFLOW_PATH)).changed, false);
});

test('init does not overwrite an existing workflow with the template', () => {
	const customised = LEGACY_CALLER.replace(
		'    secrets: inherit\n',
		'    secrets: inherit\n    with:\n      docker_images: example-org/example-app\n',
	);
	const dir = repo({ [WORKFLOW_PATH]: customised });
	const result = initRepo(dir, { install: false, type: 'generic' });

	assert.equal(result.created, false);
	assert.ok(
		readFileSync(join(dir, WORKFLOW_PATH), 'utf8').includes('docker_images: example-org/example-app'),
		'the caller customisations must survive',
	);
});

test('init removes a leftover balenaCI config', () => {
	const dir = repo({ '.resinci.yml': 'npm:\n  publish: false\n' });
	const result = initRepo(dir, { install: false, type: 'generic' });

	assert.equal(result.removedResinci, true);
	assert.equal(existsSync(join(dir, '.resinci.yml')), false);
});

test('init leaves the created workflow needing no migration for an npm package', () => {
	const dir = repo({ 'package.json': '{"name":"x"}\n' });
	const result = initRepo(dir, { install: false });

	const created = readFileSync(join(dir, WORKFLOW_PATH), 'utf8');
	assert.match(created, /^ {2}id-token: write {2}# https:\/\/docs\.npmjs\.com\/trusted-publishers$/m);
	assert.equal(result.migration.status, 'ok');
	assert.equal(migrateFile(join(dir, WORKFLOW_PATH), { cwd: dir }).changed, false);
});

test('init leaves permissions out of a workflow for a repository that is not an npm package', () => {
	const dir = repo();
	initRepo(dir, { install: false, type: 'generic' });
	assert.ok(!readFileSync(join(dir, WORKFLOW_PATH), 'utf8').includes('permissions:'));
});

test('init brings an existing workflow up to date through the migrations', () => {
	const dir = repo({ 'package.json': '{"name":"x"}\n', [WORKFLOW_PATH]: LEGACY_CALLER });
	initRepo(dir, { install: false });

	const written = readFileSync(join(dir, WORKFLOW_PATH), 'utf8');
	assert.match(written, /^permissions:$/m);
	assert.ok(!written.includes('pull_request_target'));
	assert.ok(written.includes('  push:'));
});

test('init reports the karma test dependencies a karma project needs', () => {
	const dir = repo({ 'karma.conf.js': 'module.exports = () => {};\n' });
	const result = initRepo(dir, { install: false, type: 'generic' });

	assert.ok(result.karmaPackages.includes('balena-config-karma@4.0.0'));
	assert.ok(result.karmaPackages.some((pkg) => pkg.startsWith('karma@')));
	assert.equal(result.installedKarmaPackages, false);
});

test('a repository with no package.json needs a declared repo type', () => {
	assert.equal(needsRepoType(repo()), true);
});

test('a repository with a package.json does not, since versionist assumes node', () => {
	assert.equal(needsRepoType(repo({ 'package.json': '{"name":"x"}\n' })), false);
});

test('a repository that already declares its type does not need asking again', () => {
	assert.equal(needsRepoType(repo({ 'repo.yml': 'type: docker\n' })), false);
});

test('init writes the repo type it was given', () => {
	const dir = repo();
	const result = initRepo(dir, { install: false, type: 'docker' });

	assert.equal(result.wroteRepoType, true);
	assert.equal(readFileSync(join(dir, 'repo.yml'), 'utf8'), 'type: docker\n');
});

test('init leaves an existing repo.yml alone', () => {
	const existing = 'type: yocto-layer\nreviewers: 1\n';
	const dir = repo({ 'repo.yml': existing });
	const result = initRepo(dir, { install: false, type: 'docker' });

	assert.equal(result.wroteRepoType, false);
	assert.equal(readFileSync(join(dir, 'repo.yml'), 'utf8'), existing);
});

test('an explicit type overrides inference, even for an npm package', () => {
	const dir = repo({ 'package.json': '{"name":"x"}\n' });
	const result = initRepo(dir, { install: false, type: 'python-poetry' });

	assert.equal(result.wroteRepoType, true, 'an explicit --type must not be silently dropped');
	assert.equal(readFileSync(join(dir, 'repo.yml'), 'utf8'), 'type: python-poetry\n');
});

test('init writes no repo.yml for an npm package', () => {
	const dir = repo({ 'package.json': '{"name":"x"}\n' });
	const result = initRepo(dir, { install: false });

	assert.equal(result.wroteRepoType, false);
	assert.equal(existsSync(join(dir, 'repo.yml')), false);
});

test('init refuses a repository whose type it cannot tell, and touches nothing', () => {
	const dir = repo();
	assert.throws(() => initRepo(dir, { install: false }), /--type/);

	assert.equal(existsSync(join(dir, 'repo.yml')), false);
	assert.equal(existsSync(join(dir, WORKFLOW_PATH)), false, 'no half-initialised repository');
});

test('init rejects a repo type versionist does not ship', () => {
	assert.throws(() => initRepo(repo(), { install: false, type: 'nope' }), /nope/);
});

test('every offered repo type is one balena-versionist recognises', () => {
	for (const type of REPO_TYPES) {
		assert.match(type, /^[a-z0-9-]+$/i, `${type} should be a bare repo.yml type`);
	}
	assert.ok(REPO_TYPES.includes('node'));
	assert.ok(REPO_TYPES.includes('yocto-based-OS-image'));
});

test('init reports no karma dependencies for a project that does not use karma', () => {
	const dir = repo();
	const result = initRepo(dir, { install: false, type: 'generic' });
	assert.deepEqual(result.karmaPackages, []);
});

test('the workflow init creates still needs no migration', () => {
	const dir = repo({ 'package.json': '{"name":"x"}\n' });
	initRepo(dir, { install: false });
	assert.equal(migrateFile(join(dir, WORKFLOW_PATH)).changed, false);
});





test('the template init writes is already a complete caller config', () => {
	const result = migrate(CALLER_TEMPLATE, MIGRATIONS, { isNpmPackage: false, customActions: [] });
	assert.equal(result.changed, false, 'init must not write a workflow that is already out of date');
});

test('the template and the migration agree on the push trigger comment', () => {
	for (const line of PUSH_TRIGGER_COMMENT) {
		assert.ok(CALLER_TEMPLATE.includes(line), `template is missing: ${line}`);
	}
});

test('reports whether the schema check actually ran', () => {
	const dir = repo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	assert.equal(typeof migrateFile(join(dir, WORKFLOW_PATH)).lintChecked, 'boolean');
});

test('does not claim a lint was skipped when none was asked for', () => {
	const dir = repo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	assert.equal(migrateFile(join(dir, WORKFLOW_PATH), { lint: false }).lintChecked, undefined);
});
