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
} from "@/lib/domain";

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
	"searchInput",
	"caseOperation",
	"formLink",
	"entryPoint",
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
export type FormLinkTargetKey =
	| readonly ["form", targetXmlns: string]
	| readonly ["module", targetModuleUniqueId: string]
	| readonly ["this-form"];
export type EntryPointOwnerKey =
	| readonly ["module", moduleUniqueId: string, slot: "menu" | "case-list"]
	| readonly ["form", xmlns: string];

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
	module(uniqueId: string): ExternalKey {
		return { kind: "module", parts: [uniqueId] };
	},
	form(xmlns: string): ExternalKey {
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
		columnKind: Column["kind"],
		field: string,
		n: number,
	): ExternalKey {
		return {
			kind: "caseListColumn",
			parts: [moduleUniqueId, columnKind, field, ordinal(n)],
		};
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
	formLink(xmlns: string, target: FormLinkTargetKey, n: number): ExternalKey {
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
	return asUuid(
		uuidv5(
			JSON.stringify([HQ_ENTITY_KEY_VERSION, appId, key.kind, ...key.parts]),
			HQ_ENTITY_NAMESPACE_UUID,
		),
	);
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

export interface IdentityResolver {
	/** `place` is where in HQ's app the entity was read, in the finding's place vocabulary. */
	claim(key: ExternalKey, place: string): IdentityClaim;
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
 * A resolver over `uuidOf`, which gives a key not claimed before its UUID.
 * A key claimed twice answers the second claim with the first one's place.
 */
function resolver(uuidOf: (key: ExternalKey) => Uuid): IdentityResolver {
	const claimed = new Map<
		string,
		{ readonly entry: IdentityMapEntry; readonly place: string }
	>();
	return {
		claim(key, place) {
			const text = externalKeyText(key);
			const first = claimed.get(text);
			if (first !== undefined)
				return { ok: false, key, firstPlace: first.place };
			const parts = key.parts.map(copyPart);
			const uuid = uuidOf({ kind: key.kind, parts });
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
	return resolver((key) => mintEntityUuid(appId, key));
}

/** Answers a key `known` holds with its UUID and mints the rest. */
export function matchingResolver(
	appId: string,
	known: readonly IdentityMapEntry[],
): IdentityResolver {
	const byKey = new Map<string, Uuid>();
	const keyOfUuid = new Map<Uuid, string>();
	for (const entry of known) {
		const text = externalKeyText(entry);
		if (byKey.has(text))
			throw new Error(
				`Nova was handed an identity map that holds one ${entry.kind} key twice. A map holds each key once, so each entity it names has one UUID; look at how the map was built from its document.`,
			);
		const other = keyOfUuid.get(entry.uuid);
		if (other !== undefined)
			throw new Error(
				`Nova was handed an identity map that holds the UUID ${entry.uuid} under two keys. One UUID names one entity; look at how the map was built from its document.`,
			);
		byKey.set(text, entry.uuid);
		keyOfUuid.set(entry.uuid, text);
	}
	return resolver(
		(key) => byKey.get(externalKeyText(key)) ?? mintEntityUuid(appId, key),
	);
}
