import { isMap } from 'yaml';

import { callerJobs } from '../context.js';
import { indentAt, isBlockMap, pairFor, pairRange } from '../source.js';

const GRANT_LINE = 'id-token: write  # https://docs.npmjs.com/trusted-publishers';

const BLOCK = [
	'permissions:',
	`  ${GRANT_LINE}`,
	'  contents: read',
	'  packages: read  # should we decide to publish to ghcr.io',
];

const block = (indent = '') => BLOCK.map((line) => `${indent}${line}\n`).join('');

export default {
	id: 'add-npm-oidc-permissions',
	description:
		'Give npm packages the id-token: write permission that trusted publishing needs.',

	apply(src, doc, context = {}) {
		if (context.isNpmPackage === undefined) {
			return {
				status: 'skip',
				note: 'no repository context, so whether this is an npm package is unknown',
			};
		}
		if (!context.isNpmPackage) {
			return { status: 'skip' };
		}

		const jobs = callerJobs(doc);
		const edits = [];

		// A job-level permissions block replaces the workflow-level one for that job,
		// so a caller job that has its own block needs the grant in it — a top-level
		// grant would never reach the job that publishes.
		for (const { name, node } of jobs) {
			const permissions = pairFor(node, 'permissions');
			if (!permissions) {
				continue;
			}
			const granted = grantIn(src, permissions, ` of job \`${name}\``);
			if (granted.note) {
				return { status: 'blocked', note: granted.note };
			}
			edits.push(...granted.edits);
		}

		// The workflow-level block covers every caller job without its own.
		if (jobs.some(({ node }) => !pairFor(node, 'permissions'))) {
			const permissions = pairFor(doc.contents, 'permissions');
			const granted = permissions ? grantIn(src, permissions, '') : addBlock(src, doc);
			if (granted.note) {
				return { status: 'blocked', note: granted.note };
			}
			edits.push(...granted.edits);
		}

		return edits.length > 0 ? { status: 'applied', edits } : { status: 'skip' };
	},

	verify(doc) {
		for (const { name, node } of callerJobs(doc)) {
			const grant = pairFor(node, 'permissions')
				? node.getIn(['permissions', 'id-token'])
				: doc.getIn(['permissions', 'id-token']);
			if (grant !== 'write') {
				return `job \`${name}\` does not run with id-token: write`;
			}
		}
	},
};

/** The edits that give one permissions block — top-level or job-level — the grant. */
function grantIn(src, permissions, where) {
	if (!isMap(permissions.value)) {
		return {
			note: `\`permissions:\`${where} is not a mapping, so id-token: write cannot be added safely. Migrate this workflow by hand.`,
		};
	}

	// `permissions: {}` is a mapping with nothing to extend, so write the block
	// where the caller put it rather than reaching for a last entry that is not there.
	if (permissions.value.items.length === 0) {
		const indent = indentAt(src, permissions.key.range[0]);
		return { edits: [{ ...spanOf(src, permissions), text: block(indent) }] };
	}

	const granted = pairFor(permissions.value, 'id-token');
	if (granted && String(granted.value) === 'write') {
		return { edits: [] };
	}

	// Granting over an existing value splices that value alone, which is safe in
	// any style. Everything else splices whole lines, which a flow mapping shares
	// between its pairs.
	if (granted && granted.value?.value != null) {
		// `none` and `read` are declarations too, and neither can publish.
		return { edits: [grantWrite(src, granted, !isBlockMap(permissions.value))] };
	}
	if (!isBlockMap(permissions.value)) {
		return {
			note: `\`permissions:\`${where} is written in flow style, so id-token: write cannot be added to it safely. Migrate this workflow by hand.`,
		};
	}

	return { edits: [granted ? grantWrite(src, granted) : appendGrant(src, permissions)] };
}

function addBlock(src, doc) {
	const jobs = pairFor(doc.contents, 'jobs');
	if (!jobs) {
		return {
			note: 'the workflow has no `jobs:` block to anchor the permissions above. Migrate this workflow by hand.',
		};
	}

	const [start] = pairRange(src, jobs);
	return { edits: [{ start, end: start, text: `${block()}\n` }] };
}

/**
 * Raise an existing grant to `write`, replacing the value alone so the caller's
 * own line survives. A comment on that line described the value being replaced
 * and would contradict the new one, so it goes with it; a key with no value is a
 * Scalar wrapping null, whose range is zero-width, with nothing to splice over.
 * Both rewrite the line instead — unless the mapping is flow style, where the
 * line is shared and only the value splice is safe.
 */
function grantWrite(src, granted, inFlow = false) {
	if (!inFlow && (granted.value?.value == null || granted.value.comment != null)) {
		const indent = indentAt(src, granted.key.range[0]);
		return { ...spanOf(src, granted), text: `${indent}${GRANT_LINE}\n` };
	}

	const [start, end] = granted.value.range;
	return { start, end, text: 'write' };
}

function spanOf(src, pair) {
	const [start, end] = pairRange(src, pair);
	return { start, end };
}

/** Extend the caller's own block rather than adding a second `permissions:` key. */
function appendGrant(src, permissions) {
	const last = permissions.value.items.at(-1);
	const [, end] = pairRange(src, last);
	const indent = indentAt(src, last.key.range[0]);

	return { start: end, end, text: `${indent}${GRANT_LINE}\n` };
}
