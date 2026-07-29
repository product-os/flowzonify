import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';

import { applyEdits, pairFor, pairRange } from '../lib/source.js';

test('applyEdits replaces a single range', () => {
	assert.equal(applyEdits('abcdef', [{ start: 2, end: 4, text: 'XY' }]), 'abXYef');
});

test('applyEdits returns the source unchanged for an empty edit list', () => {
	assert.equal(applyEdits('abcdef', []), 'abcdef');
});

test('applyEdits applies several edits regardless of the order given', () => {
	const edits = [
		{ start: 4, end: 5, text: '' },
		{ start: 0, end: 1, text: '' },
	];
	assert.equal(applyEdits('abcdef', edits), 'bcdf');
	assert.equal(applyEdits('abcdef', [...edits].reverse()), 'bcdf');
});

test('applyEdits supports pure insertion at a point', () => {
	assert.equal(applyEdits('abcdef', [{ start: 3, end: 3, text: '--' }]), 'abc--def');
});

test('applyEdits throws when two edits overlap', () => {
	const edits = [
		{ start: 0, end: 3, text: '' },
		{ start: 2, end: 5, text: '' },
	];
	assert.throws(() => applyEdits('abcdef', edits), /overlap/i);
});

const doc = (src) => parseDocument(src);
const pairOf = (document, key) => pairFor(document.get('on'), key);

test('pairRange covers the whole line of a simple pair', () => {
	const src = 'on:\n  push:\n    branches: [main]\n  release:\n    types: [published]\n';
	const [start, end] = pairRange(src, pairOf(doc(src), 'push'));
	assert.equal(src.slice(start, end), '  push:\n    branches: [main]\n');
});

test('pairRange includes the comment lines that precede the key', () => {
	const src =
		'on:\n  # first line of comment\n  # second line\n  push:\n    branches: [main]\n  release:\n    types: [published]\n';
	const [start, end] = pairRange(src, pairOf(doc(src), 'push'));
	assert.equal(
		src.slice(start, end),
		'  # first line of comment\n  # second line\n  push:\n    branches: [main]\n',
	);
});

test('pairRange stops at a blank line rather than swallowing a detached comment', () => {
	const src =
		'on:\n  # comment about the file, not about push\n\n  push:\n    branches: [main]\n  release:\n    types: [published]\n';
	const [start, end] = pairRange(src, pairOf(doc(src), 'push'));
	assert.equal(src.slice(start, end), '  push:\n    branches: [main]\n');
});

test('pairRange covers the final pair of a document with no trailing newline', () => {
	const src = 'on:\n  push:\n    branches: [main]';
	const [start, end] = pairRange(src, pairOf(doc(src), 'push'));
	assert.equal(src.slice(start, end), '  push:\n    branches: [main]');
});

test('pairRange covers a pair whose value is a block sequence', () => {
	const src = 'on:\n  push:\n    branches:\n      - main\n      - master\n  release:\n    types: [published]\n';
	const branches = pairFor(doc(src).getIn(['on', 'push']), 'branches');
	const [start, end] = pairRange(src, branches);
	assert.equal(src.slice(start, end), '    branches:\n      - main\n      - master\n');
});

test('pairRange refuses a pair that shares its line with flow siblings', () => {
	const src = 'with: { a: 1, b: 2 }\n';
	const inputs = pairFor(doc(src).contents, 'with');
	assert.throws(() => pairRange(src, pairFor(inputs.value, 'b')), /own line/);
});
