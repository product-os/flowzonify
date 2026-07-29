import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';

import unit from '../lib/migrations/add-push-trigger.js';
import { runUnit, fixture, LEGACY_CALLER } from './helpers.js';

const branchesOf = (src) => parseDocument(src).getIn(['on', 'push', 'branches']).toJSON();

test('adds a push trigger that mirrors the pull_request branches', () => {
	const result = runUnit(unit, LEGACY_CALLER);
	assert.equal(result.status, 'applied');
	assert.deepEqual(branchesOf(result.source), ['main', 'master']);
});

test('keeps the flow style of the branches list it copies', () => {
	const result = runUnit(unit, LEGACY_CALLER);
	assert.ok(result.source.includes('  push:\n    branches: [main, master]\n'));
});

test('copies a block sequence of branches without mangling it', () => {
	const result = runUnit(unit, fixture('block-sequence-branches'));
	assert.equal(result.status, 'applied');
	assert.ok(result.source.includes('  push:\n    branches:\n      - "master"\n'));
	assert.deepEqual(branchesOf(result.source), ['master']);
});

test('preserves a caller branch list that is not [main, master]', () => {
	const src = `on:
  pull_request:
    branches: [develop]

jobs: {}
`;
	assert.deepEqual(branchesOf(runUnit(unit, src).source), ['develop']);
});

test('explains what the trigger is for without implying it is optional', () => {
	const result = runUnit(unit, LEGACY_CALLER);
	assert.match(result.source, /# Fork contributions are rebuilt and published from the push/);
	assert.doesNotMatch(
		result.source,
		/drop this trigger|test-only|do not need it/i,
		'push becomes required for internal branches later; never suggest it can be dropped',
	);
});

test('defaults to [main, master] when pull_request filters no branches', () => {
	const src = `on:
  pull_request:
    types: [opened]

jobs: {}
`;
	assert.deepEqual(branchesOf(runUnit(unit, src).source), ['main', 'master']);
});

test('skips a workflow that already has a push trigger', () => {
	const migrated = runUnit(unit, LEGACY_CALLER).source;
	assert.equal(runUnit(unit, migrated).status, 'skip');
});

test('inserts the trigger directly after pull_request, not at the end of the map', () => {
	const src = `on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs: {}
`;
	const result = runUnit(unit, src);
	assert.deepEqual(
		parseDocument(result.source)
			.get('on')
			.items.map((pair) => String(pair.key)),
		['pull_request', 'push', 'workflow_dispatch'],
	);
});

test('handles a file whose final line is the pull_request block with no trailing newline', () => {
	const result = runUnit(unit, 'on:\n  pull_request:\n    branches: [main]');
	assert.equal(result.status, 'applied');
	assert.deepEqual(branchesOf(result.source), ['main']);
});

test('matches the indentation of the trigger map it is inserted into', () => {
	const src = `on:
    pull_request:
        branches: [main]

jobs: {}
`;
	const result = runUnit(unit, src);
	assert.ok(result.source.includes('    push:\n        branches: [main]\n'));
	assert.deepEqual(branchesOf(result.source), ['main']);
});

test('blocks when there is no pull_request trigger to mirror', () => {
	const src = 'on:\n  schedule:\n    - cron: "0 0 * * *"\n';
	const result = runUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('blocks when the triggers are a flow sequence it cannot extend safely', () => {
	const result = runUnit(unit, 'on: [pull_request]\n');
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, 'on: [pull_request]\n');
});

test('blocks a flow-style trigger mapping it cannot splice into', () => {
	const src = 'on: { pull_request: { branches: [main] } }\n\njobs: {}\n';
	const result = runUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('blocks a flow-style pull_request whose branches it cannot copy', () => {
	const src = 'on:\n  pull_request: { branches: [main] }\n\njobs: {}\n';
	const result = runUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('adds the default branches when a flow-style pull_request filters none', () => {
	const src = 'on:\n  pull_request: { types: [opened] }\n\njobs: {}\n';
	const result = runUnit(unit, src);
	assert.equal(result.status, 'applied');
	assert.deepEqual(branchesOf(result.source), ['main', 'master']);
});

test('blocks a flow-style tags-only push trigger it cannot splice into', () => {
	const src = "on:\n  pull_request:\n    branches: [main, master]\n  push: { tags: ['v*'] }\n\njobs: {}\n";
	const result = runUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('skips a flow-style push trigger that already covers the branches', () => {
	const src = 'on:\n  pull_request:\n    branches: [main, master]\n  push: { branches: [main, master] }\n\njobs: {}\n';
	assert.equal(runUnit(unit, src).status, 'skip');
});

const withPush = (block) =>
	`on:
  pull_request:
    branches: [main, master]
  push:
${block}
jobs: {}
`;

test('skips when the existing push trigger already covers the branches', () => {
	assert.equal(runUnit(unit, withPush('    branches: [main, master]')).status, 'skip');
});

test('skips a push trigger with no filters, which fires on every ref', () => {
	assert.equal(runUnit(unit, 'on:\n  pull_request:\n    branches: [main]\n  push:\n\njobs: {}\n').status, 'skip');
});

test('skips a push trigger whose branch pattern covers everything', () => {
	assert.equal(runUnit(unit, withPush("    branches: ['**']")).status, 'skip');
});

test('adds branches to a tags-only push trigger, which never fires on a branch', () => {
	const result = runUnit(unit, withPush("    tags: ['v*']"));

	assert.equal(result.status, 'applied');
	assert.deepEqual(branchesOf(result.source), ['main', 'master']);
	assert.deepEqual(parseDocument(result.source).getIn(['on', 'push', 'tags']).toJSON(), ['v*']);
});

test('adding branches to a tags-only push trigger is idempotent', () => {
	const once = runUnit(unit, withPush("    tags: ['v*']")).source;
	assert.equal(runUnit(unit, once).status, 'skip');
});

test('blocks when the push trigger omits a branch the pull_request trigger covers', () => {
	const src = withPush('    branches: [main]');
	const result = runUnit(unit, src);

	assert.equal(result.status, 'blocked');
	assert.match(result.note, /master/);
	assert.equal(result.source, src);
});

test('blocks on branches-ignore, which cannot be combined with branches', () => {
	const result = runUnit(unit, withPush('    branches-ignore: [gh-pages]'));
	assert.equal(result.status, 'blocked');
});

test('blocks on a branch pattern it cannot reason about', () => {
	const result = runUnit(unit, withPush("    branches: ['release/*']"));
	assert.equal(result.status, 'blocked');
});

test('nests the added branches under push, even when pull_request filters none', () => {
	const src = `on:
  pull_request:
    types: [opened]
  push:
    tags: ['v*']

jobs: {}
`;
	const result = runUnit(unit, src);

	assert.equal(result.status, 'applied');
	assert.deepEqual(branchesOf(result.source), ['main', 'master'], 'branches must live under push');
	assert.equal(
		parseDocument(result.source).getIn(['on', 'branches']),
		undefined,
		'branches must not become a sibling trigger',
	);
});
