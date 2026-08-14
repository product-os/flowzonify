import { parseDocument } from 'yaml';
import type { Document, YAMLParseError } from 'yaml';

import { applyEdits } from './source.ts';
import type { Edit } from './source.ts';
import { MIGRATIONS } from './migrations/index.ts';

/** The verdict one migration unit reaches on one workflow. */
type UnitStatus = 'skip' | 'applied' | 'advisory' | 'blocked';

export interface UnitResult {
	status: UnitStatus;
	note?: string;
	edits?: Edit[];
}

/**
 * The facts about the surrounding repository that migrations are allowed to
 * see. A unit that needs a fact it was not given must skip rather than guess.
 */
export interface Context {
	isNpmPackage?: boolean;
	customActions?: string[];
}

/** One migration unit: decides for itself whether it applies, emits source ranges. */
export interface Migration {
	id: string;
	description: string;
	/** Triggers this migration is allowed to drop, enforced by validate. */
	removesTriggers?: string[];
	apply(src: string, doc: Document.Parsed, context?: Context): UnitResult;
	/** What must be true of the migrated document once this unit has applied. */
	verify?(doc: Document.Parsed): string | undefined;
}

export interface ReportEntry extends UnitResult {
	id: string;
}

export type RunStatus = 'ok' | 'advisory' | 'blocked';

export interface MigrateResult {
	source: string;
	changed: boolean;
	status: RunStatus;
	report: ReportEntry[];
}

/**
 * Every problem the parser found, rather than just the first. A caller's broken
 * workflow is migrated by hand, and one error per attempt makes that a round trip
 * each time — the repository's own `BROKEN_WORKFLOW` fixture reports two.
 *
 * The first line stays a summary because the sweep prints only that; the rest go
 * one per line, trimmed of the source excerpt a `YAMLParseError` appends, which is
 * noise once several are listed together.
 */
export class WorkflowParseError extends Error {
	constructor(errors: YAMLParseError[]) {
		const problems = errors.length === 1 ? 'problem' : 'problems';
		super(
			[
				`not valid YAML: ${errors.length} ${problems}`,
				// The trailing colon introduced the excerpt, so it goes with it.
				...errors.map(
					(error) => `  ${error.message.split('\n')[0].replace(/:$/, '')}`,
				),
			].join('\n'),
		);
		this.name = 'WorkflowParseError';
		this.cause = errors;
	}
}

/** The message of whatever was thrown; catch clauses see errors as unknown. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The units whose edits are in the result — none, when a blocked run discarded them. */
export function appliedUnits(result: MigrateResult): string[] {
	return result.status === 'blocked'
		? []
		: result.report
				.filter((entry) => entry.status === 'applied')
				.map((entry) => entry.id);
}

export function parseWorkflow(src: string): Document.Parsed {
	const doc = parseDocument(src);
	if (doc.errors.length > 0) {
		throw new WorkflowParseError(doc.errors);
	}
	return doc;
}

/**
 * Run one unit and splice whatever it produced. A unit that did its work still
 * has edits when it also has something to say, so the only verdict that discards
 * them is `blocked`.
 */
export function applyUnit(
	unit: Migration,
	src: string,
	context: Context = {},
): UnitResult & { source: string } {
	const result = unit.apply(src, parseWorkflow(src), context);
	const source =
		result.edits != null &&
		result.edits.length > 0 &&
		result.status !== 'blocked'
			? applyEdits(src, result.edits)
			: src;
	return { ...result, source };
}

/**
 * Run every migration unit in registry order, reparsing between units so each one
 * reasons about the output of the last. That makes overlapping edits between units
 * impossible by construction, for the price of a few parses of a small file.
 *
 * A `blocked` verdict discards the whole run: a half-migrated workflow is worse
 * than an unmigrated one.
 *
 * `context` carries the few facts about the surrounding repository that some
 * migrations need. A unit that needs context it was not given must skip rather
 * than guess, so calling `migrate` on a bare string stays safe.
 */
export function migrate(
	src: string,
	units: Migration[] = MIGRATIONS,
	context: Context = {},
): MigrateResult {
	parseWorkflow(src);

	const report: ReportEntry[] = [];
	let current = src;

	for (const unit of units) {
		const { source: next, ...result } = applyUnit(unit, current, context);
		report.push({ id: unit.id, ...result });
		current = next;
	}

	const status = statusOf(report);
	const source = status === 'blocked' ? src : current;

	return { source, changed: source !== src, status, report };
}

/** Run statuses in descending severity: the worst verdict any unit reached wins. */
const ESCALATIONS = ['blocked', 'advisory'] as const;

function statusOf(report: ReportEntry[]): RunStatus {
	const seen = new Set(report.map((entry) => entry.status));
	return ESCALATIONS.find((status) => seen.has(status)) ?? 'ok';
}
