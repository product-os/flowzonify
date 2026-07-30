#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

import { migrateFile, initRepo, WORKFLOW_PATH } from '../lib/run.ts';
import type { FileResult } from '../lib/run.ts';
import { MIGRATIONS } from '../lib/migrations/index.ts';
import { errorMessage } from '../lib/migrate.ts';

const USAGE = `flowzonify — migrate flowzone caller workflows

Usage:
  flowzonify [migrate] [path...]   migrate workflows in place (default: ${WORKFLOW_PATH})
  flowzonify init                  create a flowzone caller workflow in a new repository

Options:
  --json           print a machine-readable report instead of prose
  --list           list the available migrations and exit
  --only <id,...>  run only the named migrations
  --type <type>    (init) repo.yml type for a repository versionist cannot infer
  --help           show this message

Exit codes:
  0  migrated, already up to date, or skipped
  1  a workflow could not be parsed or failed validation
  2  a workflow needs to be migrated by hand`;

/** Total over the file statuses, so a new status cannot ship without an exit code. */
const EXIT: Record<FileResult['status'], number> = {
	ok: 0,
	advisory: 0,
	skipped: 0,
	error: 1,
	blocked: 2,
};

interface CliValues {
	json?: boolean;
	list?: boolean;
	only?: string;
	type?: string;
	help?: boolean;
}

function main(argv: string[]): number {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			json: { type: 'boolean', default: false },
			list: { type: 'boolean', default: false },
			only: { type: 'string' },
			type: { type: 'string' },
			help: { type: 'boolean', default: false },
		},
	});

	if (values.help) {
		console.log(USAGE);
		return EXIT.ok;
	}

	if (values.list) {
		for (const unit of MIGRATIONS) {
			console.log(`${unit.id}\n  ${unit.description}\n`);
		}
		return EXIT.ok;
	}

	const [command, ...rest] = positionals;

	if (command === 'init') {
		return runInit(values);
	}

	const paths = command === 'migrate' ? rest : positionals;
	return runMigrate(paths.length > 0 ? paths : [WORKFLOW_PATH], values);
}

function runInit(values: CliValues): number {
	const result = initRepo(process.cwd(), { type: values.type });
	const exit = EXIT[result.migration.status];

	if (values.json) {
		console.log(JSON.stringify(result, null, 2));
		return exit;
	}

	console.log(
		result.created
			? `created ${WORKFLOW_PATH}`
			: `${WORKFLOW_PATH} already exists`,
	);
	if (result.removedResinci) {
		console.log('removed .resinci.yml');
	}
	if (result.wroteRepoType) {
		console.log(`created repo.yml with type: ${result.repoType}`);
	}
	if (result.karmaPackages.length > 0) {
		console.log(
			result.installedKarmaPackages
				? `installed karma test dependencies: ${result.karmaPackages.join(' ')}`
				: `karma project — install these dev dependencies: ${result.karmaPackages.join(' ')}`,
		);
	}
	report(result.migration);

	return exit;
}

function runMigrate(paths: string[], values: CliValues): number {
	const only = values.only?.split(',').map((id) => id.trim());

	const files = paths.map((path) =>
		migrateFile(resolve(process.cwd(), path), {
			only,
		}),
	);

	const status = overallStatus(files);

	if (values.json) {
		console.log(JSON.stringify({ status, files }, null, 2));
	} else {
		files.forEach(report);
		reportMissingLinter(files);
	}

	return EXIT[status];
}

/**
 * A missing linter downgrades the checks silently otherwise: the workflow is
 * still schema-checked for the filters flowzonify itself writes, but actionlint's
 * deeper pass did not run and the reader should know which they got.
 */
function reportMissingLinter(files: FileResult[]): void {
	if (
		files.some((file) => file.changed && file.lintChecked === 'unavailable')
	) {
		console.log(
			'\nactionlint is not installed, so the migrated workflow was not fully checked.\n' +
				'  https://github.com/rhysd/actionlint — or let flowzone lint it on the next run.',
		);
	}
}

function overallStatus(files: FileResult[]): FileResult['status'] {
	if (files.some((file) => file.status === 'error')) {
		return 'error';
	}
	if (files.some((file) => file.status === 'blocked')) {
		return 'blocked';
	}
	return 'ok';
}

function report(file: FileResult): void {
	switch (file.status) {
		case 'error':
			console.error(`${file.path}: ${file.error}`);
			return;
		case 'skipped':
			console.log(`${file.path}: skipped — ${file.error}`);
			return;
		case 'blocked':
			console.log(`${file.path}: needs a human`);
			for (const entry of file.report.filter(
				(item) => item.status === 'blocked',
			)) {
				console.log(`  ${entry.id}: ${entry.note}`);
			}
			return;
		default:
			if (!file.changed) {
				console.log(`${file.path}: up to date`);
				return;
			}
			console.log(
				`${file.path}: applied ${file.report.filter((entry) => entry.status === 'applied').length} migration(s)`,
			);
			for (const entry of file.report.filter(
				(item) => item.status === 'advisory',
			)) {
				console.log(`  follow-up — ${entry.id}: ${entry.note}`);
			}
	}
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (error) {
	console.error(errorMessage(error));
	process.exitCode = EXIT.error;
}
