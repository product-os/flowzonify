import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGACY_CALLER, repo } from '../helpers.ts';

import {
	commitMessage,
	footer,
	parseList,
	pullRequestBody,
	repoType,
	statusOf,
} from '../../action/body.ts';
import type { MigrateReport } from '../../action/body.ts';
import { MIGRATIONS } from '../../lib/migrations/index.ts';
import type { ReportEntry } from '../../lib/migrate.ts';

test('reads the repository type as real repositories spell it', () => {
	assert.equal(
		repoType("---\ntype: 'yocto-based OS image'\n"),
		'yocto-based-os-image',
	);
	assert.equal(repoType('type: yocto layer\n'), 'yocto-layer');
	assert.equal(repoType("type: 'node'\n"), 'node');
});

test('reads the repository type as flowzonify itself spells it', () => {
	// REPO_TYPES in lib/run.ts uses balena-versionist's directory names, which are
	// hyphenated, while the repo.yml files in the wild use spaces. Both have to land
	// on the same normalised value or the footer is chosen from the wrong convention.
	assert.equal(
		repoType('type: yocto-based-OS-image\n'),
		'yocto-based-os-image',
	);
	assert.equal(repoType('type: yocto-layer\n'), 'yocto-layer');
});

test('reports no type when there is no repo.yml', () => {
	assert.equal(repoType(undefined), undefined);
});

test('reports no type when repo.yml declares none', () => {
	assert.equal(repoType('reviewers: 1\n'), undefined);
});

test('ignores a type key that is not at the top level', () => {
	// A nested `type:` belongs to whatever contains it. Matching it would pick a
	// footer convention from an upstream declaration or a reviewer rule.
	assert.equal(
		repoType('upstream:\n  - repo: x\n    type: docker\n'),
		undefined,
	);
});

test('ignores a trailing comment on the type', () => {
	assert.equal(repoType('type: node # inferred\n'), 'node');
});

const SUBJECT = 'Migrate the flowzone caller workflow';

const DEVICE_TYPE = "type: 'yocto-based OS image'\n";

test('a device-type repository gets a changelog entry, not a change type', () => {
	// balena-raspberrypi declares `type: 'yocto-based OS image'` and its commits carry
	// Changelog-entry exclusively; a Change-type footer is the wrong convention there.
	const line = footer({ repoYml: DEVICE_TYPE, subject: SUBJECT });
	assert.equal(line, `Changelog-entry: ${SUBJECT}`);
});

test('a yocto layer repository gets a change type, not a changelog entry', () => {
	// meta-balena declares `type: yocto layer` and its commits carry Change-type, so
	// the split is narrower than "anything yocto".
	const line = footer({ repoYml: 'type: yocto layer\n', subject: SUBJECT });
	assert.equal(line, 'Change-type: patch');
});

test('a repository with no repo.yml gets a change type', () => {
	// versionist falls back to the node strategy, which reads Change-type.
	assert.equal(footer({ subject: SUBJECT }), 'Change-type: patch');
});

test('a caller with versioning disabled gets no change type', () => {
	// Nothing reads the footer, so writing one says something untrue about the commit.
	assert.equal(
		footer({ subject: SUBJECT, versioningDisabled: true }),
		undefined,
	);
});

test('a caller with versioning disabled gets no changelog entry either', () => {
	// Both footers are versionist's, so disabling versioning silences both.
	assert.equal(
		footer({
			repoYml: DEVICE_TYPE,
			subject: SUBJECT,
			versioningDisabled: true,
		}),
		undefined,
	);
});

test('an unknown versioning state still gets a footer', () => {
	// The safe direction: a footer versionist never reads is inert, while a missing one
	// fails the caller's own versioning job.
	assert.equal(
		footer({ subject: SUBJECT, versioningDisabled: undefined }),
		'Change-type: patch',
	);
});

test('reads the descriptions out of the CLI listing', () => {
	const listed = parseList(
		'remove-pull-request-target\n' +
			'  Remove the pull_request_target trigger.\n' +
			'\n' +
			'add-push-trigger\n' +
			'  Add the push trigger on the default branches.\n' +
			'\n',
	);
	assert.deepEqual(listed, {
		'remove-pull-request-target': 'Remove the pull_request_target trigger.',
		'add-push-trigger': 'Add the push trigger on the default branches.',
	});
});

