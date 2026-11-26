// lib/commcare/wireIdentity.ts
//
// The ids CommCare HQ holds for Nova's menus and forms, and each form's
// `xmlns`. Each is a pure function of the Nova entity's UUID, so two exports
// of one document carry the same ids, a republish keeps every id HQ stores,
// and a newer `.ccz` keeps every form's identity on a phone. Nothing is drawn
// and nothing is stored beside the document.
//
// The derivation is HQ's own shape: a menu's and a form's `unique_id` are 32
// lower case hex (`models/modules.py::ModuleBase.get_or_create_unique_id`),
// and a form's `xmlns` is `http://openrosa.org/formdesigner/` followed by an
// upper case hyphenated UUID (`util.py::generate_xmlns`). Nova's UUIDs are
// canonical lower case (`lib/domain/uuid.ts::uuidSchema`), and no two Nova
// apps share an entity UUID.
//
// A project space can hold ids that are not the derivation, for a deployment
// made before Nova derived them. The deployment ledger records exactly those
// (`app_deployment_identities`), and `targetWireIdentity` lays them over the
// derivation. The row shape is declared here because `lib/commcare` imports
// nothing from `lib/deployment`.
//
// A case list column over a property CommCare HQ names by two words is kept
// under the word its column stores (`suite/wire.ts::hqColumnFieldText`), which
// HQ's build names the column's app strings by. A target holds the word only
// where it is not the one Nova writes, and the identity carries it, so every
// place that writes the column's field, its sort element or its app string ids
// writes one word.

import type { Form, Uuid } from "@/lib/domain";

/** A case list column's screen in CommCare HQ: the list (`short`) or the detail (`long`). */
export type ColumnScreen = "short" | "long";

/**
 * The word a target keeps a column's property under on one screen, where it
 * holds one (`WireIdentity.columnFieldWord`), which every column field, hidden
 * field, sort element and app string id of the column writes.
 */
export type ColumnFieldWordOf = (
	columnUuid: Uuid,
	screen: ColumnScreen,
) => string | undefined;

/** A service chosen for one app on one project space. The same logical
 * search can have a different integer on every destination. */
export interface ProjectSearchBinding {
	readonly searchUuid: Uuid;
	readonly endpointId: number;
}

/** The ids one export writes for every menu and form, and the word each case list column's field names its property by. */
export interface WireIdentity {
	/** Any module of the emission plan, the hidden menu included. */
	moduleUniqueId(moduleUuid: Uuid): string;
	formUniqueId(formUuid: Uuid): string;
	formXmlns(form: Form): string;
	/**
	 * The word CommCare HQ keeps the property of the column `columnUuid` under
	 * on `screen`, where a target holds one; undefined where the column takes
	 * the word Nova writes (`suite/wire.ts::hqColumnFieldText`).
	 */
	readonly columnFieldWord: ColumnFieldWordOf;
	readonly projectSearchId?: (uuid: Uuid) => number | undefined;
}

const XMLNS_PREFIX = "http://openrosa.org/formdesigner/";

/** The entity's UUID with its hyphens removed: 32 lower case hex, HQ's own shape. */
export function derivedUniqueId(uuid: Uuid): string {
	return uuid.replaceAll("-", "");
}

/** `http://openrosa.org/formdesigner/${uuid.toUpperCase()}`, HQ's own shape. */
export function derivedFormXmlns(uuid: Uuid): string {
	return `${XMLNS_PREFIX}${uuid.toUpperCase()}`;
}

/** Every id derived from its entity's UUID. */
export const DERIVED_WIRE_IDENTITY: WireIdentity = {
	moduleUniqueId: derivedUniqueId,
	formUniqueId: derivedUniqueId,
	formXmlns: (form) => derivedFormXmlns(form.uuid),
	columnFieldWord: () => undefined,
};

/** The word a target keeps one case list column's property under on one screen. */
export interface ColumnFieldWordRow {
	readonly columnUuid: string;
	readonly screen: ColumnScreen;
	readonly word: string;
}

/** One id a target holds that is not the derivation. */
export interface WireIdentityOverride {
	readonly entityKind: "module" | "form";
	readonly novaEntityUuid: string;
	readonly uniqueId: string | null;
	/** Forms only. */
	readonly xmlns: string | null;
}

/**
 * A target's overrides first, the derivation for every entity without one.
 * The fallback is per entity and per field: a form row that holds HQ's
 * `xmlns` and no `unique_id` gives that `xmlns` beside the derived id. Each of
 * `columnWords` is the word of its column on its screen.
 */
export function targetWireIdentity(
	overrides: readonly WireIdentityOverride[],
	columnWords: readonly ColumnFieldWordRow[] = [],
	searchBindings: readonly ProjectSearchBinding[] = [],
): WireIdentity {
	const searchIds = new Map(
		searchBindings.map((row) => [row.searchUuid, row.endpointId]),
	);
	const search = searchIds.size
		? { projectSearchId: (id: Uuid) => searchIds.get(id) }
		: {};
	const words = new Map(
		columnWords.map((row) => [
			`${row.columnUuid}\u0000${row.screen}`,
			row.word,
		]),
	);
	const columnFieldWord = (columnUuid: Uuid, screen: ColumnScreen) =>
		words.get(`${columnUuid}\u0000${screen}`);
	if (overrides.length === 0)
		return words.size === 0 && searchIds.size === 0
			? DERIVED_WIRE_IDENTITY
			: { ...DERIVED_WIRE_IDENTITY, columnFieldWord, ...search };
	const moduleIds = new Map<string, string>();
	const formIds = new Map<string, string>();
	const formXmlns = new Map<string, string>();
	for (const override of overrides) {
		if (override.entityKind === "module") {
			if (override.uniqueId !== null) {
				moduleIds.set(override.novaEntityUuid, override.uniqueId);
			}
			continue;
		}
		if (override.uniqueId !== null) {
			formIds.set(override.novaEntityUuid, override.uniqueId);
		}
		if (override.xmlns !== null) {
			formXmlns.set(override.novaEntityUuid, override.xmlns);
		}
	}
	return {
		moduleUniqueId: (moduleUuid) =>
			moduleIds.get(moduleUuid) ?? derivedUniqueId(moduleUuid),
		formUniqueId: (formUuid) =>
			formIds.get(formUuid) ?? derivedUniqueId(formUuid),
		formXmlns: (form) =>
			formXmlns.get(form.uuid) ?? derivedFormXmlns(form.uuid),
		columnFieldWord,
		...search,
	};
}
