import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKFLOW_PATH } from '../lib/run.js';
import { repo, BLOCKED_CALLER, BROKEN_WORKFLOW, LEGACY_CALLER, NON_CALLER } from './helpers.js';

const makeRepo = (files) => repo(files, 'flowzonify-cli-');

const CLI = fileURLToPath(new URL('../bin/flowzonify.js', import.meta.url));

const run = (cwd, ...args) =>
	spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

test('--list names every registered migration', () => {
	const result = run(makeRepo(), '--list');
	assert.equal(result.status, 0);
	assert.match(result.stdout, /remove-pull-request-target/);
	assert.match(result.stdout, /add-push-trigger/);
	assert.match(result.stdout, /remove-restrict-custom-actions/);
});

test('--help explains the usage and exits cleanly', () => {
	const result = run(makeRepo(), '--help');
	assert.equal(result.status, 0);
	assert.match(result.stdout, /flowzonify/);
	assert.match(result.stdout, /--only/);
});

test('migrates the default workflow path with no arguments', () => {
	const dir = makeRepo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	const result = run(dir);

	assert.equal(result.status, 0, result.stderr);
	const written = readFileSync(join(dir, WORKFLOW_PATH), 'utf8');
	assert.ok(written.includes('  push:'));
	assert.ok(!written.includes('pull_request_target'));
});

test('reports an already-migrated workflow as up to date', () => {
	const dir = makeRepo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	run(dir);
	const result = run(dir);

	assert.equal(result.status, 0);
	assert.match(result.stdout, /up to date/i);
});


test('--json emits a machine-readable report and nothing else', () => {
	const dir = makeRepo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	const result = run(dir, '--json');

	assert.equal(result.status, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.status, 'ok');
	assert.equal(report.files.length, 1);
	assert.ok(report.files[0].report.some((entry) => entry.id === 'add-push-trigger'));
});

test('exits 1 and changes nothing when the workflow does not parse', () => {
	const dir = makeRepo({ [WORKFLOW_PATH]: BROKEN_WORKFLOW });
	const result = run(dir);

	assert.equal(result.status, 1);
	assert.match(result.stderr + result.stdout, /valid YAML/);
	assert.equal(readFileSync(join(dir, WORKFLOW_PATH), 'utf8'), BROKEN_WORKFLOW);
});

test('exits 2 and changes nothing when a migration needs a human', () => {
	const dir = makeRepo({ [WORKFLOW_PATH]: BLOCKED_CALLER });
	const result = run(dir);

	assert.equal(result.status, 2);
	assert.match(result.stdout + result.stderr, /by hand/i);
	assert.equal(readFileSync(join(dir, WORKFLOW_PATH), 'utf8'), BLOCKED_CALLER);
});

test('accepts explicit paths', () => {
	const dir = makeRepo({ 'other/flowzone.yml': LEGACY_CALLER });
	const result = run(dir, 'other/flowzone.yml');

	assert.equal(result.status, 0, result.stderr);
	assert.ok(readFileSync(join(dir, 'other/flowzone.yml'), 'utf8').includes('  push:'));
});

test('reports a workflow that does not call flowzone without failing', () => {
	const dir = makeRepo({ [WORKFLOW_PATH]: NON_CALLER });
	const result = run(dir);

	assert.equal(result.status, 0);
	assert.match(result.stdout, /skipped/i);
});

test('init bootstraps a repository that has never used flowzone', () => {
	const dir = makeRepo({ '.resinci.yml': 'npm:\n  publish: false\n' });
	const result = run(dir, 'init', '--type', 'generic');

	assert.equal(result.status, 0, result.stderr);
	assert.ok(existsSync(join(dir, WORKFLOW_PATH)));
	assert.equal(existsSync(join(dir, '.resinci.yml')), false);
});


test('init grants an npm package the permissions it needs, via the migrations', () => {
	const dir = makeRepo({ 'package.json': '{"name":"x"}\n' });
	const result = run(dir, 'init');

	assert.equal(result.status, 0, result.stderr);
	assert.match(readFileSync(join(dir, WORKFLOW_PATH), 'utf8'), /^ {2}id-token: write/m);
});

test('init --type declares the repo type for a repository with no package.json', () => {
	const dir = makeRepo();
	const result = run(dir, 'init', '--type', 'docker');

	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(join(dir, 'repo.yml'), 'utf8'), 'type: docker\n');
});

test('init exits 1 and lists the options for an unknown repo type', () => {
	const result = run(makeRepo(), 'init', '--type', 'bogus');

	assert.equal(result.status, 1);
	assert.match(result.stderr, /bogus/);
	assert.match(result.stderr, /yocto-based-OS-image/, 'the error should list what is valid');
});

test('init exits 1 and asks for --type when it cannot tell the repo type', () => {
	const dir = makeRepo();
	const result = run(dir, 'init');

	assert.equal(result.status, 1);
	assert.match(result.stderr, /--type/);
	assert.equal(existsSync(join(dir, 'repo.yml')), false);
	assert.equal(existsSync(join(dir, WORKFLOW_PATH)), false);
});

test('init needs no --type for an npm package, since versionist assumes node', () => {
	const dir = makeRepo({ 'package.json': '{"name":"x"}\n' });
	const result = run(dir, 'init');

	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(dir, 'repo.yml')), false);
});

test('exits 1 on an unknown migration id', () => {
	const dir = makeRepo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	const result = run(dir, '--only', 'nope');

	assert.equal(result.status, 1);
	assert.match(result.stderr, /nope/);
});

test('says so when actionlint is not installed to run the deeper check', () => {
	const dir = makeRepo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	const result = spawnSync(process.execPath, [CLI], {
		cwd: dir,
		encoding: 'utf8',
		env: { ...process.env, PATH: join(dir, 'no-tools') },
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout + result.stderr, /actionlint/i);
});

test('stays quiet about actionlint when it is installed', (t) => {
	if (spawnSync('actionlint', ['-version']).error) {
		return t.skip('actionlint is not installed');
	}
	const dir = makeRepo({ [WORKFLOW_PATH]: LEGACY_CALLER });
	assert.ok(!run(dir).stdout.includes('actionlint'));
});
