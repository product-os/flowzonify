import {
	callerJobs,
	callerInput,
	inputRemoval,
	jobPassingInput,
} from '../context.ts';
import { indentAt, isBlockMap, pairRange } from '../source.ts';
import { field, RunnersJson } from '../schema.ts';
import type { SourcePair } from '../source.ts';
import type { Migration } from '../migrate.ts';

const INPUT = 'custom_runs_on';

/** The custom jobs that take a matrix input, and so can carry the runners forward. */
const MATRIX_JOBS = ['test', 'publish', 'finalize'];

/** The custom jobs that read `custom_runs_on` directly, with nowhere to move it to. */
const MATRIX_LESS_JOBS = ['clean', 'always'];

/**
 * Replace the deprecated `custom_runs_on` input with an `os` property on the
 * matrix of each custom job the repository actually defines, so that flowzone can
 * drop the input.
 *
 * `custom_clean` and `custom_always` also read the input today, but that was a
 * byproduct rather than the intent and they have no matrix to move it into; a
 * repository that defines them gets an advisory saying they fall back to
 * `runs_on`.
 */
export default {
	id: 'migrate-custom-runs-on',
	description: `Move the deprecated ${INPUT} input onto the matrix of each custom job the repository defines.`,

	apply(src, doc, context = {}) {
		if (!Array.isArray(context.customActions)) {
			return {
				status: 'skip',
				note: 'no repository context, so the custom actions this repository defines are unknown',
			};
		}

		const actions = context.customActions;
		const edits = [];

		for (const { name, node } of callerJobs(doc)) {
			const found = callerInput(node, INPUT);
			if (!found) {
				continue;
			}
			const { block } = found;

			const targets = MATRIX_JOBS.filter((job) => actions.includes(job));
			const clash = targets.find((job) => block.has(matrixKey(job)));
			if (clash) {
				return {
					status: 'blocked',
					note: `job \`${name}\` already sets \`${matrixKey(clash)}\`, so the ${INPUT} runners cannot be merged in automatically. Add \`"os"\` to that matrix by hand and remove ${INPUT}.`,
				};
			}

			const runners = field(block, INPUT, RunnersJson);
			if (runners.value == null || runners.pair == null) {
				return {
					status: 'blocked',
					note: `job \`${name}\` sets ${INPUT} to something that is not a JSON array, so it cannot become a matrix \`os\` property. Migrate this workflow by hand.`,
				};
			}

			// The schema says the labels are strings; it cannot say how the caller wrote
			// them. A value on one line is kept verbatim, and a block scalar's newlines
			// would break out of the generated matrix block, so those fold to JSON.
			const spelling = String(runners.pair.value);
			const value = spelling.includes('\n')
				? JSON.stringify(runners.value)
				: spelling;

			let target: SourcePair | undefined;
			if (targets.length > 0) {
				// Replacing the input in place splices block-style matrix lines into `with:`.
				target = isBlockMap(block) ? runners.pair : undefined;
			} else {
				// No matrix job can carry the runners, so the input is dead configuration,
				// removed under the shared rules.
				target = inputRemoval(found);
			}
			if (target == null) {
				return {
					status: 'blocked',
					note: `job \`${name}\` writes \`with:\` in flow style, so ${INPUT} cannot be replaced in place. Migrate this workflow by hand.`,
				};
			}

			const [start, end] = pairRange(src, target);
			const indent = indentAt(src, runners.pair.key.range[0]);

			edits.push({
				start,
				end,
				text: targets.map((job) => matrixInput(indent, job, value)).join(''),
			});
		}

		if (edits.length === 0) {
			return { status: 'skip' };
		}

		const orphaned = MATRIX_LESS_JOBS.filter((job) => actions.includes(job));
		if (orphaned.length > 0) {
			return {
				status: 'advisory',
				edits,
				note: `this repository defines ${orphaned.map((job) => `\`custom_${job}\``).join(' and ')}, which have no matrix input; those jobs now use \`runs_on\` instead of the ${INPUT} runners. Set \`runs_on\` if they need a different runner.`,
			};
		}

		return { status: 'applied', edits };
	},

	verify(doc) {
		const job = jobPassingInput(doc, INPUT);
		return job && `job \`${job}\` still passes ${INPUT}`;
	},
} satisfies Migration;

const matrixKey = (job: string) => `custom_${job}_matrix`;

function matrixInput(indent: string, job: string, value: string): string {
	return `${indent}${matrixKey(job)}: >\n${indent}  {\n${indent}    "os": ${value}\n${indent}  }\n`;
}
