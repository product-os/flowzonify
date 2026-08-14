import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrateSource } from '../lib/pipeline.ts';
import type { Migration } from '../lib/migrate.ts';
import { LEGACY_CALLER } from './helpers.ts';

const exploding: Migration = {
	id: 'exploding',
	description: 'throws',
	apply() {
		throw new TypeError(
			"Cannot read properties of undefined (reading 'value')",
		);
	},
};

const corrupting: Migration = {
	id: 'corrupting',
	description: 'emits source that will not parse',
	apply: () => ({
		status: 'applied',
		edits: [{ start: 0, end: 0, text: 'a: b\n  c: d\n' }],
	}),
};

test('a unit that throws fails only this workflow', () => {
	const result = migrateSource(LEGACY_CALLER, {
		units: [exploding],
		lint: false,
	});

	assert.equal(result.outcome, 'failed');
	assert.match(result.detail, /migration failed/);
});

test('a unit that produces unparseable source fails only this workflow', () => {
	const result = migrateSource(LEGACY_CALLER, {
		units: [corrupting],
		lint: false,
	});
	assert.equal(result.outcome, 'failed');
});

test('a workflow that is not a caller is reported, not migrated', () => {
	const result = migrateSource('on:\n  push:\njobs: {}\n', { lint: false });
	assert.equal(result.outcome, 'not a caller');
});
