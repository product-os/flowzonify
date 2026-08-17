import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';

import {
	callerInput,
	callerJobs,
	inputRemoval,
	jobPassingInput,
	versioningDisabled,
} from '../lib/context.ts';

const names = (src: string) =>
	callerJobs(parseDocument(src)).map((entry) => entry.name);

test('callerJobs finds the job that calls the flowzone reusable workflow', () => {
	const src = `jobs:
  flowzone:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    secrets: inherit
`;
	assert.deepEqual(names(src), ['flowzone']);
});

test('callerJobs finds the caller job whatever the job is named', () => {
	const src = `jobs:
  ci:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
`;
	assert.deepEqual(names(src), ['ci']);
});

test('callerJobs matches any ref, not just @master', () => {
	const src = `jobs:
  a:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@v23.0.2
  b:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@8b72c6a7
`;
	assert.deepEqual(names(src), ['a', 'b']);
});

test('callerJobs ignores jobs that call a different reusable workflow', () => {
	const src = `jobs:
  other:
    uses: product-os/some-other/.github/workflows/build.yml@master
`;
	assert.deepEqual(names(src), []);
});

test('callerJobs ignores jobs that only run steps', () => {
	const src = `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
	assert.deepEqual(names(src), []);
});

test('callerJobs rejects the flowzone reusable workflow itself', () => {
	const src = `on:
  workflow_call:
    inputs:
      restrict_custom_actions:
        type: boolean
jobs:
  event_types:
    runs-on: ubuntu-latest
    steps:
      - run: echo 'product-os/flowzone/.github/workflows/flowzone.yml@master'
`;
	assert.deepEqual(names(src), []);
});

test('callerJobs returns an empty list when the document has no jobs', () => {
	assert.deepEqual(names('on:\n  push:\n    branches: [main]\n'), []);
});

test('callerJobs returns an empty list for a document that is not a mapping', () => {
	assert.deepEqual(names('- not a workflow\n'), []);
});

test('callerJobs exposes the job node so units can read its keys', () => {
	const src = `jobs:
  flowzone:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    with:
      restrict_custom_actions: false
`;
	const [entry] = callerJobs(parseDocument(src));
	assert.equal(entry.node.getIn(['with', 'restrict_custom_actions']), false);
});

const job = (src: string) => callerJobs(parseDocument(src))[0].node;

const withInputs = (inputs: string) => `jobs:
  flowzone:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
${inputs}`;

test('callerInput finds an input and the block it lives in', () => {
	const found = callerInput(
		job(withInputs('    with:\n      custom_runs_on: \'["self-hosted"]\'\n')),
		'custom_runs_on',
	);

	assert.ok(found);
	assert.equal(String(found.input.key), 'custom_runs_on');
	assert.equal(String(found.inputs.key), 'with');
	assert.equal(found.block.items.length, 1);
});

test('callerInput reports nothing for a job with no `with:` block at all', () => {
	assert.equal(
		callerInput(job(withInputs('    secrets: inherit\n')), 'custom_runs_on'),
		undefined,
	);
});

test('callerInput reports nothing when the block does not carry that input', () => {
	assert.equal(
		callerInput(
			job(withInputs('    with:\n      docker_images: org/app\n')),
			'custom_runs_on',
		),
		undefined,
	);
});

test('jobPassingInput names the first caller still passing the input', () => {
	const src = `jobs:
  clean:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
  legacy:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    with:
      restrict_custom_actions: false
`;
	assert.equal(
		jobPassingInput(parseDocument(src), 'restrict_custom_actions'),
		'legacy',
	);
});

test('jobPassingInput names nobody once the input is gone', () => {
	assert.equal(
		jobPassingInput(
			parseDocument(withInputs('    secrets: inherit\n')),
			'restrict_custom_actions',
		),
		undefined,
	);
});

test('inputRemoval takes the whole `with:` block when the input is its last', () => {
	const found = callerInput(
		job(withInputs('    with:\n      restrict_custom_actions: false\n')),
		'restrict_custom_actions',
	);
	assert.ok(found);

	// An empty `with:` fails actionlint, so the block goes with its final input.
	assert.equal(String(inputRemoval(found)?.key), 'with');
});

test('inputRemoval takes just the input when the block has others', () => {
	const found = callerInput(
		job(
			withInputs(
				'    with:\n      docker_images: org/app\n      restrict_custom_actions: false\n',
			),
		),
		'restrict_custom_actions',
	);
	assert.ok(found);

	assert.equal(String(inputRemoval(found)?.key), 'restrict_custom_actions');
});

test('inputRemoval refuses to splice one input out of a flow-style block', () => {
	const found = callerInput(
		job(
			withInputs(
				'    with: { docker_images: org/app, restrict_custom_actions: false }\n',
			),
		),
		'restrict_custom_actions',
	);
	assert.ok(found);

	// The pairs share a line, so removing one by whole lines would take its siblings.
	assert.equal(inputRemoval(found), undefined);
});

test('inputRemoval still drops a flow-style block that owns its line entirely', () => {
	const found = callerInput(
		job(withInputs('    with: { restrict_custom_actions: false }\n')),
		'restrict_custom_actions',
	);
	assert.ok(found);

	assert.equal(String(inputRemoval(found)?.key), 'with');
});

const disabled = (src: string) => versioningDisabled(parseDocument(src));

const withVersioning = (value: string) =>
	withInputs(`    with:\n      disable_versioning: ${value}\n`);

test('versioningDisabled sees a caller that turns versioning off', () => {
	assert.equal(disabled(withVersioning('true')), true);
});

test('versioningDisabled sees the quoted spelling too', () => {
	// flowzone declares the input as `type: boolean`, so GitHub accepts either.
	assert.equal(disabled(withVersioning("'true'")), true);
});

test('versioningDisabled leaves versioning on when the input says false', () => {
	assert.equal(disabled(withVersioning('false')), false);
});

test('versioningDisabled leaves versioning on when there is no such input', () => {
	assert.equal(
		disabled(withInputs('    with:\n      github_prerelease: true\n')),
		false,
	);
});

test('versioningDisabled leaves versioning on when there is no with block', () => {
	assert.equal(disabled(withInputs('    secrets: inherit\n')), false);
});

test('versioningDisabled leaves versioning on for a value it cannot evaluate', () => {
	// An expression is only known at run time. Assuming versioning is on is the safe
	// direction: a redundant footer is inert, while a missing one fails the caller's
	// versioning job.
	assert.equal(disabled(withVersioning('${{ vars.SKIP }}')), false);
});

test('versioningDisabled ignores the input on a job that is not a caller', () => {
	// The reason this reads the parsed document rather than matching text: the input
	// only means anything inside a job that calls flowzone.
	assert.equal(
		disabled(`jobs:
  something-else:
    uses: other-org/other/.github/workflows/build.yml@master
    with:
      disable_versioning: true
  flowzone:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    secrets: inherit
`),
		false,
	);
});

test('versioningDisabled leaves versioning on when nothing calls flowzone', () => {
	assert.equal(
		disabled('jobs:\n  build:\n    runs-on: ubuntu-latest\n'),
		false,
	);
});
