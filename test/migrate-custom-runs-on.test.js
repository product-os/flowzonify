import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';

import unit from '../lib/migrations/migrate-custom-runs-on.js';
import { runUnit, caller, LEGACY_CALLER } from './helpers.js';

const RUNNERS = '[["ubuntu-latest"],["macos-latest"],["windows-2022"]]';

const withInput = (value = RUNNERS) =>
	caller(`    with:
      custom_runs_on: '${value}'
`);

const matrixOf = (src, key) => JSON.parse(String(parseDocument(src).getIn(['jobs', 'flowzone', 'with', key])));

test('moves the runners into the test matrix when the repo has a custom test action', () => {
	const result = runUnit(unit, withInput(), { customActions: ['test'] });

	assert.equal(result.status, 'applied');
	assert.deepEqual(matrixOf(result.source, 'custom_test_matrix'), { os: JSON.parse(RUNNERS) });
	assert.ok(!result.source.includes('custom_runs_on'), 'the deprecated input is gone');
});

test('moves the runners into the publish matrix when that is the custom action', () => {
	const result = runUnit(unit, withInput('["windows-2022"]'), { customActions: ['publish'] });

	assert.deepEqual(matrixOf(result.source, 'custom_publish_matrix'), { os: ['windows-2022'] });
	assert.ok(!result.source.includes('custom_test_matrix'), 'no matrix for an action the repo lacks');
});

test('writes a matrix for every matrix-capable custom action the repo has', () => {
	const result = runUnit(unit, withInput(), {
		customActions: ['test', 'publish', 'finalize'],
	});

	for (const key of ['custom_test_matrix', 'custom_publish_matrix', 'custom_finalize_matrix']) {
		assert.deepEqual(matrixOf(result.source, key), { os: JSON.parse(RUNNERS) });
	}
});

test('produces a workflow that still parses and keeps the other inputs', () => {
	const src = caller(`    with:
      custom_runs_on: '${RUNNERS}'
      docker_images: example-org/example-app
`);
	const result = runUnit(unit, src, { customActions: ['test'] });

	assert.doesNotThrow(() => parseDocument(result.source));
	assert.ok(result.source.includes('docker_images: example-org/example-app'));
});

test('drops the input as dead configuration when the repo has no custom actions', () => {
	const result = runUnit(unit, withInput(), { customActions: [] });

	assert.equal(result.status, 'applied');
	assert.ok(!result.source.includes('custom_runs_on'));
	assert.ok(!result.source.includes('_matrix'), 'no matrix for jobs that do not exist');
	assert.ok(!result.source.includes('with:'), 'an empty `with:` fails actionlint, so it goes too');
});

test('keeps the with: block when the dead input has siblings', () => {
	const src = caller(`    with:
      custom_runs_on: '${RUNNERS}'
      docker_images: example-org/example-app
`);
	const result = runUnit(unit, src, { customActions: [] });

	assert.ok(!result.source.includes('custom_runs_on'));
	assert.ok(result.source.includes('    with:\n      docker_images: example-org/example-app'));
});

test('warns that clean and always fall back to runs_on, since they have no matrix', () => {
	const result = runUnit(unit, withInput(), { customActions: ['test', 'clean'] });

	assert.equal(result.status, 'advisory');
	assert.match(result.note, /clean/);
	assert.deepEqual(matrixOf(result.source, 'custom_test_matrix'), { os: JSON.parse(RUNNERS) });
	assert.ok(!result.source.includes('custom_runs_on'));
});

test('blocks rather than merging into a matrix the caller already wrote', () => {
	const src = caller(`    with:
      custom_runs_on: '${RUNNERS}'
      custom_test_matrix: >
        {
          "environment": ["test"]
        }
`);
	const result = runUnit(unit, src, { customActions: ['test'] });

	assert.equal(result.status, 'blocked');
	assert.match(result.note, /custom_test_matrix/);
	assert.equal(result.source, src);
});

test('skips a caller that does not use the deprecated input', () => {
	assert.equal(runUnit(unit, LEGACY_CALLER, { customActions: ['test'] }).status, 'skip');
});

test('skips when the repository is unknown, rather than guessing', () => {
	const result = runUnit(unit, withInput(), {});
	assert.equal(result.status, 'skip');
	assert.match(result.note ?? '', /context/i);
});

test('is idempotent', () => {
	const once = runUnit(unit, withInput(), { customActions: ['test'] });
	assert.equal(runUnit(unit, once.source, { customActions: ['test'] }).status, 'skip');
});

test('ignores the input on a job that is not a flowzone caller', () => {
	const src = `jobs:
  other:
    uses: product-os/something-else/.github/workflows/build.yml@master
    with:
      custom_runs_on: '["windows-2022"]'
`;
	assert.equal(runUnit(unit, src, { customActions: ['test'] }).status, 'skip');
});

test('blocks a flow-style with: it cannot splice the input out of', () => {
	const src = caller(`    with: { custom_runs_on: '["x"]', docker_images: img }\n`);
	const result = runUnit(unit, src, { customActions: ['test'] });

	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('drops a flow-style with: whose only entry is the dead input', () => {
	const src = caller(`    with: { custom_runs_on: '["x"]' }\n`);
	const result = runUnit(unit, src, { customActions: [] });

	assert.equal(result.status, 'applied');
	assert.ok(!result.source.includes('with:'));
});

test('folds a block-scalar runners value onto one line', () => {
	const src = caller(`    with:
      custom_runs_on: |
        ["self-hosted",
         "big"]
`);
	const result = runUnit(unit, src, { customActions: ['test'] });

	assert.equal(result.status, 'applied');
	assert.deepEqual(matrixOf(result.source, 'custom_test_matrix'), { os: ['self-hosted', 'big'] });
});

test('blocks on a runners value that is not a JSON array', () => {
	for (const value of ['ubuntu-latest', '{"os": "x"}', 'not json at all']) {
		const src = caller(`    with:\n      custom_runs_on: '${value}'\n`);
		const result = runUnit(unit, src, { customActions: ['test'] });

		assert.equal(result.status, 'blocked', `expected ${value} to be refused`);
		assert.equal(result.source, src);
	}
});
