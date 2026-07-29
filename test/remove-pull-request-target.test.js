import { test } from 'node:test';
import assert from 'node:assert/strict';

import unit from '../lib/migrations/remove-pull-request-target.js';
import { runUnit, LEGACY_CALLER } from './helpers.js';

test('removes the pull_request_target trigger and the comment that documents it', () => {
	const result = runUnit(unit, LEGACY_CALLER);
	assert.equal(result.status, 'applied');
	assert.ok(!result.source.includes('pull_request_target:'));
	assert.ok(!result.source.includes('allow external contributions'));
});

test('leaves the pull_request trigger and everything after it untouched', () => {
	const result = runUnit(unit, LEGACY_CALLER);
	assert.ok(
		result.source.includes(
			'on:\n  pull_request:\n    types: [opened, synchronize, closed]\n    branches: [main, master]\n\njobs:',
		),
	);
	assert.ok(result.source.includes('    secrets: inherit\n'));
});

test('skips a workflow that has already been migrated', () => {
	const migrated = runUnit(unit, LEGACY_CALLER).source;
	assert.equal(runUnit(unit, migrated).status, 'skip');
});

test('skips a workflow that never had the trigger', () => {
	const src = 'on:\n  pull_request:\n    branches: [main]\n';
	assert.equal(runUnit(unit, src).status, 'skip');
});

test('blocks rather than disabling CI when pull_request_target is the only trigger', () => {
	const src = 'on:\n  pull_request_target:\n    branches: [main]\n';
	const result = runUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.match(result.note, /pull_request/);
	assert.equal(result.source, src);
});

test('blocks when the triggers are a flow sequence it cannot edit safely', () => {
	const src = 'on: [pull_request, pull_request_target]\n';
	const result = runUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('skips a flow sequence of triggers that does not mention pull_request_target', () => {
	assert.equal(runUnit(unit, 'on: [pull_request]\n').status, 'skip');
});

test('blocks a flow-style trigger mapping, whose pairs share a line', () => {
	const src = 'on: { pull_request: { branches: [main] }, pull_request_target: { branches: [main] } }\n';
	const result = runUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('skips a flow-style trigger mapping that never had the trigger', () => {
	assert.equal(runUnit(unit, 'on: { pull_request: { branches: [main] } }\n').status, 'skip');
});

test('removes the trigger when it carries no comment', () => {
	const src = `on:
  pull_request:
    branches: [main]
  pull_request_target:
    branches: [main]
`;
	const result = runUnit(unit, src);
	assert.equal(result.source, 'on:\n  pull_request:\n    branches: [main]\n');
});
