import { isMap } from 'yaml';
import type { Document } from 'yaml';

/**
 * The filters GitHub allows on the triggers this tool touches, from "Events that
 * trigger workflows". `push` takes no `types`, because it has no activity types:
 * https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
 *
 * actionlint enforces the same set in its `events` rule, which is what catches a
 * mistake here: `on: {push: {types: […]}}` fails with `"types" cannot be specified
 * for "push" Webhook event`.
 *
 * Only these two are listed: a migration that inserts or copies YAML can put a
 * key somewhere it is not allowed, and the result is valid YAML that parses and
 * validates — copying a filter list out of a flow-style `pull_request` once
 * produced `push: {types: […]}`, which nothing but a schema check would notice.
 * Events with no entry here are left alone rather than guessed at.
 */
const LEGAL_FILTERS: Record<string, string[] | undefined> = {
	push: [
		'branches',
		'branches-ignore',
		'tags',
		'tags-ignore',
		'paths',
		'paths-ignore',
	],
	pull_request: [
		'types',
		'branches',
		'branches-ignore',
		'paths',
		'paths-ignore',
	],
};

/** Filters that are not allowed on the trigger they appear under, as `event.filter`. */
export function illegalFilters(doc: Document.Parsed): string[] {
	const triggers = doc.get('on');
	if (!isMap(triggers)) {
		return [];
	}

	return triggers.items.flatMap((trigger) => {
		const legal = LEGAL_FILTERS[String(trigger.key)];
		if (!legal || !isMap(trigger.value)) {
			return [];
		}

		return trigger.value.items
			.map((filter) => String(filter.key))
			.filter((filter) => !legal.includes(filter))
			.map((filter) => `${String(trigger.key)}.${filter}`);
	});
}