test('reads a description for every registered migration', () => {
	// The listing format is the action's only route to the descriptions the README
	// says are "shown by --list and in pull request bodies". Parsing the real output
	// rather than a sample means the format cannot drift away from the parser.
	const cli = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('../../bin/flowzonify.ts', import.meta.url)),
			'--list',
		],
		{ encoding: 'utf8' },
	);
	assert.equal(cli.status, 0, cli.stderr);

	const listed = parseList(cli.stdout);
	for (const unit of MIGRATIONS) {
		assert.equal(
			listed[unit.id],
			unit.description,
			`\`${unit.id}\` did not survive the round trip through --list`,
		);
	}
});

/** A `--json` report in which the named migrations reached the given statuses. */
function report(
	statuses: Record<string, 'applied' | 'advisory' | 'skip'>,
	versioningDisabled = false,
) {
	return {
		status: 'ok' as const,
		files: [
			{
				path: '.github/workflows/flowzone.yml',
				status: 'ok' as const,
				changed: true,
				report: Object.entries(statuses).map(([id, status]) => ({
					id,
					status,
				})),
				versioningDisabled,
			},
		],
	};
}

const DESCRIPTIONS = {
	'remove-pull-request-target': 'Remove the pull_request_target trigger.',
	'add-push-trigger': 'Add the push trigger on the default branches.',
	'remove-fork-routing-if': 'Remove the fork routing condition.',
};

test('the commit message lists what each applied migration did', () => {
	const message = commitMessage({
		report: report({ 'add-push-trigger': 'applied' }),
		descriptions: DESCRIPTIONS,
		subject: SUBJECT,
	});
	assert.equal(
		message,
		`${SUBJECT}\n\n` +
			'- Add the push trigger on the default branches.\n\n' +
			'Change-type: patch\n',
	);
});

test('the commit message counts an advisory migration as applied', () => {
	// An advisory verdict still splices its edits, so leaving it out would under-report
	// what the commit actually changed.
	const message = commitMessage({
		report: report({ 'add-push-trigger': 'advisory' }),
		descriptions: DESCRIPTIONS,
		subject: SUBJECT,
	});
	assert.match(message, /- Add the push trigger on the default branches\./);
});

test('the commit message omits a migration that had nothing to do', () => {
	const message = commitMessage({
		report: report({
			'add-push-trigger': 'applied',
			'remove-fork-routing-if': 'skip',
		}),
		descriptions: DESCRIPTIONS,
		subject: SUBJECT,
	});
	assert.doesNotMatch(message, /fork routing/);
});

test('the commit message ends after the list when versioning is disabled', () => {
	const message = commitMessage({
		report: report({ 'add-push-trigger': 'applied' }, true),
		descriptions: DESCRIPTIONS,
		subject: SUBJECT,
	});
	assert.equal(
		message,
		`${SUBJECT}\n\n- Add the push trigger on the default branches.\n`,
	);
});

test('the commit message names the migration when its description is missing', () => {
	// Better a bare id than the word "undefined" in a commit message somebody reads.
	const message = commitMessage({
		report: report({ 'a-migration-list-did-not-mention': 'applied' }),
		descriptions: DESCRIPTIONS,
		subject: SUBJECT,
	});
	assert.match(message, /- a-migration-list-did-not-mention\n/);
});

test('the commit message is byte-stable for the same report', () => {
	// create-pull-request rewrites the branch when the commit differs, so anything
	// unstable here force-pushes and notifies on every run.
	const options = {
		report: report({ 'add-push-trigger': 'applied' }),
		descriptions: DESCRIPTIONS,
		subject: SUBJECT,
	};
	assert.equal(commitMessage(options), commitMessage(options));
});

/** A `--json` report carrying notes and a lint state, for the pull request body. */
function noted(
	entries: ReportEntry[],
	lintChecked?: 'checked' | 'unavailable' | 'skipped',
) {
	return {
		status: 'ok' as const,
		files: [
			{
				path: '.github/workflows/flowzone.yml',
				status: 'ok' as const,
				changed: true,
				report: entries,
				lintChecked,
			},
		],
	};
}

test('the pull request body lists what each applied migration did', () => {
	const text = pullRequestBody({
		report: noted([{ id: 'add-push-trigger', status: 'applied' }], 'checked'),
		descriptions: DESCRIPTIONS,
	});
	assert.match(text, /- Add the push trigger on the default branches\./);
});

