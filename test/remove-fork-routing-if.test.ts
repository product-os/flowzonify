import { test } from 'node:test';
import assert from 'node:assert/strict';

import unit from '../lib/migrations/remove-fork-routing-if.ts';
import { applyUnit, parseWorkflow } from '../lib/migrate.ts';
import { caller, LEGACY_CALLER, REFLOWED_ROUTING_IF } from './helpers.ts';

test('removes the block-scalar routing condition and the comment above it', () => {
	const result = applyUnit(unit, LEGACY_CALLER);
	assert.equal(result.status, 'applied');
	assert.ok(!result.source.includes('if:'));
	assert.ok(!result.source.includes('prevent duplicate workflow executions'));
	assert.ok(
		result.source.includes('flowzone.yml@master\n    secrets: inherit\n'),
	);
});

test('removes the reflowed one-clause-per-line variant of the same condition', () => {
	const result = applyUnit(unit, caller(REFLOWED_ROUTING_IF));
	assert.equal(result.status, 'applied');
	assert.ok(!result.source.includes('if:'));
});

test('skips a caller job that has no condition', () => {
	const src = caller(`    with:
      docker_images: example-org/example-app
`);
	assert.equal(applyUnit(unit, src).status, 'skip');
});

test('skips a workflow that has already been migrated', () => {
	const migrated = applyUnit(unit, LEGACY_CALLER).source;
	assert.equal(applyUnit(unit, migrated).status, 'skip');
});

test('leaves a caller condition that has nothing to do with fork routing', () => {
	const src = caller("    if: github.actor != 'balena-renovate[bot]'\n");
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'skip');
	assert.equal(result.source, src);
});

test('blocks on a fork-routing condition that carries extra clauses', () => {
	const src = caller(`    if: |
      github.actor != 'dependabot[bot]' && (
      (github.event.pull_request.head.repo.full_name == github.repository && github.event_name == 'pull_request') ||
      (github.event.pull_request.head.repo.full_name != github.repository && github.event_name == 'pull_request_target'))
`);
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'blocked');
	assert.match(result.note!, /by hand/i);
	assert.equal(result.source, src);
});

test('removes the condition from a caller job that is not named flowzone', () => {
	const src = `jobs:
  ci:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
${REFLOWED_ROUTING_IF}    secrets: inherit
`;
	assert.equal(applyUnit(unit, src).status, 'applied');
});

test('ignores a matching condition on a job that is not a flowzone caller', () => {
	const src = `jobs:
  other:
    uses: product-os/something-else/.github/workflows/build.yml@master
${REFLOWED_ROUTING_IF}`;
	const result = applyUnit(unit, src);
	assert.equal(result.status, 'skip');
	assert.equal(result.source, src);
});

/** The compact spelling used elsewhere in the org, e.g. yocto-build-deploy workflows. */
const COMPACT_ROUTING =
	"    if: (github.event.pull_request.head.repo.full_name == github.repository) == (github.event_name == 'pull_request')\n";

test('removes the compact equality spelling of the same routing condition', () => {
	const result = applyUnit(unit, caller(COMPACT_ROUTING));

	assert.equal(result.status, 'applied');
	assert.ok(!result.source.includes('if:'));
	assert.ok(
		result.source.includes('flowzone.yml@master\n    secrets: inherit\n'),
	);
});

test('removes the explanatory comment block that comes with the compact spelling', () => {
	const documented = caller(
		[
			'    # Prevent duplicate workflow executions for pull_request (PR) and pull_request_target (PRT) events.',
			'    # - internal PR (true == true) ok',
			'    # - fork PR (false != true) skip',
			COMPACT_ROUTING.trimEnd(),
			'',
		].join('\n'),
	);
	const result = applyUnit(unit, documented);

	assert.equal(result.status, 'applied');
	assert.ok(!result.source.includes('Prevent duplicate workflow executions'));
	assert.ok(!result.source.includes('internal PR'));
});

test('the compact spelling is idempotent once removed', () => {
	const migrated = applyUnit(unit, caller(COMPACT_ROUTING)).source;
	assert.equal(applyUnit(unit, migrated).status, 'skip');
});

test('the postcondition catches a surviving routing condition of either spelling', () => {
	for (const surviving of [COMPACT_ROUTING, REFLOWED_ROUTING_IF]) {
		const doc = parseWorkflow(caller(surviving));
		assert.match(unit.verify(doc) ?? '', /still routes fork pull requests/);
	}
	assert.equal(unit.verify(parseWorkflow(caller())), undefined);
});
