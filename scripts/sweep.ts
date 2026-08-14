#!/usr/bin/env node
/**
 * Dry-run every live flowzone caller through the migrations and report what would
 * happen, without touching a single repository.
 *
 * Fetching and analysis are separate on purpose: pipe workflow files in as NDJSON
 * from whatever source you like, one object per line:
 *
 *   {"name": "org/repo", "text": "<flowzone.yml>", "customActions": ["test"], "isNpmPackage": true}
 *
 * Every key but `name` and `text` is repository context. Supply all of it:
 * migrations that need context they were not given skip rather than guess, so a
 * missing key silently under-reports what the tool would really do. See the
 * README for a query that gathers it.
 *
 *   gh api graphql --paginate -f query='
 *     query($endCursor: String) {
 *       organization(login: "product-os") {
 *         repositories(first: 50, after: $endCursor, isArchived: false) {
 *           pageInfo { hasNextPage endCursor }
 *           nodes {
 *             name
 *             object(expression: "HEAD:.github/workflows/flowzone.yml") {
 *               ... on Blob { text }
 *             }
 *           }
 *         }
 *       }
 *     }' --jq '.data.organization.repositories.nodes[]
 *              | select(.object != null)
 *              | {name: .name, text: .object.text}' \
 *   | node scripts/sweep.ts
 */
import { migrateSource } from '../lib/pipeline.ts';
import type { PipelineResult } from '../lib/pipeline.ts';
import { appliedUnits, errorMessage } from '../lib/migrate.ts';
import type { Context, MigrateResult } from '../lib/migrate.ts';

/** One NDJSON row: the workflow text plus the repository context, as documented above. */
type SweepInput = { name: string; text: string } & Context;

/** Everything a row may carry, so a misspelled key is refused rather than ignored. */
const ROW_KEYS: readonly string[] = [
	'name',
	'text',
	'isNpmPackage',
	'customActions',
];

/**
 * One row, checked rather than asserted. A row is the only thing this script knows
 * about a repository, and a migration handed context it did not expect skips instead
 * of guessing, so a misspelled key would quietly under-report the real answer.
 */
function sweepInput(line: string, at: number): SweepInput {
	let row: unknown;
	try {
		row = JSON.parse(line);
	} catch (error) {
		// JSON's own message counts from the start of this row, so say which row.
		throw new Error(`line ${at}: ${errorMessage(error)}`);
	}

	if (typeof row !== 'object' || row == null) {
		throw new Error(`line ${at}: expected a JSON object`);
	}

	const unexpected = Object.keys(row).filter((key) => !ROW_KEYS.includes(key));
	if (unexpected.length > 0) {
		throw new Error(`line ${at}: unexpected ${unexpected.join(', ')}`);
	}
	if (!('name' in row) || typeof row.name !== 'string') {
		throw new Error(`line ${at}: \`name\` must be a string`);
	}
	if (!('text' in row) || typeof row.text !== 'string') {
		throw new Error(`line ${at}: \`text\` must be a string`);
	}

	const input: SweepInput = { name: row.name, text: row.text };

	if ('isNpmPackage' in row) {
		if (typeof row.isNpmPackage !== 'boolean') {
			throw new Error(`line ${at}: \`isNpmPackage\` must be a boolean`);
		}
		input.isNpmPackage = row.isNpmPackage;
	}
	if ('customActions' in row) {
		if (
			!Array.isArray(row.customActions) ||
			!row.customActions.every(
				(action): action is string => typeof action === 'string',
			)
		) {
			throw new Error(
				`line ${at}: \`customActions\` must be an array of strings`,
			);
		}
		input.customActions = row.customActions;
	}

	return input;
}

const LABELS: Partial<Record<PipelineResult['outcome'], string>> = {
	blocked: 'needs a human',
	unchanged: 'up to date',
};

/** Every outcome the summary counts, in the order it lists them. */
const TALLY: ReadonlyArray<PipelineResult['outcome']> = [
	'migrated',
	'unchanged',
	'blocked',
	'unparseable',
	'not a caller',
	'failed',
];

const label = (outcome: PipelineResult['outcome']) =>
	LABELS[outcome] ?? outcome;

/** Wide enough for the longest label, so the listing and the summary line up. */
const WIDTH = Math.max(...TALLY.map((outcome) => label(outcome).length));
const column = (text: string) => text.padEnd(WIDTH);

function sweep({ name, text, ...context }: SweepInput) {
	const decision = migrateSource(text, { context });
	// Only some outcomes carry each of these, so ask before reaching for them rather
	// than having every arm of the type declare the ones it does not have.
	const result = 'result' in decision ? decision.result : undefined;
	const detail = 'detail' in decision ? decision.detail : undefined;

	return {
		name,
		outcome: decision.outcome,
		detail: detail?.split('\n')[0] ?? blockedNote(result),
		applied: result ? appliedUnits(result) : [],
		lintChecked:
			decision.outcome === 'migrated' ? decision.lintChecked : undefined,
	};
}

const blockedNote = (result?: MigrateResult) =>
	result?.report.find((entry) => entry.status === 'blocked')?.note;

function main(input: string): number {
	const rows = input
		.split('\n')
		.map((line, index) => ({ line, at: index + 1 }))
		.filter(({ line }) => line.trim().length > 0);

	const workflows: SweepInput[] = [];
	const rejected: string[] = [];
	for (const { line, at } of rows) {
		try {
			workflows.push(sweepInput(line, at));
		} catch (error) {
			rejected.push(errorMessage(error));
		}
	}

	const results = workflows.map(sweep);

	for (const result of results) {
		const detail = result.detail ? ` — ${result.detail}` : '';
		const applied =
			result.applied.length > 0 ? ` (${result.applied.join(', ')})` : '';
		console.log(
			`${column(label(result.outcome))} ${result.name}${applied}${detail}`,
		);
	}

	console.log('\nsummary');
	for (const outcome of TALLY) {
		const count = results.filter((result) => result.outcome === outcome).length;
		if (count > 0) {
			console.log(`  ${column(label(outcome))} ${count}`);
		}
	}

	// Loudly, and with a non-zero exit: a row this script could not read is a
	// repository missing from the report, which is the one thing a dry run must
	// not do quietly.
	if (rejected.length > 0) {
		console.log(`\ncould not read ${rejected.length} of ${rows.length} rows`);
		for (const problem of rejected) {
			console.log(`  ${problem}`);
		}
	}

	if (results.some((result) => result.lintChecked === 'unavailable')) {
		console.log(
			'\nactionlint is not installed; migrated workflows were not linted',
		);
	}

	return rejected.length > 0 ||
		results.some((result) => result.outcome === 'failed')
		? 1
		: 0;
}

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (buffered += String(chunk)));
process.stdin.on('end', () => {
	process.exitCode = main(buffered);
});
