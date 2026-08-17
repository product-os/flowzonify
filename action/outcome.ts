/**
 * What the action reports once create-pull-request has run: the outputs, the step
 * summary, and whether any of it should fail the job.
 *
 * Dependency-free for the same reason as `body.ts` — this runs from
 * `$GITHUB_ACTION_PATH`, which the runner checks out without installing anything.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { MigrateReport } from './body.ts';

/** How loudly an outcome should be reported. Never changes what is reported. */
export type Mode = 'fail' | 'warn' | 'skip';

const MODES: Mode[] = ['fail', 'warn', 'skip'];

/** What create-pull-request did, as its step outcome and outputs describe it. */
export interface CprResult {
	outcome: 'success' | 'failure' | 'skipped';
	/** `created`, `updated`, `closed` or `none`. */
	operation?: string;
	prNumber?: string;
	url?: string;
	verified?: string;
}

export interface OutcomeInput {
	status: 'migrated' | 'unchanged' | 'blocked' | 'skipped';
	cpr: CprResult;
	onBlocked: Mode;
	onFailure: Mode;
	/** The migrations that refused, for the message a human will read. */
	blocked?: Array<{ id: string; note?: string }>;
}

export interface Decision {
	failed: boolean;
	messages: string[];
	summary: string;
	outputs: Record<string, string>;
}

/**
 * `status` always tells the truth about what happened. The modes decide the exit code
 * and whether anything is said out loud, which is a separate question from what the
 * outcome was — a caller reading the output should not have to guess whether `skipped`
 * means "nothing to do" or "something went wrong quietly".
 */
export function decide({
	status,
	cpr,
	onBlocked,
	onFailure,
	blocked = [],
}: OutcomeInput): Decision {
	const refused = cpr.outcome === 'failure';
	const reported = refused ? 'refused' : status;

	const problem = refused
		? { mode: onFailure, message: refusalMessage() }
		: status === 'blocked'
			? { mode: onBlocked, message: blockedMessage(blocked) }
			: undefined;

	return {
		failed: problem?.mode === 'fail',
		messages:
			problem == null || problem.mode === 'skip' ? [] : [problem.message],
		summary: summarise(reported, cpr, problem?.message),
		outputs: {
			status: reported,
			'pull-request-number': cpr.prNumber ?? '',
			'pull-request-url': cpr.url ?? '',
			'pull-request-operation': cpr.operation ?? '',
			'pull-request-commits-verified': cpr.verified ?? '',
		},
	};
}

/**
 * Nothing available to the action reports whether a token holds the `workflows`
 * permission, and create-pull-request's own error reaches us as a boolean step outcome.
 * So this says what it suspects and points at the step that actually knows.
 */
function refusalMessage(): string {
	return (
		'create-pull-request could not update the branch. The likeliest cause is a token ' +
		'without the `workflows` permission, which is the only one that can change a file ' +
		'under .github/workflows/. See the create-pull-request step log for the real error.'
	);
}

function blockedMessage(blocked: Array<{ id: string; note?: string }>): string {
	const notes = blocked.map(
		(entry) => `  ${entry.id}: ${entry.note ?? 'no reason given'}`,
	);
	return [
		'This workflow needs to be migrated by hand; nothing was changed.',
		...notes,
	].join('\n');
}

function summarise(status: string, cpr: CprResult, problem?: string): string {
	const lines = [`### flowzonify: ${status}`];

	if (cpr.url != null && cpr.url !== '') {
		lines.push('', `${cpr.operation ?? 'pull request'}: ${cpr.url}`);
	}
	if (problem != null) {
		lines.push('', problem);
	}

	return `${lines.join('\n')}\n`;
}

function mode(name: string): Mode {
	const value = process.env[name] ?? 'warn';
	if (!MODES.includes(value as Mode)) {
		throw new Error(
			`${name} must be one of ${MODES.join(', ')}, not "${value}"`,
		);
	}
	return value as Mode;
}

/** The migrations that refused, read back out of the report the CLI wrote. */
function blockedUnits(path?: string): Array<{ id: string; note?: string }> {
	if (path == null || path === '') {
		return [];
	}

	const report = JSON.parse(readFileSync(path, 'utf8')) as MigrateReport;
	return report.files.flatMap((file) =>
		file.report.filter((entry) => entry.status === 'blocked'),
	);
}

function main(): void {
	const status = (process.env.FLOWZONIFY_STATUS ??
		'skipped') as OutcomeInput['status'];

	const decision = decide({
		status,
		cpr: {
			outcome: (process.env.FLOWZONIFY_CPR_OUTCOME ??
				'skipped') as CprResult['outcome'],
			operation: process.env.FLOWZONIFY_CPR_OPERATION,
			prNumber: process.env.FLOWZONIFY_PR_NUMBER,
			url: process.env.FLOWZONIFY_PR_URL,
			verified: process.env.FLOWZONIFY_COMMITS_VERIFIED,
		},
		onBlocked: mode('FLOWZONIFY_ON_BLOCKED'),
		onFailure: mode('FLOWZONIFY_ON_FAILURE'),
		blocked:
			status === 'blocked' ? blockedUnits(process.env.FLOWZONIFY_REPORT) : [],
	});

	// Workflow commands, so these land as job annotations rather than only in the log.
	// `%0A` is how a multi-line annotation is encoded.
	const level = decision.failed ? 'error' : 'warning';
	for (const message of decision.messages) {
		console.log(`::${level}::${message.replace(/\n/g, '%0A')}`);
	}

	appendFileSync(
		requireEnv('GITHUB_OUTPUT'),
		`${Object.entries(decision.outputs)
			.map(([name, value]) => `${name}=${value}`)
			.join('\n')}\n`,
		'utf8',
	);

	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary != null && summary !== '') {
		appendFileSync(summary, decision.summary, 'utf8');
	}

	if (decision.failed) {
		process.exitCode = 1;
	}
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value == null || value === '') {
		throw new Error(`${name} is not set`);
	}
	return value;
}

// Only when run as the action's step, so the tests can import `decide` above.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
