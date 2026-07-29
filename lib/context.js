import { isMap } from 'yaml';

import { isBlockMap, pairFor } from './source.js';

const FLOWZONE_WORKFLOW = 'product-os/flowzone/.github/workflows/flowzone.yml@';

/**
 * The jobs that call the flowzone reusable workflow, identified by their `uses:`
 * rather than by job name or file name. Job names are caller-chosen, and
 * flowzone's own workflow file mentions its full path in step scripts — only the
 * `uses:` key distinguishes a caller from a look-alike.
 */
export function callerJobs(doc) {
	const jobs = doc.get('jobs');
	if (!isMap(jobs)) {
		return [];
	}

	return jobs.items
		.filter(
			(pair) =>
				isMap(pair.value) && String(pair.value.get('uses') ?? '').startsWith(FLOWZONE_WORKFLOW),
		)
		.map((pair) => ({ name: String(pair.key), node: pair.value }));
}

export function isCaller(doc) {
	return callerJobs(doc).length > 0;
}

/** The `with:` pair of a caller job and the pair for one input inside it. */
export function callerInput(job, name) {
	const inputs = pairFor(job, 'with');
	const input = pairFor(inputs?.value, name);
	return input ? { inputs, input } : undefined;
}

/** The first caller job still passing `name`, for a migration's `verify` hook. */
export function jobPassingInput(doc, name) {
	return callerJobs(doc).find(({ node }) => node.hasIn(['with', name]))?.name;
}

/**
 * How to remove one input from a caller job's `with:` block. An empty `with:`
 * fails actionlint, so removing the block's last input takes the block with it.
 * A flow-style block shares one line among its inputs, so a single input cannot
 * be spliced out of one — though a block that owns its line can still be dropped
 * whole — and that comes back `blocked` for the unit to report.
 */
export function inputRemoval({ inputs, input }) {
	const wholeBlock = inputs.value.items.length === 1;
	if (!wholeBlock && !isBlockMap(inputs.value)) {
		return { blocked: true };
	}
	return { target: wholeBlock ? inputs : input };
}
