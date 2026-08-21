import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import type { YAMLMap } from 'yaml';

import unit from '../lib/migrations/add-npm-oidc-permissions.ts';
import { applyUnit, parseWorkflow } from '../lib/migrate.ts';
import type { Context } from '../lib/migrate.ts';
import { caller, LEGACY_CALLER } from './helpers.ts';

const run = (src: string, context: Context = { isNpmPackage: true }) =>
	applyUnit(unit, src, context);

const permissionsOf = (src: string) =>
	(parseDocument(src).get('permissions') as YAMLMap).toJSON();

test('adds the trusted-publishing permissions to an npm package', () => {
	const result = run(LEGACY_CALLER);
	assert.equal(result.status, 'applied');
	assert.deepEqual(permissionsOf(result.source), {
		'id-token': 'write',
		contents: 'read',
		packages: 'read',
	});
});

test('puts the permissions block above the jobs it applies to', () => {
	const result = run(LEGACY_CALLER);
	assert.ok(
		result.source.indexOf('permissions:') < result.source.indexOf('jobs:'),
	);
});

test('leaves the rest of the workflow byte for byte identical', () => {
	const result = run(LEGACY_CALLER);
	assert.ok(result.source.includes('  pull_request_target:\n'));
	assert.ok(result.source.includes('    secrets: inherit\n'));
});

test('skips a repository that is not an npm package', () => {
	assert.equal(run(LEGACY_CALLER, { isNpmPackage: false }).status, 'skip');
});

test('skips when the repository is unknown, rather than guessing', () => {
	const result = run(LEGACY_CALLER, {});
	assert.equal(result.status, 'skip');
	assert.match(result.note ?? '', /context/i);
});

test('skips a workflow that already requests id-token: write', () => {
	const already = LEGACY_CALLER.replace(
		'jobs:',
		'permissions:\n  id-token: write\n\njobs:',
	);
	assert.equal(run(already).status, 'skip');
});

test('is idempotent', () => {
	const once = run(LEGACY_CALLER).source;
	assert.equal(run(once).status, 'skip');
});

test('adds the permission to an existing block instead of duplicating the key', () => {
	const existing = LEGACY_CALLER.replace(
		'jobs:',
		'permissions:\n  contents: read\n  packages: write\n\njobs:',
	);
	const result = run(existing);

	assert.equal(result.status, 'applied');
	assert.doesNotThrow(
		() => parseWorkflow(result.source),
		'must not produce a duplicate mapping key',
	);
	assert.deepEqual(permissionsOf(result.source), {
		contents: 'read',
		packages: 'write',
		'id-token': 'write',
	});
});

test('keeps the comments in an existing permissions block', () => {
	const commented = LEGACY_CALLER.replace(
		'jobs:',
		'permissions:\n  # only what flowzone needs\n  contents: read\n\njobs:',
	);
	const result = run(commented);
	assert.ok(
		result.source.includes('  # only what flowzone needs\n  contents: read\n'),
	);
});

test('writes the block in place when the caller left permissions empty', () => {
	const empty = LEGACY_CALLER.replace('jobs:', 'permissions: {}\n\njobs:');
	const result = run(empty);

	assert.equal(result.status, 'applied');
	assert.doesNotThrow(() => parseWorkflow(result.source));
	assert.deepEqual(permissionsOf(result.source), {
		'id-token': 'write',
		contents: 'read',
		packages: 'read',
	});
	assert.ok(!result.source.includes('permissions: {}'));
});

test('an empty permissions block is idempotent, not repeatedly rewritten', () => {
	const empty = LEGACY_CALLER.replace('jobs:', 'permissions: {}\n\njobs:');
	assert.equal(run(run(empty).source).status, 'skip');
});

const pinned = (idToken: string) =>
	LEGACY_CALLER.replace(
		'jobs:',
		`permissions:\n  contents: read\n  id-token: ${idToken}\n\njobs:`,
	);

test('upgrades an id-token that is not write, since only write can publish', () => {
	for (const granted of ['none', 'read']) {
		const result = run(pinned(granted));

		assert.equal(
			result.status,
			'applied',
			`expected id-token: ${granted} to be upgraded`,
		);
		assert.equal(permissionsOf(result.source)['id-token'], 'write');
		assert.equal(
			permissionsOf(result.source).contents,
			'read',
			'other permissions untouched',
		);
	}
});

