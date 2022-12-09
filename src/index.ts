import { Octokit } from '@octokit/rest';
import { strict as assert } from 'assert';
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import got from 'got';
import _ from 'lodash';
import { simpleGit, SimpleGit } from 'simple-git';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { environment } from './environment.js';

const PATHS = {
	EXAMPLE_YML: 'flowzone.yml',
	FLOWZONE_YML: '.github/workflows/flowzone.yml',
	KARMA_CONF_JS: 'karma.conf.js',
	RESINCI_YML: '.resinci.yml',
};
const execAsync = util.promisify(exec);
const encoding = 'utf-8';

/**
 * Check if a repo is public
 * @param repo - repo name
 * @returns true if repo is public, else false
 *
 * @example
 * const isPublic = await isPublicRepo('balena-io/open-balena-api');
 */
async function isPublicRepo(repo: string): Promise<boolean> {
	try {
		const response = await got(`https://github.com/${repo}`);
		if (response.statusCode === 200) {
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

/**
 * Load example flowzone.yml
 * @returns example flowzone config object
 *
 * @example
 * const example = await getExample();
 */
async function getExample(): Promise<any> {
	return YAML.parse(
		fs.readFileSync(
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				'../',
				PATHS.EXAMPLE_YML,
			),
			{
				encoding,
			},
		),
	);
}

/**
 * Create new flowzone.yml
 * @param target - target flowzone config path to create
 * @param config - flowzone config to create
 *
 * @example
 * createConfig('/tmp/foo/.github/workflows/flowzone.yml', config);
 */
function createConfig(target: string, config: any): void {
	if (!fs.existsSync(path.dirname(target))) {
		fs.mkdirSync(path.dirname(target), {
			recursive: true,
		});
	}

	fs.writeFileSync(
		target,
		YAML.stringify(config, {
			blockQuote: 'literal',
		}),
		{
			encoding,
		},
	);
}

/**
 * Update existing flowzone.yml
 * @param target - target flowzone config path to update
 * @param example - example flowzone config
 *
 * @example
 * updateConfig('/tmp/foo/.github/workflows/flowzone.yml', example);
 */
function updateConfig(target: string, example: any): void {
	// Remove with.protect_branch on updates
	if (_.has(example, ['jobs', 'flowzone', 'with', 'protect_branch'])) {
		Reflect.deleteProperty(example, 'jobs.flowzone.with.protect_branch');
		if (_.isEmpty(example.jobs.flowzone.with)) {
			Reflect.deleteProperty(example, 'jobs.flowzone.with');
		}
	}

	const local = YAML.parse(fs.readFileSync(target, 'utf-8'));
	const withConfig = local.jobs.flowzone.with;
	assert(local.on && example.on, 'Missing "on" key in flowzone.yml');
	assert(
		local.jobs.flowzone && example.jobs.flowzone,
		'Missing "jobs.flowzone" key in flowzone.yml',
	);
	local.on = example.on;
	local.jobs.flowzone = example.jobs.flowzone;
	if (withConfig) {
		local.jobs.flowzone.with = withConfig;
	}
	fs.writeFileSync(target, YAML.stringify(local), {
		encoding,
	});
}

/**
 * Flowzonify a repo
 * @param repo - repo to flowzonify
 *
 * @example
 * await flowzonify('balena-io/open-balena-api');
 */
async function flowzonify(repository: string): Promise<void> {
	const [owner, repo] = repository.split('/');
	assert(owner && repo, `Invalid repo name: ${repository}`);

	// Initialize git and octokit instances
	let git: SimpleGit = simpleGit({
		baseDir: environment.workspace,
	});
	const octo = new Octokit({
		auth: environment.personalAccessToken,
	});

	// Clone the repo
	await git.clone(`https://github.com/${repository}.git`);
	const baseDir = `${environment.workspace}/${repo}`;
	git = simpleGit({
		baseDir,
	});

	// Checkout a new local branch
	const branch = `flowzonify-${randomUUID().split('-')[0]}`;
	await git.checkoutLocalBranch(branch);

	// Delete unnecessary .resinci.yml if it exists
	if (fs.existsSync(path.join(baseDir, PATHS.RESINCI_YML))) {
		fs.unlinkSync(path.join(baseDir, PATHS.RESINCI_YML));
	}

	// Create/update flowzone.yml
	const example = await getExample();
	const isPublic = await isPublicRepo(repo);
	if (!isPublic) {
		Reflect.deleteProperty(example, 'on.pull_request_target');
	}
	let action = 'Add';
	const target = path.join(baseDir, PATHS.FLOWZONE_YML);
	if (fs.existsSync(path.join(baseDir, PATHS.FLOWZONE_YML))) {
		action = 'Update';
		updateConfig(target, example);
	} else {
		createConfig(target, example);
	}

	// Do nothing if nothing has changed
	const status = await git.status();
	if (status.files.length === 0) {
		console.log(`No changes detected for '${repo}', skipping...`);
		return;
	}

	// Install karma dev dependencies if necessary
	if (fs.existsSync(PATHS.KARMA_CONF_JS)) {
		await execAsync(
			`npm i -D balena-config-karma@4.0.0 @types/chai@^4.3.0 @types/chai-as-promised@^7.1.5 @types/mocha@^9.1.1 chai@^4.3.4 mocha@^10.0.0 ts-node@^10.0.0 karma@^5.0.0`,
		);
	}

	// Commit the changes
	const title = `CI: ${action} flowzone config`;
	const footer = 'Change-type: patch';
	const message = `${title}\n\n${footer}`;
	await git.add('.');
	await git.commit(message);

	// Push the changes
	await git.push('origin', branch);

	// Create pull request with octokit
	const { data: pullRequest } = await octo.rest.pulls.create({
		owner,
		repo,
		title,
		body: footer,
		head: branch,
		base: 'master',
	});
	console.log(`Created pull request for '${repo}':`, pullRequest.html_url);

	// Clean up locally cloned repository
	fs.rmSync(`${environment.workspace}/${repo}`, {
		recursive: true,
	});
}

/**
 * Main function, flowzonify requested repos
 */
async function main(): Promise<void> {
	for (const repo of environment.repos) {
		console.log(`Flowzonifying ${repo}...`);
		await flowzonify(repo);
	}
}

main();
