import { isMap } from 'yaml';
import type { Pair, ParsedNode, YAMLMap } from 'yaml';

/** One splice of the workflow source: replace `[start, end)` with `text`. */
export interface Edit {
	start: number;
	end: number;
	text: string;
}

/** A key/value pair from a parsed document, whose nodes carry source ranges. */
export type SourcePair = Pair<ParsedNode, ParsedNode | null>;

function lineStartAt(src: string, index: number): number {
	return src.lastIndexOf('\n', index - 1) + 1;
}

function lineEndAt(src: string, index: number): number {
	const next = src.indexOf('\n', index);
	return next < 0 ? src.length : next + 1;
}

export function indentAt(src: string, index: number): string {
	return ' '.repeat(index - lineStartAt(src, index));
}

/**
 * A mapping whose pairs occupy lines of their own. Flow mappings put several
 * pairs on one line, so splicing whole lines would take siblings with them.
 */
export function isBlockMap(node: unknown): node is YAMLMap.Parsed {
	return isMap(node) && node.flow !== true;
}

/**
 * The pair under `key`, rather than its value. Migrations splice source ranges,
 * and a range needs the pair — `map.get(key)` throws the key node away with the
 * comments attached to it.
 */
export function pairFor(map: unknown, key: string): SourcePair | undefined {
	return isMap(map)
		? (map.items as SourcePair[]).find((pair) => String(pair.key) === key)
		: undefined;
}

/**
 * The source range of a mapping pair, as whole lines, extended backwards over
 * the comment lines that document it. Deleting this range takes the stale
 * comment with the thing it describes.
 */
export function pairRange(src: string, pair: SourcePair): [number, number] {
	// Splicing whole lines is only sound when the pair owns them. A pair inside a
	// flow collection shares its line with siblings, so refuse it loudly rather
	// than hand back a range that would take them too.
	const keyStart = pair.key.range[0];
	if (/\S/.test(src.slice(lineStartAt(src, keyStart), keyStart))) {
		throw new Error(
			'pairRange: the pair does not start its own line; check isBlockMap before splicing',
		);
	}

	const last = pair.value ?? pair.key;
	const end = lineEndAt(src, last.range[2] - 1);

	let start = lineStartAt(src, pair.key.range[0]);
	while (start > 0) {
		const previous = lineStartAt(src, start - 1);
		if (!/^\s*#/.test(src.slice(previous, start))) {
			break;
		}
		start = previous;
	}

	return [start, end];
}

export function applyEdits(src: string, edits: Edit[]): string {
	const ordered = edits.toSorted((a, b) => b.start - a.start);

	for (let i = 0; i < ordered.length - 1; i++) {
		if (ordered[i].start < ordered[i + 1].end) {
			throw new Error(
				`overlapping edits: [${ordered[i + 1].start}, ${ordered[i + 1].end}) and [${ordered[i].start}, ${ordered[i].end})`,
			);
		}
	}

	// Back to front, so that splicing one edit never moves the offsets of the ones
	// still to come.
	let out = src;
	for (const edit of ordered) {
		out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
	}
	return out;
}