test('skips when write is already granted, quoted or not', () => {
	assert.equal(run(pinned('write')).status, 'skip');
	assert.equal(run(pinned('"write"')).status, 'skip');
});

test('upgrading replaces a comment that described the value being replaced', () => {
	const result = run(pinned('none  # locked down by default'));

	assert.ok(
		!result.source.includes('locked down by default'),
		'the comment now contradicts the value',
	);
	assert.ok(result.source.includes('id-token: write\n'));
});

test('upgrading a bare value splices the value alone', () => {
	const result = run(pinned('none'));
	assert.ok(result.source.includes('  contents: read\n  id-token: write\n'));
});

test('upgrading is idempotent', () => {
	const once = run(pinned('none')).source;
	assert.equal(run(once).status, 'skip');
});

test('handles an id-token key with no value at all', () => {
	const result = run(pinned('').replace('id-token: \n', 'id-token:\n'));
	assert.equal(result.status, 'applied');
	assert.equal(permissionsOf(result.source)['id-token'], 'write');
});

test('upgrades id-token inside a flow-style permissions block, splicing the value alone', () => {
	const flow = LEGACY_CALLER.replace(
		'jobs:',
		'permissions: { contents: read, id-token: none }\n\njobs:',
	);
	const result = run(flow);

	assert.equal(result.status, 'applied');
	assert.deepEqual(permissionsOf(result.source), {
		contents: 'read',
		'id-token': 'write',
	});
});

test('skips a flow-style permissions block that already grants write', () => {
	const flow = LEGACY_CALLER.replace(
		'jobs:',
		'permissions: { id-token: write }\n\njobs:',
	);
	assert.equal(run(flow).status, 'skip');
});

test('blocks a flow-style permissions block it cannot extend in place', () => {
	const flow = LEGACY_CALLER.replace(
		'jobs:',
		'permissions: { contents: read }\n\njobs:',
	);
	const result = run(flow);

	assert.equal(result.status, 'blocked');
	assert.equal(result.source, flow);
});

// A job-level permissions block replaces the workflow-level one for that job, so
// a grant at the top level never reaches a caller job that has its own block.
const jobGrant = (src: string) =>
	parseDocument(src).getIn(['jobs', 'flowzone', 'permissions', 'id-token']);

test('grants id-token in a job-level permissions block, which the top level cannot reach', () => {
	const result = run(caller('    permissions:\n      contents: read\n'));

	assert.equal(result.status, 'applied');
	assert.equal(jobGrant(result.source), 'write');
	assert.ok(
		!/^permissions:/m.test(result.source),
		'no workflow-level block the job would ignore',
	);
});

test('upgrades a job-level id-token that is not write', () => {
	const result = run(caller('    permissions:\n      id-token: none\n'));
	assert.equal(jobGrant(result.source), 'write');
});

test('rewrites an empty job-level permissions block in place', () => {
	const result = run(caller('    permissions: {}\n'));

	assert.equal(result.status, 'applied');
	assert.doesNotThrow(() => parseWorkflow(result.source));
	assert.equal(jobGrant(result.source), 'write');
});

test('skips a job-level block that already grants write', () => {
	assert.equal(
		run(caller('    permissions:\n      id-token: write\n')).status,
		'skip',
	);
});

test('granting at the job level is idempotent', () => {
	const once = run(caller('    permissions:\n      contents: read\n')).source;
	assert.equal(run(once).status, 'skip');
});

test('blocks on a job-level permissions shorthand it cannot extend', () => {
	const result = run(caller('    permissions: read-all\n'));
	assert.equal(result.status, 'blocked');
	assert.match(result.note!, /flowzone/);
});

test('still covers the top level when another caller job relies on it', () => {
	const src = `jobs:
  one:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    secrets: inherit
  two:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    permissions:
      contents: read
    secrets: inherit
`;
	const result = run(src);
	const doc = parseDocument(result.source);

	assert.equal(doc.getIn(['permissions', 'id-token']), 'write');
	assert.equal(doc.getIn(['jobs', 'two', 'permissions', 'id-token']), 'write');
});

test('verify fails a caller job whose own permissions block lacks the grant', () => {
	const migrated = parseWorkflow(
		'permissions:\n  id-token: write\n\n' +
			caller('    permissions:\n      contents: read\n'),
	);
	assert.match(unit.verify(migrated)!, /flowzone/);
});
