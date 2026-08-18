import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { repo } from '../helpers.ts';

const root = new URL('../../', import.meta.url);

const action = parse(
	readFileSync(fileURLToPath(new URL('action.yml', root)), 'utf8'),
) as {
	inputs: Record<string, { description?: string; default?: string }>;
	outputs: Record<string, { description?: string }>;
	runs: { using: string; steps: Array<Record<string, unknown>> };
};

const README = readFileSync(fileURLToPath(new URL('README.md', root)), 'utf8');

const SECTION =
	README.split('\n## GitHub Action\n')[1]?.split('\n## ')[0] ?? '';

const documented = SECTION.split('\n')
	.map((line) => line.match(/^\| `([a-z-]+)` \|/)?.[1])
	.filter((name) => name != null);

test('the GitHub Action section of the README was found', () => {
	assert.ok(
		documented.length > 0,
		'no input table rows found — has the README been restructured?',
	);
});

test('the README documents every input the action declares', () => {
	for (const name of Object.keys(action.inputs)) {
		assert.ok(
			documented.includes(name),
			`\`${name}\` is an action input but is missing from the README`,
		);
	}
});

test('the README does not document an input the action has dropped', () => {
	for (const name of documented) {
		assert.ok(
			name in action.inputs,
			`\`${name}\` is in the README input table but is not an action input`,
		);
	}
});

test('every input and output carries a description', () => {
	// The description is the whole interface as far as anyone reading the Marketplace
	// entry is concerned.
	for (const [name, input] of Object.entries(action.inputs)) {
		assert.ok(input.description, `input \`${name}\` has no description`);
	}
	for (const [name, output] of Object.entries(action.outputs)) {
		assert.ok(output.description, `output \`${name}\` has no description`);
	}
});

test('every upstream action is pinned to a full commit sha', () => {
	// Flowzone's convention, and the only pin a tag cannot be moved out from under.
	for (const step of action.runs.steps) {
		const uses = step.uses;
		if (typeof uses !== 'string') {
			continue;
		}
		assert.match(
			uses,
			/@[0-9a-f]{40}$/,
			`${uses} is not pinned to a full commit sha`,
		);
	}
});

test('every step that runs a script names its shell', () => {
	// A composite action has no default shell; omitting it is a run-time error rather
	// than a parse error, so nothing but a check like this catches it before CI.
	for (const step of action.runs.steps) {
		if (step.run != null) {
			assert.ok(
				step.shell,
				`step \`${step.name}\` runs a script with no shell`,
			);
		}
	}
});

/**
 * The environment the runner provides, so shellcheck does not read a reference to one
 * as a typo. Anything else a step uses has to come from its own `env:`.
 */
const RUNNER_ENV = [
	'GITHUB_ACTION_PATH',
	'GITHUB_OUTPUT',
	'GITHUB_REF',
	'GITHUB_REPOSITORY',
	'GITHUB_STEP_SUMMARY',
	'GITHUB_WORKSPACE',
	'RUNNER_TEMP',
];

test('the shell steps pass shellcheck', (t) => {
	// actionlint checks workflows, not action metadata, so it never sees this file and
	// never shellchecks the scripts in it. Without this they are unchecked entirely.
	if (spawnSync('shellcheck', ['--version']).status !== 0) {
		t.skip('shellcheck is not installed');
		return;
	}

	const dir = repo({}, 'flowzonify-shellcheck-');

	for (const [index, step] of action.runs.steps.entries()) {
		if (typeof step.run !== 'string') {
			continue;
		}

		// Declare what the runner and the step's own `env:` supply, so an undefined
		// variable is still reported but a supplied one is not a false positive.
		const supplied = [
			...RUNNER_ENV,
			...Object.keys((step.env as Record<string, unknown>) ?? {}),
			// Exported, both because that is what the runner does with them and because
			// shellcheck reads a plain unused assignment as a mistake of its own.
		].map((name) => `export ${name}=`);

		const path = join(dir, `step-${index}.sh`);
		writeFileSync(
			path,
			// `bash -e {0}` is how the runner invokes a bash step.
			['#!/usr/bin/env bash', 'set -e', ...supplied, step.run].join('\n'),
			'utf8',
		);

		const checked = spawnSync('shellcheck', [path], { encoding: 'utf8' });
		assert.equal(
			checked.status,
			0,
			`step \`${String(step.name)}\`:\n${checked.stdout}`,
		);
	}
});

test('the CLI cannot drift from the action that reports on it', () => {
	// The action turns the CLI's report into a commit message, so the two have to be
	// the same code. Running the checkout beside it is the only way to guarantee that:
	// a published version fetched by number is whatever was last released, which for a
	// branch or commit ref is older than the source at that ref.
	assert.ok(
		!('version' in action.inputs),
		'a `version` input lets the CLI and the action drift apart',
	);

	const migrate = action.runs.steps.find((step) => step.id === 'migrate');
	assert.match(
		String(migrate?.run),
		/GITHUB_ACTION_PATH\}\/bin\/flowzonify\.ts/,
		'the migrate step no longer runs the CLI beside the action',
	);
	assert.doesNotMatch(
		String(migrate?.run),
		/npx/,
		'the migrate step fetches the CLI from the registry, which can be a different release',
	);
});

test('the github-script steps are syntactically valid JavaScript', () => {
	// Inline scripts are not linted or type-checked by anything, and a syntax error in one
	// would surface only when a caller runs the action. `node --check` parses without
	// running anything; wrapping the body in an async arrow, as github-script does, keeps
	// a top-level `return` or `await` legal.
	const dir = repo({}, 'flowzonify-script-');

	const scripts = action.runs.steps.filter(
		(step) =>
			typeof step.uses === 'string' && step.uses.includes('github-script'),
	);
	assert.notEqual(scripts.length, 0, 'no github-script steps found');

	for (const [index, step] of scripts.entries()) {
		const script = (step.with as { script?: unknown })?.script;
		assert.equal(
			typeof script,
			'string',
			`step \`${String(step.name)}\` has no script`,
		);

		const path = join(dir, `script-${index}.mjs`);
		writeFileSync(
			path,
			`void (async () => {\n${String(script)}\n})();\n`,
			'utf8',
		);

		const checked = spawnSync(process.execPath, ['--check', path], {
			encoding: 'utf8',
		});
		assert.equal(
			checked.status,
			0,
			`step \`${String(step.name)}\`:\n${checked.stderr}`,
		);
	}
});

test('the Node the action sets up is the Node the package requires', () => {
	// The runner sets no toolchain up for an action, so the action does it itself. Two
	// places naming a version is two places to forget, and only a check keeps them equal.
	const engines = JSON.parse(
		readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8'),
	) as { engines?: { node?: string } };

	const setup = action.runs.steps.find(
		(step) => typeof step.uses === 'string' && step.uses.includes('setup-node'),
	);
	assert.ok(setup, 'no setup-node step; the action runs the CLI with node');

	assert.equal(
		(setup.with as { 'node-version'?: string })['node-version'],
		engines.engines?.node,
		'setup-node asks for a different version than package.json requires',
	);
});
