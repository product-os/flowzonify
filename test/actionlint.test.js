import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lintWorkflow, lintRegressions } from '../lib/actionlint.js';
import { migrate } from '../lib/migrate.js';
import { LEGACY_CALLER } from './helpers.js';

const VALID = migrate(LEGACY_CALLER).source;
const INVALID = `name: x
on:
  push:
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ github.nope }}
`;

test('reports itself unavailable rather than throwing when the binary is missing', () => {
	const result = lintWorkflow(VALID, { bin: 'actionlint-does-not-exist' });
	assert.equal(result.available, false);
	assert.equal(result.ok, true, 'an absent linter must not fail the migration');
});

test('passes a migrated caller workflow', (t) => {
	const result = lintWorkflow(VALID);
	if (!result.available) {
		return t.skip('actionlint is not installed');
	}
	assert.equal(result.ok, true, result.output);
});

test('fails a workflow with a real problem and explains why', (t) => {
	const result = lintWorkflow(INVALID);
	if (!result.available) {
		return t.skip('actionlint is not installed');
	}
	assert.equal(result.ok, false);
	assert.match(result.output, /nope/);
});

test('lintRegressions accepts a migration that introduces no new diagnostics', (t) => {
	const result = lintRegressions(LEGACY_CALLER, VALID);
	if (!result.available) {
		return t.skip('actionlint is not installed');
	}
	assert.equal(result.ok, true, result.output);
});

test('lintRegressions tolerates a diagnostic the workflow already had', (t) => {
	// `with: {}` is something callers really do; actionlint rejects it, but the
	// migration did not cause it and must not be blamed for it.
	const before = LEGACY_CALLER.replace('    secrets: inherit\n', '    secrets: inherit\n    with: {}\n');
	const after = migrate(before).source;

	const result = lintRegressions(before, after);
	if (!result.available) {
		return t.skip('actionlint is not installed');
	}
	assert.equal(lintWorkflow(after).ok, false, 'the output really is unclean');
	assert.equal(result.ok, true, `pre-existing diagnostics must not block: ${result.output}`);
});

test('lintRegressions rejects a diagnostic the migration introduced', (t) => {
	const broken = LEGACY_CALLER.replace(
		'    secrets: inherit\n',
		'    secrets: inherit\n    with:\n      x: ${{ github.nope }}\n',
	);
	const result = lintRegressions(LEGACY_CALLER, broken);
	if (!result.available) {
		return t.skip('actionlint is not installed');
	}
	assert.equal(result.ok, false);
	assert.match(result.output, /nope/);
});

test('lintRegressions passes when actionlint is not installed', () => {
	const result = lintRegressions(LEGACY_CALLER, VALID, { bin: 'actionlint-does-not-exist' });
	assert.equal(result.available, false);
	assert.equal(result.ok, true);
});

