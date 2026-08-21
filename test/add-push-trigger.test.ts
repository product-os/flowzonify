import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, isMap } from 'yaml';
import type { YAMLSeq } from 'yaml';

import unit from '../lib/migrations/add-push-trigger.ts';
import { applyUnit } from '../lib/migrate.ts';
import { fixture, LEGACY_CALLER } from './helpers.ts';

const branchesOf = (src: string) =>
	(parseDocument(src).getIn(['on', 'push', 'branches']) as YAMLSeq).toJSON();

test('adds a push trigger that mirrors the pull_request branches', () => {
	const result = applyUnit(unit, LEGACY_CALLER);
	assert.equal(result.status, 'applied');
	assert.deepEqual(branchesOf(result.source), ['main', 'master']);
});

test('writes the branch list on one line under the trigger', () => {
	const result = applyUnit(unit, LEGACY_CALLER);
	assert.ok(result.source.includes('  push:\n    branches: [main, master]\n'));
});

test('writes a block sequence of branches out as names', () => {
	const result = applyUnit(unit, fixture('block-sequence-branches'));
	assert.equal(result.status, 'applied');
	assert.ok(result.source.includes('  push:\n    branches: [master]\n'));
	assert.deepEqual(branchesOf(result.source), ['master']);
});

test('preserves a caller branch list that is not [main, master]', () => {
	const src = `on:
  pull_request:
    branches: [develop]

jobs: {}
`;
	assert.deepEqual(branchesOf(applyUnit(unit, src).source), ['develop']);
});

