import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { migrate, WorkflowParseError, parseWorkflow } from '../lib/migrate.ts';
import type { Context } from '../lib/migrate.ts';
import { callerJobs } from '../lib/context.ts';
import { MIGRATIONS } from '../lib/migrations/index.ts';
import { validate } from '../lib/validate.ts';
import { fixturePairs } from './helpers.ts';

const cases = fixturePairs();

test('the fixture set is not empty', () => {
	assert.ok(cases.length > 0, 'no fixtures found');
});

for (const { name, input, expectedPath, context } of cases) {
	// A fixture with no expected output is one the tool must refuse to migrate.
	if (!existsSync(expectedPath)) {
		test(`${name}: is rejected as unparseable rather than silently mangled`, () => {
			assert.throws(
				() => migrate(input, undefined, context),
				WorkflowParseError,
			);
		});
		continue;
	}

	const expected = readFileSync(expectedPath, 'utf8');

	test(`${name}: migrates to the expected output`, () => {
		assert.equal(migrate(input, undefined, context).source, expected);
	});

	test(`${name}: is idempotent on a second run`, () => {
		const second = migrate(expected, undefined, context);
		assert.equal(second.source, expected);
		assert.equal(second.changed, false);
	});

	test(`${name}: output parses and keeps the caller jobs intact`, () => {
		const before = parseWorkflow(input);
		const after = parseWorkflow(expected);
		assert.deepEqual(
			callerJobs(after).map((job) => job.name),
			callerJobs(before).map((job) => job.name),
		);
		for (const { node } of callerJobs(after)) {
			assert.ok(String(node.get('uses')).includes('product-os/flowzone'));
		}
	});

	test(`${name}: passes the same validation gate the tool applies`, () => {
		const result = migrate(input, MIGRATIONS, context);
		assert.doesNotThrow(() => validate(input, result, MIGRATIONS, context));
	});

	test(`${name}: reformats nothing, it only adds and removes whole lines`, () => {
		const survivable = new Set([
			...input.split('\n'),
			...insertedLines(input, context),
		]);
		for (const line of expected.split('\n')) {
			assert.ok(
				survivable.has(line),
				`output line was neither present in the input nor inserted by a unit: ${JSON.stringify(line)}`,
			);
		}
	});
}

/** Every line of text the units insert, taken from the report the runner already builds. */
function insertedLines(input: string, context: Context) {
	return migrate(input, MIGRATIONS, context)
		.report.filter((entry) => entry.status !== 'blocked')
		.flatMap((entry) => entry.edits ?? [])
		.flatMap((edit) => edit.text.split('\n'));
}

test('the fixtures cover the structural variants that broke naive transforms', () => {
	const all = cases.map((entry) => entry.input);
	const covers = (predicate: (src: string) => boolean) => all.some(predicate);

	assert.ok(
		covers((src) => /branches:\s*\n\s+- /.test(src)),
		'a block-sequence branches list',
	);
	assert.ok(
		covers((src) => src.includes('branches: [')),
		'a flow-sequence branches list',
	);
	assert.ok(
		covers((src) => src.includes('pull_request_target')),
		'a caller still on pull_request_target',
	);
	assert.ok(
		covers((src) => !src.includes('pull_request_target')),
		'a caller already off pull_request_target',
	);
	assert.ok(
		covers((src) => src.includes('restrict_custom_actions')),
		'a caller setting the deprecated input',
	);
	assert.ok(
		covers((src) => /^permissions:/m.test(src)),
		'a caller pinning a permissions block',
	);
	assert.ok(
		covers((src) => /^\s{4}\w+: none$/m.test(src)),
		'a permissions block indented four spaces',
	);
	assert.ok(
		covers((src) => /^ {4}with:/m.test(src)),
		'a caller passing inputs',
	);
	assert.ok(
		covers((src) => /^ {2}ci:$/m.test(src)),
		'a caller job that is not named flowzone',
	);
	assert.ok(
		covers((src) => /if: \|\n\s+\(\n/.test(src)) &&
			covers((src) => /if: \|\n\s+\(github/.test(src)),
		'both the block-scalar and the reflowed spelling of the routing condition',
	);
	assert.ok(
		cases.some((entry) => !existsSync(entry.expectedPath)),
		'a workflow the tool must refuse to migrate',
	);
});
