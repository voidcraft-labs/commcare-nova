// lib/doc/order/backfill.ts
//
// Deterministic, position-seeded backfill of the `order` keys and select-
// option `uuid`s a legacy doc lacks. Both functions are pure of IO, idempotent
// (a second pass over a fully keyed doc is a no-op), and DETERMINISTIC — keys
// come from array position and option uuids from `(field uuid, option index)`,
// never `randomUUID()`. Determinism is the point: two independent hydrations of
// one legacy doc (a client and the server) produce byte-identical keys/uuids,
// so they never disagree about an entity's position or an option's identity.

import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { keyBetween, normalizedKey } from "./keys";

/** An entity carrying the optional fractional `order` slot. */
interface Ordered {
	order?: string;
}

/**
 * Fill the absent `order` keys of an ordered list IN PLACE. Pre-existing keys
 * are respected and bound the keys filled around them; each maximal run of
 * keyless entries between two bounds (null past either end) is assigned by
 * recursive midpoint bisection, so a fully-legacy list of N entries gets keys
 * of length O(log N) rather than an O(N) place-after chain. Deterministic: the
 * midpoint at each step is a pure function of the run's index range and bounds.
 */
function fillOrder(items: Ordered[]): void {
	let i = 0;
	let lower: string | null = null;
	while (i < items.length) {
		if (items[i].order !== undefined) {
			lower = items[i].order as string;
			i++;
			continue;
		}
		let end = i;
		while (end < items.length && items[end].order === undefined) end++;
		const rawUpper = end < items.length ? (items[end].order as string) : null;
		// A partially-keyed legacy doc can bound a keyless run by two keys whose
		// ARRAY order disagrees with their KEY order (a reorder set keys without
		// touching the array). There's no key between an inverted/equal pair —
		// judged by NUMERIC key value (trailing zeros carry none, and a
		// foreign-authored zero key `"0"` is the fraction 0, below which nothing
		// sorts) — so append the run after `lower` (upper ≡ null) instead:
		// deterministic, and keeps `keyBetween`'s ordered-interval precondition.
		const upper =
			rawUpper !== null &&
			(normalizedKey(rawUpper).length === 0 ||
				(lower !== null && normalizedKey(lower) >= normalizedKey(rawUpper)))
				? null
				: rawUpper;
		assignRange(items, i, end, lower, upper);
		i = end;
	}
}

/**
 * Assign `order` keys to `items[start, end)` by recursive midpoint bisection
 * within the open interval (`lower`, `upper`): the midpoint gets the key
 * strictly between the bounds, then each half recurses against the tighter
 * bound. Pure of the index range + bounds, so it is deterministic.
 */
function assignRange(
	items: Ordered[],
	start: number,
	end: number,
	lower: string | null,
	upper: string | null,
): void {
	if (start >= end) return;
	const mid = (start + end) >> 1;
	const key = keyBetween(lower, upper);
	items[mid].order = key;
	assignRange(items, start, mid, lower, key);
	assignRange(items, mid + 1, end, key, upper);
}

/** Resolve an order array of uuids to its entities, then fill their keys. */
function fillOrderByUuids<T extends Ordered>(
	uuids: readonly string[],
	lookup: (uuid: string) => T | undefined,
): void {
	const items: Ordered[] = [];
	for (const uuid of uuids) {
		const entity = lookup(uuid);
		if (entity) items.push(entity);
	}
	fillOrder(items);
}

/**
 * Seed `order` from current array position on every structural and
 * collection entity that lacks one: modules (`moduleOrder`), forms (each
 * `formOrder[m]`), fields (each `fieldOrder[p]`), and the per-module
 * `caseListConfig` columns/searchInputs plus each select field's options
 * (whose array index IS their position). Mutates `doc` in place.
 */
export function backfillOrderKeys(doc: BlueprintDoc): void {
	fillOrderByUuids(doc.moduleOrder, (uuid) => doc.modules[uuid]);
	for (const formUuids of Object.values(doc.formOrder)) {
		fillOrderByUuids(formUuids, (uuid) => doc.forms[uuid]);
	}
	for (const fieldUuids of Object.values(doc.fieldOrder)) {
		fillOrderByUuids(fieldUuids, (uuid) => doc.fields[uuid]);
	}
	for (const module of Object.values(doc.modules)) {
		const config = module.caseListConfig;
		if (config) {
			fillOrder(config.columns);
			fillOrder(config.searchInputs);
		}
	}
	for (const field of Object.values(doc.fields)) {
		if ("options" in field && Array.isArray(field.options)) {
			fillOrder(field.options);
		}
	}
}

/**
 * Mint a stable `uuid` for any select option missing one, derived from its
 * field's uuid and array index (`<field.uuid>-opt-<i>`). Mutates `doc` in
 * place. Two hydrations of the same legacy doc produce identical uuids, so a
 * client-side diff never references an option the server doesn't have.
 */
export function backfillOptionUuids(doc: BlueprintDoc): void {
	for (const field of Object.values(doc.fields)) {
		if (!("options" in field) || !Array.isArray(field.options)) continue;
		field.options.forEach((option, index) => {
			if (option.uuid === undefined) {
				option.uuid = asUuid(`${field.uuid}-opt-${index}`);
			}
		});
	}
}
