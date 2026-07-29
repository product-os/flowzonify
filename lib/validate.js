import { isMap } from 'yaml';

import { callerJobs } from './context.js';
import { illegalFilters } from './events.js';
import { migrate, parseWorkflow } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';

export class ValidationError extends Error {
	constructor(message) {
		super(message);
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
export function validate(before, result, units = MIGRATIONS, context = {}) {
	const source = parseWorkflow(before);
	const migrated = parseWorkflow(result.source);

	assertTriggersPreserved(source, migrated, result.report, units);
	assertCallersIntact(source, migrated);
	assertFiltersLegal(source, migrated);
	assertPostconditions(migrated, result.report, units);
	assertIdempotent(result.source, units, context);
}

/**
 * A migration may only drop a trigger it declared it would; every other trigger
 * must survive. The permitted set comes from the migrations that actually ran, so
 * the invariant stays universal and stays tight under `--only`.
 */
function assertTriggersPreserved(before, after, report, units) {
	const original = before.get('on');
	const migrated = after.get('on');

	if (!isMap(original)) {
		return;
	}
	if (!isMap(migrated)) {
		throw new ValidationError('migrated workflow no longer has an `on:` mapping');
	}

	const removable = new Set(
		report
			.filter((entry) => entry.status === 'applied' || entry.status === 'advisory')
			.flatMap((entry) => units.find((unit) => unit.id === entry.id)?.removesTriggers ?? []),
	);

	for (const pair of original.items) {
		const trigger = String(pair.key);
		if (!removable.has(trigger) && !migrated.has(trigger)) {
			throw new ValidationError(`migrated workflow dropped the \`${trigger}\` trigger`);
		}
	}
}

/**
 * A migration may not leave a filter where the event does not allow it. Compared
 * against the input rather than asserted outright: a workflow that already had
 * one is not this migration's fault, and blocking it would strand the repository
 * for a problem nobody here caused.
 */
function assertFiltersLegal(before, after) {
	const existing = new Set(illegalFilters(before));
	const introduced = illegalFilters(after).filter((filter) => !existing.has(filter));

	if (introduced.length > 0) {
		throw new ValidationError(
			`migrated workflow puts ${introduced.join(', ')} where the event does not allow it`,
		);
	}
}

function assertCallersIntact(before, after) {
	const original = callerJobs(before);
	const migrated = callerJobs(after);

	const expected = original.map((job) => job.name).sort();
	const actual = migrated.map((job) => job.name).sort();
	if (expected.join(',') !== actual.join(',')) {
		throw new ValidationError(
			`migrated workflow changed the set of flowzone caller jobs: expected [${expected}], got [${actual}]`,
		);
	}

	for (const job of migrated) {
		const previous = original.find((entry) => entry.name === job.name);
		if (String(previous.node.get('uses')) !== String(job.node.get('uses'))) {
			throw new ValidationError(
				`migrated workflow changed the \`uses\` of job \`${job.name}\`, which the migration must never do`,
			);
		}
	}
}

function assertPostconditions(after, report, units) {
	for (const entry of report) {
		if (entry.status !== 'applied' && entry.status !== 'advisory') {
			continue;
		}
		const unit = units.find((candidate) => candidate.id === entry.id);
		const failure = unit?.verify?.(after);
		if (failure) {
			throw new ValidationError(`${entry.id} did not hold: ${failure}`);
		}
	}
}

function assertIdempotent(source, units, context) {
	if (migrate(source, units, context).changed) {
		throw new ValidationError('migrated workflow would change again on a second run');
	}
}
