import { isMap } from 'yaml';
import type { Document } from 'yaml';

import { callerJobs } from './context.ts';
import { illegalFilters } from './events.ts';
import { migrate, parseWorkflow } from './migrate.ts';
import type {
	Context,
	MigrateResult,
	Migration,
	ReportEntry,
} from './migrate.ts';
import { MIGRATIONS } from './migrations/index.ts';

/**
 * Everything wrong with one migrated workflow. Each check reports what it found
 * rather than throwing, so one broken invariant does not hide the next: a migration
 * that dropped a trigger *and* renamed a caller job is two bugs, and finding them
 * one run at a time makes fixing it a round trip each time.
 *
 * A single problem reads as itself, so the common case stays a plain sentence and
 * the sweep's one-line detail keeps saying something specific.
 */
export class ValidationError extends Error {
	constructor(problems: string[]) {
		super(
			problems.length === 1
				? problems[0]
				: [
						`${problems.length} problems:`,
						...problems.map((problem) => `  ${problem}`),
					].join('\n'),
		);
		this.name = 'ValidationError';
	}
}

/**
 * The gate between a transformed workflow and the disk. A failure here means the
 * caller is reported and its file left alone — never written half-migrated.
 *
 * Only invariants that hold for *any* subset of migrations live here; a check
 * that is true because a particular migration ran belongs on that migration, as
 * a `verify` hook. That keeps `--only` runs honest instead of failing a gate
 * that assumed the whole registry ran.
 */
export function validate(
	before: string,
	result: MigrateResult,
	units: Migration[] = MIGRATIONS,
	context: Context = {},
): void {
	const source = parseWorkflow(before);
	const migrated = parseWorkflow(result.source);

	const problems = [
		...triggerProblems(source, migrated, result.report, units),
		...callerProblems(source, migrated),
		...filterProblems(source, migrated),
		...postconditionProblems(migrated, result.report, units),
		...idempotencyProblems(result.source, units, context),
	];

	if (problems.length > 0) {
		throw new ValidationError(problems);
	}
}

/**
 * A migration may only drop a trigger it declared it would; every other trigger
 * must survive. The permitted set comes from the migrations that actually ran, so
 * the invariant stays universal and stays tight under `--only`.
 */
function triggerProblems(
	before: Document.Parsed,
	after: Document.Parsed,
	report: ReportEntry[],
	units: Migration[],
): string[] {
	const original = before.get('on');
	const migrated = after.get('on');

	if (!isMap(original)) {
		return [];
	}
	// With no `on:` mapping left there is no point naming each trigger separately;
	// the whole block going missing is the one thing to report.
	if (!isMap(migrated)) {
		return ['migrated workflow no longer has an `on:` mapping'];
	}

	const removable = new Set(
		report
			.filter(
				(entry) => entry.status === 'applied' || entry.status === 'advisory',
			)
			.flatMap(
				(entry) =>
					units.find((unit) => unit.id === entry.id)?.removesTriggers ?? [],
			),
	);

	return original.items
		.map((pair) => String(pair.key))
		.filter((trigger) => !removable.has(trigger) && !migrated.has(trigger))
		.map((trigger) => `migrated workflow dropped the \`${trigger}\` trigger`);
}

function callerProblems(
	before: Document.Parsed,
	after: Document.Parsed,
): string[] {
	const original = callerJobs(before);
	const migrated = callerJobs(after);

	const expected = original.map((job) => job.name).sort();
	const actual = migrated.map((job) => job.name).sort();
	if (expected.join(',') !== actual.join(',')) {
		// The `uses` check below matches jobs by name, so a changed set would report
		// every renamed job a second time. This one problem is enough to stop here.
		return [
			`migrated workflow changed the set of flowzone caller jobs: expected [${expected}], got [${actual}]`,
		];
	}

	const previousUses = new Map(
		original.map((job) => [job.name, String(job.node.get('uses'))]),
	);
	return migrated
		.filter(
			(job) => previousUses.get(job.name) !== String(job.node.get('uses')),
		)
		.map(
			(job) =>
				`migrated workflow changed the \`uses\` of job \`${job.name}\`, which the migration must never do`,
		);
}

/**
 * A migration may not leave a filter where the event does not allow it. Compared
 * against the input rather than asserted outright: a workflow that already had
 * one is not this migration's fault, and blocking it would strand the repository
 * for a problem nobody here caused.
 */
function filterProblems(
	before: Document.Parsed,
	after: Document.Parsed,
): string[] {
	const existing = new Set(illegalFilters(before));
	const introduced = illegalFilters(after).filter(
		(filter) => !existing.has(filter),
	);

	return introduced.length > 0
		? [
				`migrated workflow puts ${introduced.join(', ')} where the event does not allow it`,
			]
		: [];
}

function postconditionProblems(
	after: Document.Parsed,
	report: ReportEntry[],
	units: Migration[],
): string[] {
	return report
		.filter(
			(entry) => entry.status === 'applied' || entry.status === 'advisory',
		)
		.flatMap((entry) => {
			const unit = units.find((candidate) => candidate.id === entry.id);
			const failure = unit?.verify?.(after);
			return failure ? [`${entry.id} did not hold: ${failure}`] : [];
		});
}

function idempotencyProblems(
	source: string,
	units: Migration[],
	context: Context,
): string[] {
	return migrate(source, units, context).changed
		? ['migrated workflow would change again on a second run']
		: [];
}
