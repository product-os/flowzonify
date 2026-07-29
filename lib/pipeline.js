import { migrate, parseWorkflow, WorkflowParseError } from './migrate.js';
import { validate } from './validate.js';
import { lintRegressions } from './actionlint.js';
import { isCaller } from './context.js';
import { MIGRATIONS } from './migrations/index.js';

/**
 * Decide what should happen to one workflow, without touching the filesystem.
 *
 * Both the CLI and the fleet-wide dry run go through here, so the sweep predicts
 * what the tool will actually do rather than approximating it — a gate added
 * here cannot go missing from one of them.
 */
export function migrateSource(before, { units = MIGRATIONS, context = {}, lint = true } = {}) {
	let doc;
	try {
		doc = parseWorkflow(before);
	} catch (error) {
		if (error instanceof WorkflowParseError) {
			return { outcome: 'unparseable', detail: error.message };
		}
		throw error;
	}

	if (!isCaller(doc)) {
		return {
			outcome: 'not a caller',
			detail: 'no job in this workflow calls the flowzone reusable workflow',
		};
	}

	// A unit that throws — or that produces source the next one cannot parse — fails
	// this workflow only. In a fleet-wide run one malformed repository must not take
	// the rest of the campaign down with it.
	let result;
	try {
		result = migrate(before, units, context);
	} catch (error) {
		return { outcome: 'failed', detail: `migration failed: ${error.message}` };
	}

	if (result.status === 'blocked') {
		return { outcome: 'blocked', result };
	}
	if (!result.changed) {
		return { outcome: 'unchanged', result };
	}

	try {
		validate(before, result, units, context);
	} catch (error) {
		return { outcome: 'failed', result, detail: error.message };
	}

	const linted = lint ? lintRegressions(before, result.source) : { available: false, ok: true };
	if (!linted.ok) {
		return {
			outcome: 'failed',
			result,
			detail: `actionlint: the migration introduced new problems:\n${linted.output}`,
		};
	}

	return { outcome: 'migrated', result, lintChecked: lint ? linted.available : undefined };
}
