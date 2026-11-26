// lib/commcare/reader/identity.ts
//
// The one minter of the UUIDs a reading of a CommCare HQ app gives its
// entities. Each UUID is a UUIDv5 over one fixed namespace, whose name holds
// the app's id and the entity's external key: a function of the entity as
// Nova holds it, without its UUID, and of its owner's key. The reader computes
// a key from the entity it assembled; `identityMap.ts::externalIdentityMap`
// computes the same key from any Nova document. Both build it with
// `externalKey`, so each key has one spelling.
//
// Parts are used exactly as read: no trimming, no case folding, no Unicode
// normalization. The name is a JSON array, which is deterministic and keeps
// each part's boundaries whatever the part holds. The app's id is an element
// of the name and never the namespace, because an app id is opaque text and a
// UUIDv5 namespace must be a UUID. The kind is in the name, so equal parts
// under two kinds give two UUIDs, as one UUID names one thing whatever its
// kind (`lib/domain/authoredIdentities.ts`).

import { v5 as uuidv5 } from "uuid";
import {
	asUuid,
	type BlueprintAuthoredIdentityKind,
	type CaseOperation,
	type Column,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import {
	type CaseMappingRow,
	caseMappingRowUuid,
} from "@/lib/domain/caseMappingRows";

/** Wire protocol: changing either re-ids every app a later reading mints. */
export const HQ_ENTITY_KEY_VERSION = "nova-hq-entity-v1";
export const HQ_ENTITY_NAMESPACE_UUID = "094fd6bb-29a8-4353-80ad-87b19db1277a";

/** The identity kinds CommCare HQ's app holds, each with an external key. */
export const EXTERNAL_ENTITY_KINDS = [
	"module",
	"form",
	"field",
	"selectOption",
	"caseListColumn",
	"caseMappingRow",
	"caseListSort",
	"caseDetailTab",
	"searchInput",
	"searchFilter",
	"projectSearch",
	"projectSearchParameter",
	"caseOperation",
	"formSelection",
	"entryValue",
	"openingAssignment",
	"formLink",
	"entryPoint",
	"installationProfile",
	"userProperty",
	"organizationLevel",
	"locationProperty",
] as const satisfies readonly BlueprintAuthoredIdentityKind[];
export type ExternalEntityKind = (typeof EXTERNAL_ENTITY_KINDS)[number];

/** The kinds CommCare HQ's app holds nothing of, so a reading mints none. */
export const KINDS_WITH_NO_EXTERNAL_KEY = [
	"userType",
	"persona",
	"automation",
	"automationCriterion",
	"automationSetupOnlyCriterion",
	"automationUpdate",
	"automationRecipient",
	"automationEvent",
	"automationUserDataFilter",
] as const satisfies readonly BlueprintAuthoredIdentityKind[];

export type ExternalKeyPart = string | number | readonly ExternalKeyPart[];
export interface ExternalKey {
	readonly kind: ExternalEntityKind;
	readonly parts: readonly ExternalKeyPart[];
}

/** A case operation's place, by its `CasePlacement` (`lib/domain/placements.ts`). */
export type CaseOperationPlaceKey =
	| readonly ["basic", "own"]
	| readonly ["basic", "usercase"]
	| readonly ["basic", "subcase", index: number]
	| readonly ["basic", "subcase-row", repeatPath: readonly string[]]
	| readonly ["advanced", tag: string]
	| readonly [
			"save-to-case",
			repeatPath: readonly string[],
			path: readonly string[],
	  ];
/** Ordinary forms retain their historical namespace key. Shared entries have
 * no namespace of their own and use the aligned application resource id. */
export type FormIdentityKey =
	| string
	| readonly ["shared-form", uniqueId: string];
export function sharedFormKey(uniqueId: string): FormIdentityKey {
	return ["shared-form", uniqueId];
}

export type FormLinkTargetKey =
	| readonly ["form", targetForm: FormIdentityKey]
	| readonly [
			"form-in-menu",
			routeUniqueId: string,
			targetForm: FormIdentityKey,
	  ]
	| readonly ["module", targetModuleUniqueId: string]
	| readonly ["this-form"];
export type EntryPointOwnerKey =
	| readonly ["module", moduleUniqueId: string, slot: "menu" | "case-list"]
	| readonly ["form", form: FormIdentityKey]
	| readonly ["shared-form", menuUniqueId: string, form: FormIdentityKey];

/**
 * One constructor per kind. Each takes its parts in the key table's order,
 * one argument per part, and returns `{ kind, parts }` with nothing trimmed or
 * folded.
 *
 * - `field`: `path` is the ids from the form's root to the field, generated
 *   nodes left out (`formStructure.ts::formFieldPath`).
 * - `caseListColumn`: `field` is the case property a column shows, `""` for a
 *   calculated column; `n` is the 0-based ordinal among the module's columns
 *   of equal `(columnKind, field)` in `listColumnOrder` order.
 * - `caseOperation`: `n` is the ordinal among the form's operations of equal
 *   `(place, action)`, in `caseOperations` order.
 * - `formLink`: `n` is the ordinal among the form's links of equal `target`,
 *   counting `formLinks` in order and then the `otherwise` link.
 */
export const externalKey = {
	formSelection(formUuid: Uuid, tag: string): ExternalKey {
		return { kind: "formSelection", parts: [formUuid, tag] };
	},
	openingAssignment(formUuid: Uuid, source: string, field: Uuid): ExternalKey {
		return { kind: "openingAssignment", parts: [formUuid, source, field] };
	},
	entryValue(formUuid: Uuid, key: string): ExternalKey {
		return { kind: "entryValue", parts: [formUuid, key] };
	},
	installationProfile(key: string): ExternalKey {
		return { kind: "installationProfile", parts: [key] };
	},
	module(uniqueId: string): ExternalKey {
		return { kind: "module", parts: [uniqueId] };
	},
	form(xmlns: FormIdentityKey): ExternalKey {
		return { kind: "form", parts: [xmlns] };
	},
	field(xmlns: string, path: readonly string[]): ExternalKey {
		return { kind: "field", parts: [xmlns, [...path]] };
	},
	selectOption(
		xmlns: string,
		path: readonly string[],
		value: string,
	): ExternalKey {
		return { kind: "selectOption", parts: [xmlns, [...path], value] };
	},
	caseListColumn(
		moduleUniqueId: string,
		columnKind:
			| Column["kind"]
			| "choice-label"
			| "conditional-label"
			| "calculated-formatted-text",
		field: string,
		n: number,
	): ExternalKey {
		return {
			kind: "caseListColumn",
			parts: [moduleUniqueId, columnKind, field, ordinal(n)],
		};
	},
	caseMappingRow(owner: Uuid, comparison: string): ExternalKey {
		return { kind: "caseMappingRow", parts: [owner, comparison] };
	},
	caseCalculationText(owner: Uuid, key: string): ExternalKey {
		return {
			kind: "caseMappingRow",
			parts: [owner, ["calculation-text", key]],
		};
	},
	caseListSort(
		moduleUniqueId: string,
		expressionKey: string,
		n: number,
	): ExternalKey {
		return {
			kind: "caseListSort",
			parts: [moduleUniqueId, expressionKey, ordinal(n)],
		};
	},
	/** HQ has no tab id. The least physical column key in a populated group
	 * survives renaming, moving the group, and reordering its member fields. */
	caseDetailTab(
		first: ExternalKey,
		others: readonly ExternalKey[],
	): ExternalKey {
		let least = first;
		let text = externalKeyText(first);
		for (const column of others) {
			const candidate = externalKeyText(column);
			if (candidate < text) {
				least = column;
				text = candidate;
			}
		}
		return { kind: "caseDetailTab", parts: least.parts };
	},
	searchFilter(moduleUniqueId: string, target: string, n: number): ExternalKey {
		return {
			kind: "searchFilter",
			parts: [moduleUniqueId, target, ordinal(n)],
		};
	},
	projectSearchParameter(
		menuId: string,
		name: string,
		occurrence: number,
	): ExternalKey {
		return {
			kind: "projectSearchParameter",
			parts: [menuId, name, ordinal(occurrence)],
		};
	},
	projectSearch(endpointId: number): ExternalKey {
		return { kind: "projectSearch", parts: [endpointId] };
	},
	searchInput(moduleUniqueId: string, name: string): ExternalKey {
		return { kind: "searchInput", parts: [moduleUniqueId, name] };
	},
	caseOperation(
		xmlns: string,
		place: CaseOperationPlaceKey,
		action: CaseOperation["action"],
		n: number,
	): ExternalKey {
		return {
			kind: "caseOperation",
			parts: [xmlns, copyPart(place), action, ordinal(n)],
		};
	},
	formLink(
		xmlns: FormIdentityKey,
		target: FormLinkTargetKey,
		n: number,
	): ExternalKey {
		return {
			kind: "formLink",
			parts: [xmlns, copyPart(target), ordinal(n)],
		};
	},
	entryPoint(...owner: EntryPointOwnerKey): ExternalKey {
		return { kind: "entryPoint", parts: [...owner] };
	},
	userProperty(slug: string): ExternalKey {
		return { kind: "userProperty", parts: [slug] };
	},
	organizationLevel(code: string): ExternalKey {
		return { kind: "organizationLevel", parts: [code] };
	},
	locationProperty(slug: string): ExternalKey {
		return { kind: "locationProperty", parts: [slug] };
	},
} as const;

/** An ordinal is a whole number from 0; anything else would give one entity
 *  a second spelling of its key. */
function ordinal(n: number): number {
	if (!Number.isSafeInteger(n) || n < 0)
		throw new Error(
			`Nova was asked for an external key whose ordinal is ${n}. An ordinal counts entities from 0, so it is a whole number of at least 0.`,
		);
	return n;
}

/** A key's array parts are copied, so a caller's later change of its own
 *  array cannot change a key already claimed. */
function copyPart(part: ExternalKeyPart): ExternalKeyPart {
	return typeof part === "string" || typeof part === "number"
		? part
		: part.map(copyPart);
}

/** `JSON.stringify([kind, ...parts])`: a key's one text form, used to sort and to compare. */
export function externalKeyText(key: ExternalKey): string {
	return JSON.stringify([key.kind, ...key.parts]);
}

/** UUIDv5 of `JSON.stringify([HQ_ENTITY_KEY_VERSION, appId, key.kind, ...key.parts])`. */
export function mintEntityUuid(appId: string, key: ExternalKey): Uuid {
	const saved = savedValueRow(key);
	if (saved !== undefined) return caseMappingRowUuid(saved.owner, saved.row);
	return asUuid(
		uuidv5(
			JSON.stringify([HQ_ENTITY_KEY_VERSION, appId, key.kind, ...key.parts]),
			HQ_ENTITY_NAMESPACE_UUID,
		),
	);
}

/** A display rule over one saved value is known by its column and that
 *  comparison (`caseMappingRows.ts::caseMappingRowUuid`), which the document
 *  holds no identity for, so a reading names it as the document does. */
function savedValueRow(
	key: ExternalKey,
): { readonly owner: Uuid; readonly row: CaseMappingRow } | undefined {
	if (key.kind !== "caseMappingRow") return undefined;
	const [owner, comparison] = key.parts;
	if (typeof owner !== "string" || typeof comparison !== "string")
		return undefined;
	// Every comparison is `JSON.stringify`'s (`caseMappingComparison`).
	if (
		!comparison.startsWith('["selected",') &&
		!comparison.startsWith('["exact",')
	)
		return undefined;
	const parsed: unknown = JSON.parse(comparison);
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 2 ||
		(parsed[0] !== "selected" && parsed[0] !== "exact") ||
		typeof parsed[1] !== "string"
	)
		return undefined;
	const owned = uuidSchema.safeParse(owner);
	if (!owned.success) return undefined;
	return {
		owner: owned.data,
		row: {
			value: parsed[1],
			...(parsed[0] === "exact" && { match: "exact" as const }),
		},
	};
}

