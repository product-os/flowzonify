import { test } from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import { lintWorkflow, lintRegressions } from '../lib/actionlint.ts';
import { migrate } from '../lib/migrate.ts';
import { LEGACY_CALLER, repo } from './helpers.ts';

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

/** Probed once: a missing binary cannot appear part-way through a run. */
const AVAILABLE = lintWorkflow(VALID).available;

/** A test that needs actionlint on PATH, skipped rather than failed when it is absent. */
function withActionlint(name: string, run: () => void): void {
	test(name, (t) => {
		if (!AVAILABLE) {
			return t.skip('actionlint is not installed');
		}
		run();
	});
}

test('reports itself unavailable rather than throwing when the binary is missing', () => {
	const result = lintWorkflow(VALID, { bin: 'actionlint-does-not-exist' });
	assert.equal(result.available, false);
	assert.equal(result.ok, true, 'an absent linter must not fail the migration');
});

withActionlint('passes a migrated caller workflow', () => {
	const result = lintWorkflow(VALID);
	assert.equal(result.ok, true, result.output);
});

withActionlint('fails a workflow with a real problem and explains why', () => {
	const result = lintWorkflow(INVALID);
	assert.equal(result.ok, false);
	assert.match(result.output, /nope/);
});

withActionlint(
	'lintRegressions accepts a migration that introduces no new diagnostics',
	() => {
		const result = lintRegressions(LEGACY_CALLER, VALID);
		assert.equal(result.ok, true, result.output);
	},
);

withActionlint(
	'lintRegressions tolerates a diagnostic the workflow already had',
	() => {
		// `with: {}` is something callers really do; actionlint rejects it, but the
		// migration did not cause it and must not be blamed for it.
		const before = LEGACY_CALLER.replace(
			'    secrets: inherit\n',
			'    secrets: inherit\n    with: {}\n',
		);
		const after = migrate(before).source;

		const result = lintRegressions(before, after);
		assert.equal(lintWorkflow(after).ok, false, 'the output really is unclean');
		assert.equal(
			result.ok,
			true,
			`pre-existing diagnostics must not block: ${result.output}`,
		);
	},
);

withActionlint(
	'lintRegressions rejects a diagnostic the migration introduced',
	() => {
		const broken = LEGACY_CALLER.replace(
			'    secrets: inherit\n',
			'    secrets: inherit\n    with:\n      x: ${{ github.nope }}\n',
		);
		const result = lintRegressions(LEGACY_CALLER, broken);
		assert.equal(result.ok, false);
		assert.match(result.output, /nope/);
	},
);

test('lintRegressions passes when actionlint is not installed', () => {
	const result = lintRegressions(LEGACY_CALLER, VALID, {
		bin: 'actionlint-does-not-exist',
	});
	assert.equal(result.available, false);
	assert.equal(result.ok, true);
});

test('a linter that cannot be run at all is reported, not called absent', () => {
	// A file that exists but is not executable fails with EACCES rather than ENOENT,
	// which is the same branch a timeout arrives on. "Broken" is not "not installed":
	// only the latter is allowed to pass quietly.
	const result = lintWorkflow(VALID, {
		bin: join(repo({ 'not-executable': '' }), 'not-executable'),
	});

	assert.equal(result.available, true);
	assert.equal(result.ok, false);
	assert.match(result.output, /EACCES/);
});

test('lintRegressions refuses a linter that fails without saying anything', () => {
	// `false` exits non-zero and prints nothing, which is what a crashed or
	// misconfigured actionlint looks like from here. Present but unparseable is not
	// the same as absent: an absent linter proves nothing and is allowed to, whereas
	// this one failed and we cannot tell whether the migration is why.
	const result = lintRegressions(LEGACY_CALLER, VALID, { bin: 'false' });

	assert.equal(result.available, true);
	assert.equal(
		result.ok,
		false,
		'an unattributable failure must not read as clean',
	);
	assert.match(result.output, /without reporting a diagnostic/);
});
