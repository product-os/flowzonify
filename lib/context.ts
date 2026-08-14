import { isMap } from 'yaml';
import type { Document, YAMLMap } from 'yaml';

import { isBlockMap, pairFor } from './source.ts';
import type { SourcePair } from './source.ts';

const FLOWZONE_WORKFLOW = 'product-os/flowzone/.github/workflows/flowzone.yml@';

export interface CallerJob {
	name: string;
	node: YAMLMap.Parsed;
}

/**
 * The jobs that call the flowzone reusable workflow, identified by their `uses:`
 * rather than by job name or file name. Job names are caller-chosen, and
 * flowzone's own workflow file mentions its full path in step scripts — only the
 * `uses:` key distinguishes a caller from a look-alike.
 */
export function callerJobs(doc: Document.Parsed): CallerJob[] {
	// Reached through `contents` rather than `doc.get`, which returns `unknown` and
	// throws away the parsed node types the jobs below are matched on.
	const jobs = pairFor(doc.contents, 'jobs')?.value;
	if (!isMap(jobs)) {
		return [];
	}

	return jobs.items.flatMap((pair) =>
		isMap(pair.value) &&
		String(pair.value.get('uses') ?? '').startsWith(FLOWZONE_WORKFLOW)
			? [{ name: String(pair.key), node: pair.value }]
			: [],
	);
}

export function isCaller(doc: Document.Parsed): boolean {
	return callerJobs(doc).length > 0;
}

/** The `with:` pair of a caller job and the pair for one input inside it. */
interface CallerInput {
	inputs: SourcePair;
	/** The mapping under `with:` — `inputs.value` with its type pinned once, here. */
	block: YAMLMap.Parsed;
	input: SourcePair;
}

export function callerInput(
	job: YAMLMap.Parsed,
	name: string,
): CallerInput | undefined {
	const inputs = pairFor(job, 'with');
	if (inputs == null || !isMap(inputs.value)) {
		return undefined;
	}

	const block = inputs.value;
	const input = pairFor(block, name);
	return input ? { inputs, block, input } : undefined;
}

/** The first caller job still passing `name`, for a migration's `verify` hook. */
export function jobPassingInput(
	doc: Document.Parsed,
	name: string,
): string | undefined {
	return callerJobs(doc).find(({ node }) => node.hasIn(['with', name]))?.name;
}

/**
 * The pair to splice out to remove one input from a caller job's `with:` block, or
 * `undefined` when there is no safe way to do it and the unit has to report that.
 *
 * An empty `with:` fails actionlint, so removing the block's last input takes the
 * block with it. A flow-style block shares one line among its inputs, so a single
 * input cannot be spliced out of one — though a block that owns its line can still
 * be dropped whole.
 */
export function inputRemoval({
	inputs,
	block,
	input,
}: CallerInput): SourcePair | undefined {
	const wholeBlock = block.items.length === 1;
	if (!wholeBlock && !isBlockMap(block)) {
		return undefined;
	}
	return wholeBlock ? inputs : input;
}