export interface IdentityMapEntry {
	readonly kind: ExternalEntityKind;
	readonly parts: readonly ExternalKeyPart[];
	readonly uuid: Uuid;
}
export type IdentityClaim =
	| { readonly ok: true; readonly uuid: Uuid }
	/** The key was claimed before, at `firstPlace`. Nothing is minted. */
	| {
			readonly ok: false;
			readonly key: ExternalKey;
			readonly firstPlace: string;
	  };

/**
 * The UUID each key takes: a function of the key alone, holding nothing, so
 * one resolver may be given to any number of readings, and a reading leaves
 * it as it found it. What a reading has claimed is its own
 * (`IdentityClaims`, from `claimsUnder`).
 */
export interface IdentityResolver {
	uuidOf(
		key: ExternalKey,
		claimed?: ReadonlySet<Uuid>,
		siblings?: ReadonlySet<string>,
	): Uuid;
}

/** The keys one reading, or one call that names entities, has claimed under a resolver. */
export interface IdentityClaims {
	/** `place` is where in HQ's app the entity was read, in the finding's place vocabulary. */
	claim(
		key: ExternalKey,
		place: string,
		siblings?: ReadonlySet<string>,
	): IdentityClaim;
	/**
	 * A key whose entity's UUID the document derives rather than the resolver
	 * gives: a form's implicit opening record, which Nova names from the form
	 * and its list (`implicitFormSelectionId`). The map holds it as
	 * `externalIdentityMap` spells it, so a later reading that finds the same
	 * record made explicit in HQ gives it back that UUID. Claimed twice, it
	 * answers as `claim` does.
	 */
	record(key: ExternalKey, uuid: Uuid, place: string): IdentityClaim;
	/** Every key claimed so far, ordered by `externalKeyText`. */
	entries(): readonly IdentityMapEntry[];
}

