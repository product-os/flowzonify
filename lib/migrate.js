import { parseDocument } from 'yaml';

import { applyEdits } from './source.js';
import { MIGRATIONS } from './migrations/index.js';

export class WorkflowParseError extends Error {
	constructor(error) {
		super(`not valid YAML: ${error.message}`);
		this.name = 'WorkflowParseError';
		this.cause = error;
	}
}

export function parseWorkflow(src) {
	const doc = parseDocument(src);
	if (doc.errors.length > 0) {
		throw new WorkflowParseError(doc.errors[0]);
	}
	return doc;
}

/**
 * Run one unit and splice whatever it produced. A unit that did its work still
 * has edits when it also has something to say, so the only verdict that discards
 * them is `blocked`.
 */
export function applyUnit(unit, src, context = {}) {
	const result = unit.apply(src, parseWorkflow(src), context);
	const source =
		result.edits?.length > 0 && result.status !== 'blocked' ? applyEdits(src, result.edits) : src;
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
export function migrate(src, units = MIGRATIONS, context = {}) {
	parseWorkflow(src);

	const report = [];
	let current = src;

	for (const unit of units) {
		const { source, ...result } = applyUnit(unit, current, context);
		report.push({ id: unit.id, ...result });
		current = source;
	}

	const status = statusOf(report);
	const source = status === 'blocked' ? src : current;

	return { source, changed: source !== src, status, report };
}

function statusOf(report) {
	if (report.some((entry) => entry.status === 'blocked')) {
		return 'blocked';
	}
	if (report.some((entry) => entry.status === 'advisory')) {
		return 'advisory';
	}
	return 'ok';
}
