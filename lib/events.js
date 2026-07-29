import { isMap } from 'yaml';

/**
 * The filters GitHub allows on the triggers this tool touches, taken from what
 * actionlint accepts rather than from memory.
 *
 * Only these two are listed: a migration that inserts or copies YAML can put a
 * key somewhere it is not allowed, and the result is valid YAML that parses and
 * validates — copying a filter list out of a flow-style `pull_request` once
 * produced `push: {types: […]}`, which nothing but a schema check would notice.
 * Events with no entry here are left alone rather than guessed at.
 */
const LEGAL_FILTERS = {
	push: ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore'],
	pull_request: ['types', 'branches', 'branches-ignore', 'paths', 'paths-ignore'],
};

/** Filters that are not allowed on the trigger they appear under, as `event.filter`. */
export function illegalFilters(doc) {
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