test('leaves the comments around the branches list where the caller wrote them', () => {
	const src = `on:
  pull_request:
    # we only test the default branches
    branches: [main, master] # and nothing else

jobs: {}
`;
	const result = applyUnit(unit, src);

	assert.deepEqual(branchesOf(result.source), ['main', 'master']);
	assert.equal(
		result.source.match(/#/g)?.length,
		2,
		'the caller keeps both comments, and push gets neither',
	);
});

test('takes no comment from inside the branches list either', () => {
	const src = `on:
  pull_request:
    branches:
      - master # the old default
      - main

jobs: {}
`;
	const { status, edits = [], source } = applyUnit(unit, src);

	assert.equal(status, 'applied');
	assert.deepEqual(branchesOf(source), ['master', 'main']);
	assert.ok(
		!edits
			.map((edit) => edit.text)
			.join('')
			.includes('#'),
		'a comment this unit writes is one a later migration cannot revise',
	);
});

test('quotes a branch pattern that would not survive as a bare flow scalar', () => {
	const src = `on:
  pull_request:
    branches:
      - "*" # everything

jobs: {}
`;
	assert.deepEqual(branchesOf(applyUnit(unit, src).source), ['*']);
});

test('defaults to [main, master] when pull_request filters no branches', () => {
	const src = `on:
  pull_request:
    types: [opened]

jobs: {}
`;
	assert.deepEqual(branchesOf(applyUnit(unit, src).source), ['main', 'master']);
});

test('skips a workflow that already has a push trigger', () => {
	const migrated = applyUnit(unit, LEGACY_CALLER).source;
	assert.equal(applyUnit(unit, migrated).status, 'skip');
});

test('inserts the trigger directly after pull_request, not at the end of the map', () => {
	const src = `on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs: {}
`;
	const result = applyUnit(unit, src);
	const triggers = parseDocument(result.source).get('on');
	assert.ok(isMap(triggers));
	assert.deepEqual(
		triggers.items.map((pair) => String(pair.key)),
		['pull_request', 'push', 'workflow_dispatch'],
	);
});

test('handles a file whose final line is the pull_request block with no trailing newline', () => {
	const result = applyUnit(unit, 'on:\n  pull_request:\n    branches: [main]');
	assert.equal(result.status, 'applied');
	assert.deepEqual(branchesOf(result.source), ['main']);
});

test('matches the indentation of the trigger map it is inserted into', () => {
	const src = `on:
    pull_request:
        branches: [main]

jobs: {}
`;
	const result = applyUnit(unit, src);
	assert.ok(result.source.includes('    push:\n        branches: [main]\n'));
	assert.deepEqual(branchesOf(result.source), ['main']);
});

test('blocks when there is no pull_request trigger to mirror', () => {
	const src = 'on:\n  schedule:\n    - cron: "0 0 * * *"\n';
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('blocks when the triggers are a flow sequence it cannot extend safely', () => {
	const result = applyUnit(unit, 'on: [pull_request]\n');
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, 'on: [pull_request]\n');
});

test('blocks a flow-style trigger mapping it cannot splice into', () => {
	const src = 'on: { pull_request: { branches: [main] } }\n\njobs: {}\n';
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('mirrors the branches of a flow-style pull_request', () => {
	const src = 'on:\n  pull_request: { branches: [main] }\n\njobs: {}\n';
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'applied');
	assert.deepEqual(branchesOf(result.source), ['main']);
});

test('adds the default branches when a flow-style pull_request filters none', () => {
	const src = 'on:\n  pull_request: { types: [opened] }\n\njobs: {}\n';
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'applied');
	assert.deepEqual(branchesOf(result.source), ['main', 'master']);
});

test('blocks a flow-style tags-only push trigger it cannot splice into', () => {
	const src =
		"on:\n  pull_request:\n    branches: [main, master]\n  push: { tags: ['v*'] }\n\njobs: {}\n";
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('skips a flow-style push trigger that already covers the branches', () => {
	const src =
		'on:\n  pull_request:\n    branches: [main, master]\n  push: { branches: [main, master] }\n\njobs: {}\n';
	assert.equal(applyUnit(unit, src).status, 'skip');
});

const withPush = (block: string) =>
	`on:
  pull_request:
    branches: [main, master]
  push:
${block}
jobs: {}
`;

test('skips when the existing push trigger already covers the branches', () => {
	assert.equal(
		applyUnit(unit, withPush('    branches: [main, master]')).status,
		'skip',
	);
});

test('skips a push trigger with no filters, which fires on every ref', () => {
	assert.equal(
		applyUnit(
			unit,
			'on:\n  pull_request:\n    branches: [main]\n  push:\n\njobs: {}\n',
		).status,
		'skip',
	);
});

test('skips a push trigger whose branch pattern covers everything', () => {
	assert.equal(
		applyUnit(unit, withPush("    branches: ['**']")).status,
		'skip',
	);
});

test('adds branches to a tags-only push trigger, which never fires on a branch', () => {
	const result = applyUnit(unit, withPush("    tags: ['v*']"));

	assert.equal(result.status, 'applied');
	assert.deepEqual(branchesOf(result.source), ['main', 'master']);
	assert.deepEqual(
		(
			parseDocument(result.source).getIn(['on', 'push', 'tags']) as YAMLSeq
		).toJSON(),
		['v*'],
	);
});

test('adding branches to a tags-only push trigger is idempotent', () => {
	const once = applyUnit(unit, withPush("    tags: ['v*']")).source;
	assert.equal(applyUnit(unit, once).status, 'skip');
});

test('blocks when the push trigger omits a branch the pull_request trigger covers', () => {
	const src = withPush('    branches: [main]');
	const result = applyUnit(unit, src);

	assert.equal(result.status, 'blocked');
	assert.match(result.note!, /master/);
	assert.equal(result.source, src);
});

test('blocks on branches-ignore, which cannot be combined with branches', () => {
	const result = applyUnit(unit, withPush('    branches-ignore: [gh-pages]'));
	assert.equal(result.status, 'blocked');
});

test('blocks on a branch pattern it cannot reason about', () => {
	const result = applyUnit(unit, withPush("    branches: ['release/*']"));
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
	const result = applyUnit(unit, src);

	assert.equal(result.status, 'applied');
	assert.deepEqual(
		branchesOf(result.source),
		['main', 'master'],
		'branches must live under push',
	);
	assert.equal(
		parseDocument(result.source).getIn(['on', 'branches']),
		undefined,
		'branches must not become a sibling trigger',
	);
});
