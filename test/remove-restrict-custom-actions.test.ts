import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import type { YAMLMap } from 'yaml';

import unit from '../lib/migrations/remove-restrict-custom-actions.ts';
import { applyUnit } from '../lib/migrate.ts';
import { caller } from './helpers.ts';

test('removes the deprecated input while keeping the other inputs', () => {
	const src = caller(`    with:
      restrict_custom_actions: false
      docker_images: example-org/example-app
`);
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'applied');
	assert.ok(!result.source.includes('restrict_custom_actions'));
	assert.ok(
		result.source.includes('      docker_images: example-org/example-app'),
	);
});

test('removes the whole with block when the deprecated input was the only entry', () => {
	const src = caller(`    with:
      restrict_custom_actions: false
`);
	const result = applyUnit(unit, src);
	assert.ok(!result.source.includes('with:'));
	assert.equal(result.source, caller());
});

test('removes the comment that documents the input', () => {
	const src = caller(`    with:
      # forks may not run our custom actions
      restrict_custom_actions: false
      docker_images: example-org/example-app
`);
	assert.ok(
		!applyUnit(unit, src).source.includes(
			'forks may not run our custom actions',
		),
	);
});

test('blocks a flow-style with: it cannot splice the input out of', () => {
	const src = caller(
		'    with: { restrict_custom_actions: false, docker_images: img }\n',
	);
	const result = applyUnit(unit, src);

	assert.equal(result.status, 'blocked');
	assert.equal(result.source, src);
});

test('drops a flow-style with: whose only entry is the deprecated input', () => {
	const src = caller('    with: { restrict_custom_actions: false }\n');
	const result = applyUnit(unit, src);

	assert.equal(result.status, 'applied');
	assert.ok(!result.source.includes('with:'));
});

test('skips a caller that never set the input', () => {
	const src = caller(
		'    with:\n      docker_images: example-org/example-app\n',
	);
	assert.equal(applyUnit(unit, src).status, 'skip');
});

test('skips a caller with no inputs at all', () => {
	assert.equal(applyUnit(unit, caller()).status, 'skip');
});

test('skips a workflow that has already been migrated', () => {
	const src = caller(
		'    with:\n      restrict_custom_actions: false\n      docker_images: x\n',
	);
	const migrated = applyUnit(unit, src).source;
	assert.equal(applyUnit(unit, migrated).status, 'skip');
});

test('leaves the input alone on a job that is not a flowzone caller', () => {
	const src = `jobs:
  other:
    uses: product-os/something-else/.github/workflows/build.yml@master
    with:
      restrict_custom_actions: false
`;
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'skip');
	assert.equal(result.source, src);
});

test('removes the input from every caller job in the file', () => {
	const src = `jobs:
  a:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    with:
      restrict_custom_actions: false
      docker_images: one
  b:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    with:
      restrict_custom_actions: false
      docker_images: two
`;
	const result = applyUnit(unit, src);
	assert.ok(!result.source.includes('restrict_custom_actions'));

	const jobs = parseDocument(result.source).get('jobs') as YAMLMap;
	assert.equal(jobs.getIn(['a', 'with', 'docker_images']), 'one');
	assert.equal(jobs.getIn(['b', 'with', 'docker_images']), 'two');
});
