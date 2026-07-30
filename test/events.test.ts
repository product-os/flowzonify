import { test } from 'node:test';
import assert from 'node:assert/strict';

import { illegalFilters } from '../lib/events.ts';
import { parseWorkflow } from '../lib/migrate.ts';

const on = (body: string) => parseWorkflow(`on:\n${body}jobs: {}\n`);

test('accepts the filters each event really allows', () => {
	const doc = on(`  push:
    branches: [main]
    branches-ignore: [gh-pages]
    tags: ['v*']
    tags-ignore: ['nightly*']
    paths: ['src/**']
    paths-ignore: ['docs/**']
  pull_request:
    types: [opened, synchronize, closed]
    branches: [main]
    paths: ['src/**']
`);
	assert.deepEqual(illegalFilters(doc), []);
});

test('rejects types on push, which is what a mis-spliced filter list looks like', () => {
	const doc = on('  push:\n    types: [opened]\n    branches: [main]\n');
	assert.deepEqual(illegalFilters(doc), ['push.types']);
});

test('rejects tag filters on pull_request', () => {
	const doc = on("  pull_request:\n    tags: ['v*']\n    tags-ignore: ['x']\n");
	assert.deepEqual(illegalFilters(doc), [
		'pull_request.tags',
		'pull_request.tags-ignore',
	]);
});

test('says nothing about events it has no table for', () => {
	const doc = on(
		'  workflow_dispatch:\n    inputs:\n      why:\n        type: string\n',
	);
	assert.deepEqual(illegalFilters(doc), []);
});

test('says nothing about a trigger with no filters at all', () => {
	assert.deepEqual(illegalFilters(on('  push:\n  pull_request:\n')), []);
});

test('says nothing when the triggers are a flow sequence', () => {
	assert.deepEqual(
		illegalFilters(parseWorkflow('on: [push, pull_request]\njobs: {}\n')),
		[],
	);
});

test('says nothing when there are no triggers', () => {
	assert.deepEqual(illegalFilters(parseWorkflow('jobs: {}\n')), []);
});