/** Code-unit order of two key texts. */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders entries by their key's text. */
export function sortIdentityMapEntries(
	entries: readonly IdentityMapEntry[],
): IdentityMapEntry[] {
	return entries
		.map((entry) => ({ entry, text: externalKeyText(entry) }))
		.sort((a, b) => compareText(a.text, b.text))
		.map(({ entry }) => entry);
}

/**
 * New claims under `resolver`, which gives a key not claimed before its
 * UUID. A key claimed twice answers the second claim with the first one's
 * place. Each call starts with nothing claimed, so two readings under one
 * resolver claim alike.
 */
export function claimsUnder(resolver: IdentityResolver): IdentityClaims {
	const claimed = new Map<
		string,
		{ readonly entry: IdentityMapEntry; readonly place: string }
	>();
	const ids = new Set<Uuid>();
	return {
		claim(key, place, siblings) {
			const text = externalKeyText(key);
			const first = claimed.get(text);
			if (first !== undefined)
				return { ok: false, key, firstPlace: first.place };
			const parts = key.parts.map(copyPart);
			const uuid = resolver.uuidOf({ kind: key.kind, parts }, ids, siblings);
			ids.add(uuid);
			claimed.set(text, { entry: { kind: key.kind, parts, uuid }, place });
			return { ok: true, uuid };
		},
		record(key, uuid, place) {
			const text = externalKeyText(key);
			const first = claimed.get(text);
			if (first !== undefined)
				return { ok: false, key, firstPlace: first.place };
			const parts = key.parts.map(copyPart);
			claimed.set(text, { entry: { kind: key.kind, parts, uuid }, place });
			return { ok: true, uuid };
		},
		entries() {
			return [...claimed.entries()]
				.sort(([a], [b]) => compareText(a, b))
				.map(([, { entry }]) => entry);
		},
	};
}

