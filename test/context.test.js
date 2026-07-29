import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';

import { callerJobs } from '../lib/context.js';

const names = (src) => callerJobs(parseDocument(src)).map((entry) => entry.name);

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
