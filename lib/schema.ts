import { z } from 'zod';

import { pairFor } from './source.ts';
import type { SourcePair } from './source.ts';

/**
 * One field of a caller job, read through a schema, together with the pair it came
 * from. Both arrive at once on purpose: a migration needs the value to decide and the
 * pair to know what text to splice, and handing them back separately is how the two
 * come to disagree.
 *
 * Three states, because two of them are not the same thing:
 *
 * - the key is absent: `pair` and `value` are both undefined
 * - the key is there and its shape is wrong: `pair` is set, `value` is not, and
 *   `problem` says why, which is a migration's cue to block rather than skip
 * - the key is there and valid: `pair` and `value` are both set
 */
export interface Field<T> {
	value?: T;
	pair?: SourcePair;
	problem?: string;
}

/**
 * Read one key of a mapping through a schema. The schema sees the node's plain value
 * via `toJSON`, so it never has to know about yaml's node types.
 */
export function field<T>(
	map: unknown,
	key: string,
	schema: z.ZodType<T>,
): Field<T> {
	const pair = pairFor(map, key);
	if (pair == null) {
		return {};
	}

	const parsed = schema.safeParse(pair.value?.toJSON());
	return parsed.success
		? { value: parsed.data, pair }
		: { pair, problem: parsed.error.issues[0]?.message ?? 'unexpected shape' };
}

/**
 * The runner labels a caller passes as `custom_runs_on`: a string holding a JSON array.
 * The schema validates it; the caller's own spelling of that string still has to come
 * from the node, because whether it fits on one line decides how it is written back.
 *
 * The element type is deliberately `unknown`, which makes this `Array.isArray` with a
 * JSON parse in front. Callers write both `["a"]` and `[["a"],["b"]]`, and the tighter
 * `z.array(z.union([z.string(), z.array(z.string())]))` also refuses `[1, 2]` and
 * deeper nesting that the tool accepts today. Tightening it here would newly block
 * repositories over a shape nobody has complained about.
 */
export const RunnersJson = z
	.string()
	.transform((text, ctx) => {
		try {
			return JSON.parse(text) as unknown;
		} catch {
			ctx.addIssue({ code: 'custom', message: 'not valid JSON' });
			return z.NEVER;
		}
	})
	.pipe(z.array(z.unknown()));

/**
 * `on:` in each shape GitHub allows: a single event name, a list of them, or a mapping
 * of event to its filters.
 */
export const Triggers = z.union([
	z.string(),
	z.array(z.string()),
	z.record(z.string(), z.unknown()),
]);

/** The events an `on:` declares, whichever of the three shapes it was written in. */
export function triggerNames(
	on: z.infer<typeof Triggers> | undefined,
): string[] {
	if (typeof on === 'string') {
		return [on];
	}
	if (Array.isArray(on)) {
		return on;
	}
	return Object.keys(on ?? {});
}