test('the pull request body surfaces an advisory note as a follow-up', () => {
	// An advisory verdict means the migration applied but something needs saying, and
	// the pull request is where somebody will read it.
	const text = pullRequestBody({
		report: noted(
			[
				{
					id: 'migrate-custom-runs-on',
					status: 'advisory',
					note: 'check the matrix by hand',
				},
			],
			'checked',
		),
		descriptions: DESCRIPTIONS,
	});
	assert.match(text, /check the matrix by hand/);
});

test('the pull request body says when actionlint could not run', () => {
	// The CLI says so rather than quietly downgrading its checks; a reviewer deciding
	// whether to trust this diff needs the same caveat.
	const text = pullRequestBody({
		report: noted(
			[{ id: 'add-push-trigger', status: 'applied' }],
			'unavailable',
		),
		descriptions: DESCRIPTIONS,
	});
	assert.match(text, /actionlint/);
});

test('the pull request body omits the caveat when actionlint did run', () => {
	const text = pullRequestBody({
		report: noted([{ id: 'add-push-trigger', status: 'applied' }], 'checked'),
		descriptions: DESCRIPTIONS,
	});
	assert.doesNotMatch(text, /actionlint/);
});

test('the pull request body is byte-stable for the same report', () => {
	const options = {
		report: noted([{ id: 'add-push-trigger', status: 'applied' }], 'checked'),
		descriptions: DESCRIPTIONS,
	};
	assert.equal(pullRequestBody(options), pullRequestBody(options));
});

/** Run `action/body.ts` as the action does, and return what it wrote. */
function runBody(files: Record<string, string>, env: Record<string, string>) {
	const dir = repo(files);
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL('../../action/body.ts', import.meta.url))],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				FLOWZONIFY_REPORT: join(dir, 'report.json'),
				FLOWZONIFY_LIST: join(dir, 'list.txt'),
				FLOWZONIFY_REPO_YML: join(dir, 'repo.yml'),
				FLOWZONIFY_BODY_PATH: join(dir, 'body.md'),
				GITHUB_OUTPUT: join(dir, 'output.txt'),
				FLOWZONIFY_SUBJECT: SUBJECT,
				...env,
			},
		},
	);
	return {
		result,
		outputs: readOutputs(join(dir, 'output.txt')),
		body: existsSync(join(dir, 'body.md'))
			? readFileSync(join(dir, 'body.md'), 'utf8')
			: undefined,
	};
}

/** Parse a `$GITHUB_OUTPUT` file, both the plain and the heredoc form. */
function readOutputs(path: string): Record<string, string> {
	const outputs: Record<string, string> = {};
	const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];

	for (let index = 0; index < lines.length; index++) {
		const heredoc = lines[index].match(/^([\w-]+)<<(.+)$/);
		if (heredoc != null) {
			const end = lines.indexOf(heredoc[2], index + 1);
			outputs[heredoc[1]] = lines.slice(index + 1, end).join('\n');
			index = end;
			continue;
		}
		const plain = lines[index].match(/^([\w-]+)=(.*)$/);
		if (plain != null) {
			outputs[plain[1]] = plain[2];
		}
	}

	return outputs;
}

const MIGRATED_REPORT = JSON.stringify({
	status: 'ok',
	files: [
		{
			path: '.github/workflows/flowzone.yml',
			status: 'ok',
			changed: true,
			report: [{ id: 'add-push-trigger', status: 'applied' }],
			versioningDisabled: false,
			lintChecked: 'checked',
		},
	],
});

const LIST =
	'add-push-trigger\n  Add the push trigger on the default branches.\n\n';

test('writes the body file and the commit message for a migrated workflow', () => {
	const { result, outputs, body } = runBody(
		{ 'report.json': MIGRATED_REPORT, 'list.txt': LIST },
		{},
	);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(outputs.status, 'migrated');
	assert.match(body ?? '', /Add the push trigger on the default branches\./);
	assert.equal(
		outputs['commit-message'],
		`${SUBJECT}\n\n- Add the push trigger on the default branches.\n\nChange-type: patch\n`,
	);
	assert.equal(outputs.title, SUBJECT);
});

test('reports an unchanged workflow without writing a body', () => {
	// Nothing to open a pull request about, so create-pull-request never runs.
	const { outputs } = runBody(
		{
			'report.json': JSON.stringify({
				status: 'ok',
				files: [
					{
						path: '.github/workflows/flowzone.yml',
						status: 'ok',
						changed: false,
						report: [{ id: 'add-push-trigger', status: 'skip' }],
					},
				],
			}),
			'list.txt': LIST,
		},
		{},
	);
	assert.equal(outputs.status, 'unchanged');
});

