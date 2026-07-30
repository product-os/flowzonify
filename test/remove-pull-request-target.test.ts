import { test } from 'node:test';
import assert from 'node:assert/strict';

import unit from '../lib/migrations/remove-pull-request-target.ts';
import { applyUnit } from '../lib/migrate.ts';
import { LEGACY_CALLER } from './helpers.ts';

test('removes the pull_request_target trigger and the comment that documents it', () => {
	const result = applyUnit(unit, LEGACY_CALLER);
	assert.equal(result.status, 'applied');
	assert.ok(!result.source.includes('pull_request_target:'));
	assert.ok(!result.source.includes('allow external contributions'));
});

test('leaves the pull_request trigger and everything after it untouched', () => {
	const result = applyUnit(unit, LEGACY_CALLER);
	assert.ok(
		result.source.includes(
			'on:\n  pull_request:\n    types: [opened, synchronize, closed]\n    branches: [main, master]\n\njobs:',
		),
	);
	assert.ok(result.source.includes('    secrets: inherit\n'));
});

test('skips a workflow that has already been migrated', () => {
	const migrated = applyUnit(unit, LEGACY_CALLER).source;
	assert.equal(applyUnit(unit, migrated).status, 'skip');
});

test('skips a workflow that never had the trigger', () => {
	const src = 'on:\n  pull_request:\n    branches: [main]\n';
	assert.equal(applyUnit(unit, src).status, 'skip');
});

test('blocks rather than disabling CI when pull_request_target is the only trigger', () => {
	const src = 'on:\n  pull_request_target:\n    branches: [main]\n';
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.match(result.note!, /pull_request/);
	assert.equal(result.source, src);
});

test('blocks when the triggers are a flow sequence it cannot edit safely', () => {
	const src = 'on: [pull_request, pull_request_target]\n';
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('skips a flow sequence of triggers that does not mention pull_request_target', () => {
	assert.equal(applyUnit(unit, 'on: [pull_request]\n').status, 'skip');
});

test('blocks a flow-style trigger mapping, whose pairs share a line', () => {
	const src =
		'on: { pull_request: { branches: [main] }, pull_request_target: { branches: [main] } }\n';
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('skips a flow-style trigger mapping that never had the trigger', () => {
	assert.equal(
		applyUnit(unit, 'on: { pull_request: { branches: [main] } }\n').status,
		'skip',
	);
});

test('removes the trigger when it carries no comment', () => {
	const src = `on:
  pull_request:
    branches: [main]
  pull_request_target:
    branches: [main]
`;
	const result = applyUnit(unit, src);
	assert.equal(result.source, 'on:\n  pull_request:\n    branches: [main]\n');
});
