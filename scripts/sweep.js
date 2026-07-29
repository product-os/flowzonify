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
 *   | node scripts/sweep.js
 */
import { migrateSource } from '../lib/pipeline.js';

const LABELS = { blocked: 'needs a human', unchanged: 'up to date' };

const TALLY = ['migrated', 'up to date', 'needs a human', 'unparseable', 'not a caller', 'failed'];

function sweep({ name, text, ...context }) {
	const { outcome, result, detail, lintChecked } = migrateSource(text, { context });

	// A blocked run discards every edit, so nothing in its report was applied.
	const report = (result?.status === 'blocked' ? [] : result?.report) ?? [];

	return {
		name,
		outcome: LABELS[outcome] ?? outcome,
		detail: detail?.split('\n')[0] ?? blockedNote(result),
		applied: report.filter((entry) => entry.status === 'applied').map((entry) => entry.id),
		lintChecked,
	};
}

const blockedNote = (result) =>
	result?.report.find((entry) => entry.status === 'blocked')?.note;

function main(input) {
	const workflows = input
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));

	const results = workflows.map(sweep);

	for (const result of results) {
		const detail = result.detail ? ` — ${result.detail}` : '';
		const applied = result.applied?.length ? ` (${result.applied.join(', ')})` : '';
		console.log(`${result.outcome.padEnd(14)} ${result.name}${applied}${detail}`);
	}

	console.log('\nsummary');
	for (const outcome of TALLY) {
		const count = results.filter((result) => result.outcome === outcome).length;
		if (count > 0) {
			console.log(`  ${outcome.padEnd(14)} ${count}`);
		}
	}

	if (results.some((result) => !result.lintChecked && result.outcome === 'migrated')) {
		console.log('\nactionlint is not installed; migrated workflows were not linted');
	}

	return results.some((result) => result.outcome === 'failed') ? 1 : 0;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
	process.exitCode = main(input);
});
