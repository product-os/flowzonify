import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validate, ValidationError } from '../lib/validate.js';
import { migrate } from '../lib/migrate.js';
import { MIGRATIONS } from '../lib/migrations/index.js';
import { LEGACY_CALLER } from './helpers.js';

const RESULT = migrate(LEGACY_CALLER);
const MIGRATED = RESULT.source;

test('accepts a correctly migrated workflow', () => {
	assert.doesNotThrow(() => validate(LEGACY_CALLER, RESULT));
});

test('accepts the result of running a single migration in isolation', () => {
	const units = MIGRATIONS.filter((unit) => unit.id === 'add-push-trigger');
	const partial = migrate(LEGACY_CALLER, units);
	assert.doesNotThrow(
		() => validate(LEGACY_CALLER, partial, units),
		'validation must not assume the whole registry ran',
	);
});

test('rejects output that dropped a trigger the migration has no business removing', () => {
	const without = MIGRATED.replace(
		'  pull_request:\n    types: [opened, synchronize, closed]\n    branches: [main, master]\n',
		'',
	);
	assert.throws(() => validate(LEGACY_CALLER, { ...RESULT, source: without }), {
		name: 'ValidationError',
		message: /pull_request/,
	});
});

test('only lets a trigger disappear when a migration that ran said it would', () => {
	const units = MIGRATIONS.filter((unit) => unit.id === 'add-push-trigger');
	const partial = migrate(LEGACY_CALLER, units);
	const alsoDropped = partial.source.replace(
		'  pull_request_target:\n    types: [opened, synchronize, closed]\n    branches: [main, master]\n',
		'',
	);

	assert.throws(
		() => validate(LEGACY_CALLER, { ...partial, source: alsoDropped }, units),
		/pull_request_target/,
		'no migration that ran claims that trigger, so removing it must be caught',
	);
});

test('rejects output that dropped a caller job', () => {
	const without = MIGRATED.replace(/jobs:[\s\S]*$/, 'jobs:\n  other:\n    runs-on: ubuntu-latest\n');
	assert.throws(() => validate(LEGACY_CALLER, { ...RESULT, source: without }), ValidationError);
});

test('rejects output that repointed the caller at a different workflow', () => {
	const repointed = MIGRATED.replace(
		'flowzone.yml@master',
		'flowzone.yml@some-fork',
	);
	assert.throws(() => validate(LEGACY_CALLER, { ...RESULT, source: repointed }), { message: /uses/ });
});

test('rejects output that is not valid YAML', () => {
	assert.throws(() => validate(LEGACY_CALLER, { ...RESULT, source: 'jobs:\n  a: b\n      c: d\n' }));
});

test('rejects output that would change again on a second run', () => {
	const reverted = MIGRATED.replace('  push:\n', '  pull_request_target:\n    branches: [main]\n  push:\n');
	assert.throws(() => validate(LEGACY_CALLER, { ...RESULT, source: reverted }), ValidationError);
});

test('runs the postcondition of each migration that applied', () => {
	const stillThere = MIGRATED.replace(
		'  push:\n',
		'  pull_request_target:\n    branches: [main]\n  push:\n',
	);
	assert.throws(
		() => validate(LEGACY_CALLER, { ...RESULT, source: stillThere }),
		/pull_request_target/,
	);
});

test('does not run the postcondition of a migration that skipped', () => {
	const alreadyMigrated = MIGRATED;
	const second = migrate(alreadyMigrated);
	assert.doesNotThrow(() => validate(alreadyMigrated, second));
});

test('rejects a filter the migration put where the event does not allow it', () => {
	const mangled = MIGRATED.replace(
		'  push:\n    branches: [main, master]\n',
		'  push:\n    types: [opened]\n    branches: [main, master]\n',
	);
	assert.throws(() => validate(LEGACY_CALLER, { ...RESULT, source: mangled }), {
		name: 'ValidationError',
		message: /push\.types/,
	});
});

test('tolerates an illegal filter the workflow already had', () => {
	const before = LEGACY_CALLER.replace(
		'  pull_request:\n',
		"  pull_request:\n    tags: ['v*']\n",
	);
	const result = migrate(before);
	assert.doesNotThrow(
		() => validate(before, result),
		'a pre-existing problem is not the migration to blame for',
	);
});
