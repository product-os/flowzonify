import {
	errorMessage,
	migrate,
	parseWorkflow,
	WorkflowParseError,
} from './migrate.ts';
import type { Context, MigrateResult, Migration } from './migrate.ts';
import { validate } from './validate.ts';
import { LINT_SKIPPED, lintRegressions } from './actionlint.ts';
import { isCaller } from './context.ts';
import { MIGRATIONS } from './migrations/index.ts';

/**
 * Whether actionlint's deeper pass ran, which is three states rather than two: it
 * was asked for and ran, it was asked for and the binary is not installed, or it
 * was never asked for.
 */
export type LintState = 'checked' | 'unavailable' | 'skipped';

/**
 * What should happen to one workflow, tagged by `outcome` so consumers narrow on
 * it rather than asserting: refusals carry a `detail`, decisions carry their
 * `result`, and only a `migrated` outcome says whether actionlint checked it.
 */
export type PipelineResult =
	| { outcome: 'unparseable' | 'not a caller'; detail: string }
	| { outcome: 'failed'; detail: string; result?: MigrateResult }
	| { outcome: 'blocked' | 'unchanged'; result: MigrateResult }
	| {
			outcome: 'migrated';
			result: MigrateResult;
			lintChecked: LintState;
	  };

interface PipelineOptions {
	units?: Migration[];
	context?: Context;
	lint?: boolean;
}

/**
 * Decide what should happen to one workflow, without touching the filesystem.
 *
 * Both the CLI and the fleet-wide dry run go through here, so the sweep predicts
 * what the tool will actually do rather than approximating it — a gate added
 * here cannot go missing from one of them.
 */
export function migrateSource(
	before: string,
	{ units = MIGRATIONS, context = {}, lint = true }: PipelineOptions = {},
): PipelineResult {
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
	let result: MigrateResult;
	try {
		result = migrate(before, units, context);
	} catch (error) {
		return {
			outcome: 'failed',
			detail: `migration failed: ${errorMessage(error)}`,
		};
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
		return { outcome: 'failed', result, detail: errorMessage(error) };
	}

	const linted = lint ? lintRegressions(before, result.source) : LINT_SKIPPED;
	if (!linted.ok) {
		return {
			outcome: 'failed',
			result,
			detail: `actionlint: the migration introduced new problems:\n${linted.output}`,
		};
	}

	return {
		outcome: 'migrated',
		result,
		lintChecked: !lint
			? 'skipped'
			: linted.available
				? 'checked'
				: 'unavailable',
	};
}
