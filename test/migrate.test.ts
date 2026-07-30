import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isMap } from 'yaml';

import { migrate, WorkflowParseError } from '../lib/migrate.ts';
import type { Migration } from '../lib/migrate.ts';
import { pairFor, pairRange } from '../lib/source.ts';
import { BROKEN_WORKFLOW } from './helpers.ts';

const WORKFLOW = `on:
  push:
    branches: [main]
  release:
    types: [published]
`;

const deleteTrigger = (id: string, key: string): Migration => ({
	id,
	description: `delete on.${key}`,
	apply(src, doc) {
		const pair = pairFor(doc.get('on'), key);
		if (!pair) {
			return { status: 'skip' };
		}
		const [start, end] = pairRange(src, pair);
		return { status: 'applied', edits: [{ start, end, text: '' }] };
	},
});

test('migrate returns the source untouched when every unit skips', () => {
	const result = migrate(WORKFLOW, [deleteTrigger('a', 'absent')]);
	assert.equal(result.source, WORKFLOW);
	assert.equal(result.changed, false);
	assert.equal(result.status, 'ok');
});

test('migrate applies a unit that reports edits', () => {
	const result = migrate(WORKFLOW, [deleteTrigger('drop-release', 'release')]);
	assert.equal(result.source, 'on:\n  push:\n    branches: [main]\n');
	assert.equal(result.changed, true);
});

test('migrate records every unit in the report, in registry order', () => {
	const result = migrate(WORKFLOW, [
		deleteTrigger('first', 'release'),
		deleteTrigger('second', 'absent'),
	]);
	assert.deepEqual(
		result.report.map((entry) => [entry.id, entry.status]),
		[
			['first', 'applied'],
			['second', 'skip'],
		],
	);
});

test('migrate reparses between units so each one sees the previous output', () => {
	const seen: string[][] = [];
	const observer: Migration = {
		id: 'observer',
		description: 'record the triggers it can see',
		apply(_src, doc) {
			const triggers = doc.get('on');
			seen.push(
				isMap(triggers) ? triggers.items.map((item) => String(item.key)) : [],
			);
			return { status: 'skip' };
		},
	};
	migrate(WORKFLOW, [
		observer,
		deleteTrigger('drop-release', 'release'),
		observer,
	]);
	assert.deepEqual(seen, [['push', 'release'], ['push']]);
});

test('migrate reports advisory status for a unit that only has something to say', () => {
	const advisory: Migration = {
		id: 'advise',
		description: 'advise',
		apply: () => ({ status: 'advisory', note: 'follow up on something' }),
	};
	const result = migrate(WORKFLOW, [advisory]);
	assert.equal(result.source, WORKFLOW);
	assert.equal(result.status, 'advisory');
	assert.equal(result.report[0].note, 'follow up on something');
});

test('migrate applies the edits of a unit that did its work and still has something to say', () => {
	const advisory: Migration = {
		id: 'advise',
		description: 'advise',
		apply(src, doc) {
			const pair = pairFor(doc.get('on'), 'release')!;
			const [start, end] = pairRange(src, pair);
			return {
				status: 'advisory',
				edits: [{ start, end, text: '' }],
				note: 'heads up',
			};
		},
	};
	const result = migrate(WORKFLOW, [advisory]);

	assert.equal(result.status, 'advisory');
	assert.equal(result.changed, true);
	assert.equal(result.source, 'on:\n  push:\n    branches: [main]\n');
});

test('migrate reports blocked status and discards any partial work', () => {
	const blocked: Migration = {
		id: 'blocked',
		description: 'blocked',
		apply: () => ({ status: 'blocked', note: 'needs a human' }),
	};
	const result = migrate(WORKFLOW, [
		deleteTrigger('drop-release', 'release'),
		blocked,
	]);
	assert.equal(result.status, 'blocked');
	assert.equal(
		result.source,
		WORKFLOW,
		'a blocked run must not emit a half-migrated file',
	);
	assert.equal(result.changed, false);
});

test('migrate prefers blocked over advisory when both occur', () => {
	const units: Migration[] = [
		{
			id: 'a',
			description: 'a',
			apply: () => ({ status: 'advisory', note: 'n' }),
		},
		{
			id: 'b',
			description: 'b',
			apply: () => ({ status: 'blocked', note: 'n' }),
		},
	];
	const result = migrate(WORKFLOW, units);
	assert.equal(result.status, 'blocked');
});

test('migrate throws WorkflowParseError for input that is not valid YAML', () => {
	assert.throws(() => migrate(BROKEN_WORKFLOW, []), WorkflowParseError);
});

test('a parse failure reports every problem, not just the first', () => {
	// This fixture really does produce more than one: reporting one at a time makes
	// hand-migrating it a round trip per error.
	assert.throws(
		() => migrate(BROKEN_WORKFLOW, []),
		(error: unknown) => {
			assert.ok(error instanceof WorkflowParseError);
			const [summary, ...problems] = error.message.split('\n');
			assert.ok(problems.length > 1, `only reported: ${error.message}`);
			assert.match(summary, new RegExp(`${problems.length} problems$`));
			// One line each, so the summary stays usable as the sweep's one-line detail.
			assert.ok(problems.every((problem) => problem.startsWith('  ')));
			return true;
		},
	);
});

test('migrate is idempotent: running it on its own output changes nothing', () => {
	const units = [deleteTrigger('drop-release', 'release')];
	const once = migrate(WORKFLOW, units);
	const twice = migrate(once.source, units);
	assert.equal(twice.source, once.source);
	assert.equal(twice.changed, false);
});