/** Mints every key: `mintEntityUuid(appId, key)`. A reading of an HQ app uses this. */
export function mintingResolver(appId: string): IdentityResolver {
	return Object.freeze({
		uuidOf: (key: ExternalKey) => mintEntityUuid(appId, key),
	});
}

/**
 * The UUID a key `known` lacks takes on a re-read: `mintEntityUuid(appId, key)`
 * where `taken` holds it not, else the mint of the key with `["taken", n]`
 * appended to its parts, for the smallest `n` from 1 whose UUID `taken` holds
 * not. A map holds the UUID an entity was minted under against the key it has
 * now, so an entity renamed in Nova keeps the UUID of its old key, and a new
 * entity CommCare HQ then gives that old key must not take it. The answer is a
 * function of `appId`, `key` and `taken` alone, so two readings told one map
 * give an added entity one UUID whatever order they claim in. No real key's
 * last part is a `["taken", n]` array.
 */
export function freeEntityUuid(
	appId: string,
	key: ExternalKey,
	taken: (uuid: Uuid) => boolean,
): Uuid {
	let uuid = mintEntityUuid(appId, key);
	for (let n = 1; taken(uuid); n += 1)
		uuid = mintEntityUuid(appId, {
			kind: key.kind,
			parts: [...key.parts, ["taken", n]],
		});
	return uuid;
}

