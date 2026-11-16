// lib/domain/formMembership.ts
//
// Which menus list a form, read once per immutable `formOrder`.
//
// The validator, the emitter, the reader and acceptance ask which module
// holds a form once per form, field or carrier, so a lookup that scanned
// `formOrder` each time would make a whole-document pass quadratic in forms.
// The answer is a projection of `formOrder` alone, so it is derived once per
// `formOrder` object and remembered by that object's identity, but only while
// the object can no longer change: a frozen record that is no Immer draft,
// every array in it frozen too. A draft, or a record still open to a write in
// place, gets the scan, because a remembered answer for an object that
// changed under it would be a wrong commit verdict.
//
// Each lookup keeps its own first-match rule exactly: the first module in
// `formOrder`'s entry order, in sorted key order, or in `moduleOrder`.

import { isSettled as settled } from "./settled";

type FormOrder = Readonly<Record<string, readonly string[]>>;

/** Each form's listing menus, in `formOrder`'s entry order, each menu once. */
type Listings = ReadonlyMap<string, readonly string[]>;

const listingsByOrder = new WeakMap<object, Listings>();
const positionsByOrder = new WeakMap<object, Positions>();

/** The listings of a settled `formOrder`, or `undefined` where it may still change. */
function listingsOf(formOrder: FormOrder): Listings | undefined {
	const known = listingsByOrder.get(formOrder);
	if (known !== undefined) return known;
	if (!settled(formOrder)) return undefined;
	const listings = new Map<string, string[]>();
	for (const [moduleUuid, forms] of Object.entries(formOrder)) {
		if (!Array.isArray(forms) || !settled(forms)) return undefined;
		for (const form of forms) {
			const modules = listings.get(form);
			if (modules === undefined) listings.set(form, [moduleUuid]);
			else if (modules[modules.length - 1] !== moduleUuid)
				modules.push(moduleUuid);
		}
	}
	listingsByOrder.set(formOrder, listings);
	return listings;
}

const NONE: readonly string[] = [];

/**
 * Every module whose `formOrder` lists `formUuid`, in `formOrder`'s entry
 * order, each once.
 */
export function modulesListingForm(
	formOrder: FormOrder,
	formUuid: string,
): readonly string[] {
	const listings = listingsOf(formOrder);
	if (listings !== undefined) return listings.get(formUuid) ?? NONE;
	const modules: string[] = [];
	for (const [moduleUuid, forms] of Object.entries(formOrder))
		if (forms.includes(formUuid)) modules.push(moduleUuid);
	return modules;
}

/** The first module in `formOrder`'s entry order that lists `formUuid`. */
export function firstModuleListingForm(
	formOrder: FormOrder,
	formUuid: string,
): string | undefined {
	const listings = listingsOf(formOrder);
	if (listings !== undefined) return listings.get(formUuid)?.[0];
	for (const [moduleUuid, forms] of Object.entries(formOrder))
		if (forms.includes(formUuid)) return moduleUuid;
	return undefined;
}

/**
 * The first module, in sorted key order (`Array.prototype.sort`'s default),
 * whose `formOrder` lists `formUuid`.
 */
export function firstSortedModuleListingForm(
	formOrder: FormOrder,
	formUuid: string,
): string | undefined {
	const listings = listingsOf(formOrder);
	if (listings === undefined) {
		for (const moduleUuid of Object.keys(formOrder).sort())
			if (formOrder[moduleUuid]?.includes(formUuid)) return moduleUuid;
		return undefined;
	}
	let first: string | undefined;
	for (const moduleUuid of listings.get(formUuid) ?? NONE)
		if (first === undefined || moduleUuid < first) first = moduleUuid;
	return first;
}

/**
 * Each module's first position in a settled `moduleOrder`, and whether it
 * names a key of `Object.prototype`, which a read of an ordinary record by
 * that name finds through the prototype.
 */
interface Positions {
	readonly at: ReadonlyMap<string, number>;
	readonly namesInherited: boolean;
}

function positionsOf(moduleOrder: readonly string[]): Positions | undefined {
	const known = positionsByOrder.get(moduleOrder);
	if (known !== undefined) return known;
	if (!settled(moduleOrder)) return undefined;
	const at = new Map<string, number>();
	let namesInherited = false;
	moduleOrder.forEach((moduleUuid, position) => {
		if (!at.has(moduleUuid)) at.set(moduleUuid, position);
		if (moduleUuid in Object.prototype) namesInherited = true;
	});
	const positions = { at, namesInherited };
	positionsByOrder.set(moduleOrder, positions);
	return positions;
}

/**
 * The first module in `moduleOrder` whose `formOrder` lists `formUuid`; a
 * module `moduleOrder` does not name is never the answer.
 */
export function firstOrderedModuleListingForm(
	doc: {
		readonly formOrder: FormOrder;
		readonly moduleOrder: readonly string[];
	},
	formUuid: string,
): string | undefined {
	const listings = listingsOf(doc.formOrder);
	const positions =
		listings === undefined ? undefined : positionsOf(doc.moduleOrder);
	/* `doc.formOrder[name]` on an ordinary record reads `Object.prototype`
	 * for a name the record does not hold, so such a name takes the scan. */
	const inherited =
		positions?.namesInherited === true &&
		Object.getPrototypeOf(doc.formOrder) !== null;
	if (listings === undefined || positions === undefined || inherited) {
		for (const moduleUuid of doc.moduleOrder)
			if (doc.formOrder[moduleUuid]?.includes(formUuid)) return moduleUuid;
		return undefined;
	}
	let first: string | undefined;
	let firstAt = Number.POSITIVE_INFINITY;
	for (const moduleUuid of listings.get(formUuid) ?? NONE) {
		const at = positions.at.get(moduleUuid);
		if (at !== undefined && at < firstAt) {
			first = moduleUuid;
			firstAt = at;
		}
	}
	return first;
}