test('reports a blocked workflow', () => {
	const { outputs } = runBody(
		{
			'report.json': JSON.stringify({
				status: 'blocked',
				files: [
					{
						path: '.github/workflows/flowzone.yml',
						status: 'blocked',
						changed: false,
						report: [
							{
								id: 'remove-fork-routing-if',
								status: 'blocked',
								note: 'the condition was customised',
							},
						],
					},
				],
			}),
			'list.txt': LIST,
		},
		{},
	);
	assert.equal(outputs.status, 'blocked');
});

test('takes the footer convention from the checked-out repo.yml', () => {
	const { outputs } = runBody(
		{
			'report.json': MIGRATED_REPORT,
			'list.txt': LIST,
			'repo.yml': "type: 'yocto-based OS image'\n",
		},
		{},
	);
	assert.match(outputs['commit-message'], /^Changelog-entry: /m);
	assert.doesNotMatch(outputs['commit-message'], /^Change-type: /m);
});

test('falls back to a change type when the repository has no repo.yml', () => {
	const { outputs } = runBody(
		{ 'report.json': MIGRATED_REPORT, 'list.txt': LIST },
		{},
	);
	assert.match(outputs['commit-message'], /^Change-type: patch$/m);
});

test('refuses a report containing an error rather than calling it unchanged', () => {
	// The action checks the CLI's exit code first, so this should be unreachable. If it
	// ever is reached, failing loudly beats reporting "up to date" for a workflow that
	// could not be read.
	const { result } = runBody(
		{
			'report.json': JSON.stringify({
				status: 'error',
				files: [
					{
						path: '.github/workflows/flowzone.yml',
						status: 'error',
						changed: false,
						report: [],
						error: 'not valid YAML: 1 problem',
					},
				],
			}),
			'list.txt': LIST,
		},
		{},
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /not valid YAML/);
});

test('the real CLI report produces a usable commit message', () => {
	// Every test above feeds body.ts a hand-written report. This one runs the CLI for
	// real, on a real caller workflow, so the two cannot disagree about the shape.
	const dir = repo({ '.github/workflows/flowzone.yml': LEGACY_CALLER });

	const cli = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('../../bin/flowzonify.ts', import.meta.url)),
			'--json',
			'--',
			join(dir, '.github/workflows/flowzone.yml'),
		],
		{ encoding: 'utf8' },
	);
	assert.equal(cli.status, 0, cli.stderr);

	const list = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('../../bin/flowzonify.ts', import.meta.url)),
			'--list',
		],
		{ encoding: 'utf8' },
	);

	const parsed = JSON.parse(cli.stdout) as MigrateReport;
	assert.equal(statusOf(parsed), 'migrated');

	const message = commitMessage({
		report: parsed,
		descriptions: parseList(list.stdout),
		subject: SUBJECT,
	});

	// The legacy caller needs the pull_request_target removal and the push trigger, so
	// their real descriptions have to reach the message.
	assert.match(message, /^Migrate the flowzone caller workflow$/m);
	assert.match(message, /^- Remove the pull_request_target trigger/m);
	assert.match(message, /^- Add the push trigger/m);
	assert.match(message, /^Change-type: patch$/m);
	assert.doesNotMatch(message, /undefined/);
});

test('a real caller with versioning disabled gets no footer', () => {
	// The other end-to-end test covers the ordinary path. This one proves the CLI
	// actually reports `versioningDisabled` and that body.ts reads the same field.
	const dir = repo({
		'.github/workflows/flowzone.yml': LEGACY_CALLER.replace(
			'    secrets: inherit\n',
			'    with:\n      disable_versioning: true\n    secrets: inherit\n',
		),
	});

	const cli = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('../../bin/flowzonify.ts', import.meta.url)),
			'--json',
			'--',
			join(dir, '.github/workflows/flowzone.yml'),
		],
		{ encoding: 'utf8' },
	);
	assert.equal(cli.status, 0, cli.stderr);

	const message = commitMessage({
		report: JSON.parse(cli.stdout) as MigrateReport,
		descriptions: {},
		subject: SUBJECT,
	});

	assert.doesNotMatch(message, /Change-type:/);
	assert.doesNotMatch(message, /Changelog-entry:/);
});