/**
 * Answers a key `known` holds with its UUID and mints the rest, each a UUID
 * `known` holds under no key (`freeEntityUuid`), so a reading never gives one
 * UUID to an entity `known` names and to another.
 */
export function matchingResolver(
	appId: string,
	known: readonly IdentityMapEntry[],
	reserved: ReadonlySet<Uuid> = new Set(),
): IdentityResolver {
	return Object.freeze({ uuidOf: matchingUuidOf(appId, known, reserved) });
}

/** A map that names one key or one UUID at two entries, counted from 0. */
function namedTwice(what: string, first: number, second: number): Error {
	return new Error(
		`Nova was given an identity map that names ${what} twice (entries ${first} and ${second}). A map holds each key and each UUID once, so whatever built this map has a mistake to fix.`,
	);
}

/**
 * The UUID `matchingResolver(appId, known)` gives a key it has not been asked
 * for before: `known`'s UUID where it holds the key, else `freeEntityUuid`
 * against the UUIDs `known` holds. A canonical row that gives an entity the
 * UUID a re-read gives it asks here (`identityMap.ts::reReadUuidOf`), so the
 * row and the reading cannot disagree.
 */
export function matchingUuidOf(
	appId: string,
	known: readonly IdentityMapEntry[],
	reserved: ReadonlySet<Uuid> = new Set(),
): IdentityResolver["uuidOf"] {
	const byKey = new Map<string, Uuid>();
	const keyOfUuid = new Map<Uuid, ExternalKey>();
	const placeOfKey = new Map<string, number>();
	const placeOfUuid = new Map<Uuid, number>();
	known.forEach((entry, place) => {
		const text = externalKeyText(entry);
		const keyPlace = placeOfKey.get(text);
		if (keyPlace !== undefined)
			throw namedTwice(`the key ${text}`, keyPlace, place);
		const uuidPlace = placeOfUuid.get(entry.uuid);
		if (uuidPlace !== undefined)
			throw namedTwice(`the UUID ${entry.uuid}`, uuidPlace, place);
		byKey.set(text, entry.uuid);
		keyOfUuid.set(entry.uuid, entry);
		placeOfKey.set(text, place);
		placeOfUuid.set(entry.uuid, place);
	});
	return (key, claimed, siblings) => {
		const exact = byKey.get(externalKeyText(key));
		if (exact && !claimed?.has(exact)) return exact;
		const piece = calculationTextKey(key);
		if (piece) {
			// A native key brought in as “greeting” prints as a scoped name
			// derived from its UUID. Either spelling can be matched to an
			// already owned text in this column. A fresh app never trusts an
			// identity supplied by another app’s exported key.
			const match =
				/^v*case_text_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(
					piece.key,
				);
			const printed = match
				? uuidSchema.safeParse(match.slice(1).join("-")).data
				: undefined;
			for (const candidate of [printed, mintEntityUuid(appId, key)]) {
				const existing = candidate && keyOfUuid.get(candidate);
				const owner = existing && calculationTextKey(existing);
				if (
					existing &&
					candidate &&
					owner?.column === piece.column &&
					!claimed?.has(candidate) &&
					!siblings?.has(externalKeyText(existing))
				)
					return candidate;
			}
		}
		return freeEntityUuid(
			appId,
			key,
			(uuid) =>
				keyOfUuid.has(uuid) ||
				reserved.has(uuid) ||
				Boolean(claimed?.has(uuid)),
		);
	};
}

function calculationTextKey(key: ExternalKey) {
	const [column, parts] = key.parts;
	return key.kind === "caseMappingRow" &&
		typeof column === "string" &&
		Array.isArray(parts) &&
		parts[0] === "calculation-text" &&
		typeof parts[1] === "string"
		? { column, key: parts[1] as string }
		: undefined;
}
