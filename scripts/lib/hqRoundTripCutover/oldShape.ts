/**
 * The one reader of the pre-step stored document shape.
 *
 * The cutover reads an app's persisted carriers (the `apps` root columns and
 * its `blueprint_entities` rows) as JSON data, exactly as
 * `lib/db/persistedJson.ts` reads them, and assembles the record and order
 * slots from `(kind, parent_uuid, ordinal)` as
 * `lib/db/blueprintRows.ts::assembleBlueprint` does, stopping where that
 * function hands its result to `blueprintDocSchema`. No schema of the tree
 * ever reads a `RawDocument`: the old schema leaves the tree once the stack
 * lands, and the proof of the transform's output is the new schema and the
 * new gate.
 *
 * It checks only what the transform and the matcher rely on: every row's data
 * is an object, a form row hangs under a module, a field row under a form or a
 * field, and a module or flat row has no parent.
 */

import type {
	PersistedBlueprintRootText,
	PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export type Json =
	| null
	| boolean
	| number
	| string
	| readonly Json[]
	| { readonly [key: string]: Json };
export type JsonRecord = { readonly [key: string]: Json };

/**
 * The flat app-level collections of `lib/db/blueprintRows.ts`, by row kind:
 * the document slot each kind's records live in and the slot of its order.
 */
export const RAW_FLAT_COLLECTIONS = [
	["user_property", "userProperties", "userPropertyOrder"],
	["user_type", "userTypes", "userTypeOrder"],
	["persona", "personas", "personaOrder"],
	["organization_level", "organizationLevels", "organizationLevelOrder"],
	["location_property", "locationProperties", "locationPropertyOrder"],
	["automation", "automations", "automationOrder"],
] as const;

type FlatSlot = (typeof RAW_FLAT_COLLECTIONS)[number][1];
type FlatOrderSlot = (typeof RAW_FLAT_COLLECTIONS)[number][2];

/** The pre-step field kinds whose rows hold children. */
export const RAW_CONTAINER_KINDS: ReadonlySet<string> = new Set([
	"group",
	"repeat",
	"section",
]);

/** The persisted document as `PersistableDoc`'s keys, assembled through no schema. */
export interface RawDocument {
	readonly appName: string;
	readonly connectType: string | null;
	/** `apps.case_types` as stored; null where the column is NULL. */
	readonly caseTypes: Json;
	/** `apps.localization` as stored; null where the column is NULL. */
	readonly localization: Json;
	readonly logo: string | null;
	/** Absent until a step writes it. */
	readonly appSettings?: JsonRecord;
	readonly modules: Readonly<Record<string, JsonRecord>>;
	readonly forms: Readonly<Record<string, JsonRecord>>;
	readonly fields: Readonly<Record<string, JsonRecord>>;
	readonly moduleOrder: readonly string[];
	readonly formOrder: Readonly<Record<string, readonly string[]>>;
	readonly fieldOrder: Readonly<Record<string, readonly string[]>>;
	/* Each flat collection of `lib/db/blueprintRows.ts`: its records by uuid
	 * and its order array, both empty where the app holds none. */
	readonly userProperties: Readonly<Record<string, JsonRecord>>;
	readonly userPropertyOrder: readonly string[];
	readonly userTypes: Readonly<Record<string, JsonRecord>>;
	readonly userTypeOrder: readonly string[];
	readonly personas: Readonly<Record<string, JsonRecord>>;
	readonly personaOrder: readonly string[];
	readonly organizationLevels: Readonly<Record<string, JsonRecord>>;
	readonly organizationLevelOrder: readonly string[];
	readonly locationProperties: Readonly<Record<string, JsonRecord>>;
	readonly locationPropertyOrder: readonly string[];
	readonly automations: Readonly<Record<string, JsonRecord>>;
	readonly automationOrder: readonly string[];
}

/** The persisted carriers of one app as the cutover read them. */
export interface RawCarriers {
	readonly root: PersistedBlueprintRootText;
	readonly rows: readonly PersistedEntityRowText[];
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ENTITY_KINDS: ReadonlySet<string> = new Set([
	"module",
	"form",
	"field",
	...RAW_FLAT_COLLECTIONS.map(([kind]) => kind),
]);

/**
 * Read one app's carriers into a `RawDocument`. A row that breaks the
 * topology the assembly relies on throws, naming the app and the row.
 */
export function readRawDocument(
	appId: string,
	carriers: RawCarriers,
): RawDocument {
	const { root, rows } = carriers;
	const fail = (row: PersistedEntityRowText, reason: string): never => {
		throw new Error(
			`App ${appId} holds a stored ${row.kind} row ${row.uuid} that ${reason}, so the cutover cannot read its document.`,
		);
	};
	const parsed = rows.map((row) => {
		if (!ENTITY_KINDS.has(row.kind)) fail(row, "has an unknown kind");
		const data = parsePersistedJsonText(
			row.data_text,
			`blueprint_entities.data for app ${appId}, entity ${row.uuid}`,
		);
		if (!isRecord(data)) fail(row, "holds no JSON object");
		return { row, data: data as JsonRecord };
	});
	const moduleUuids = new Set(
		parsed
			.filter(({ row }) => row.kind === "module")
			.map(({ row }) => row.uuid),
	);
	const formUuids = new Set(
		parsed.filter(({ row }) => row.kind === "form").map(({ row }) => row.uuid),
	);
	const fieldUuids = new Set(
		parsed.filter(({ row }) => row.kind === "field").map(({ row }) => row.uuid),
	);
	const byOrdinal = (
		a: { row: PersistedEntityRowText },
		b: { row: PersistedEntityRowText },
	) => a.row.ordinal - b.row.ordinal;

	const modules: Record<string, JsonRecord> = {};
	const forms: Record<string, JsonRecord> = {};
	const fields: Record<string, JsonRecord> = {};
	const moduleRows: typeof parsed = [];
	const formsByModule = new Map<string, typeof parsed>();
	const fieldsByParent = new Map<string, typeof parsed>();
	const flatRows = new Map<string, typeof parsed>();

	for (const entry of parsed) {
		const { row, data } = entry;
		if (row.kind === "module") {
			if (row.parent_uuid !== null) fail(row, "has a parent row");
			modules[row.uuid] = data;
			moduleRows.push(entry);
		} else if (row.kind === "form") {
			if (row.parent_uuid === null || !moduleUuids.has(row.parent_uuid))
				fail(row, "hangs under no module");
			if (typeof data.uuid !== "string") fail(row, "holds no uuid");
			forms[row.uuid] = data;
			const list = formsByModule.get(row.parent_uuid as string) ?? [];
			list.push(entry);
			formsByModule.set(row.parent_uuid as string, list);
		} else if (row.kind === "field") {
			if (
				row.parent_uuid === null ||
				!(formUuids.has(row.parent_uuid) || fieldUuids.has(row.parent_uuid))
			)
				fail(row, "hangs under no form or field");
			if (typeof data.kind !== "string") fail(row, "holds no kind");
			fields[row.uuid] = data;
			const list = fieldsByParent.get(row.parent_uuid as string) ?? [];
			list.push(entry);
			fieldsByParent.set(row.parent_uuid as string, list);
		} else {
			if (row.parent_uuid !== null) fail(row, "has a parent row");
			const list = flatRows.get(row.kind) ?? [];
			list.push(entry);
			flatRows.set(row.kind, list);
		}
	}

	moduleRows.sort(byOrdinal);
	const formOrder: Record<string, string[]> = {};
	for (const [moduleUuid, list] of formsByModule) {
		formOrder[moduleUuid] = [...list]
			.sort(byOrdinal)
			.map(({ row }) => row.uuid);
	}
	const fieldOrder: Record<string, string[]> = {};
	for (const [parentUuid, list] of fieldsByParent) {
		fieldOrder[parentUuid] = [...list]
			.sort(byOrdinal)
			.map(({ row }) => row.uuid);
	}
	// The reducer keeps an order key for every module, form and container,
	// empty when it has no children; the assembly seeds the same keys.
	for (const { row } of moduleRows) formOrder[row.uuid] ??= [];
	for (const uuid of Object.keys(forms)) fieldOrder[uuid] ??= [];
	for (const [uuid, field] of Object.entries(fields)) {
		if (RAW_CONTAINER_KINDS.has(field.kind as string)) fieldOrder[uuid] ??= [];
	}

	const flat = Object.fromEntries(
		RAW_FLAT_COLLECTIONS.flatMap(([kind, slot, orderSlot]) => {
			const list = [...(flatRows.get(kind) ?? [])].sort(byOrdinal);
			return [
				[
					slot,
					Object.fromEntries(list.map(({ row, data }) => [row.uuid, data])),
				],
				[orderSlot, list.map(({ row }) => row.uuid)],
			];
		}),
	) as Pick<RawDocument, FlatSlot | FlatOrderSlot>;

	return {
		appName: root.app_name,
		connectType: root.connect_type,
		caseTypes:
			root.case_types_text === null
				? null
				: (parsePersistedJsonText(
						root.case_types_text,
						`apps.case_types for app ${appId}`,
					) as Json),
		localization:
			root.localization_text === null || root.localization_text === undefined
				? null
				: (parsePersistedJsonText(
						root.localization_text,
						`apps.localization for app ${appId}`,
					) as Json),
		logo: root.logo,
		...(root.app_settings_text !== null &&
			root.app_settings_text !== undefined && {
				appSettings: readAppSettings(appId, root.app_settings_text),
			}),
		modules,
		forms,
		fields,
		moduleOrder: moduleRows.map(({ row }) => row.uuid),
		formOrder,
		fieldOrder,
		...flat,
	};
}

/** A stored `apps.app_settings`, which only step `app-settings` writes. */
function readAppSettings(appId: string, text: string): JsonRecord {
	const value = parsePersistedJsonText(
		text,
		`apps.app_settings for app ${appId}`,
	);
	if (!isRecord(value)) {
		throw new Error(
			`App ${appId} stores app settings that are not an object, so the cutover cannot read its document.`,
		);
	}
	return value;
}

/** `AppPlan.baseDigest` and `targetDigest`: the canonical digest of a raw document. */
export function rawDocumentDigest(document: RawDocument): string {
	return canonicalJsonDigest(document);
}

/**
 * The object `blueprintDocSchema` parses for a raw document: the keys
 * `assembleBlueprint` builds, a flat collection and its order omitted when it
 * is empty, and `localization`, `logo` and `appSettings` omitted when absent.
 */
export function rawDocumentAssembly(
	appId: string,
	document: RawDocument,
): Record<string, unknown> {
	const flatSlots: Record<string, unknown> = {};
	for (const [, slot, orderSlot] of RAW_FLAT_COLLECTIONS) {
		if (document[orderSlot].length === 0) continue;
		flatSlots[slot] = document[slot];
		flatSlots[orderSlot] = document[orderSlot];
	}
	return {
		appId,
		appName: document.appName,
		connectType: document.connectType,
		caseTypes: document.caseTypes,
		...(document.localization !== null && {
			localization: document.localization,
		}),
		...(document.appSettings !== undefined && {
			appSettings: document.appSettings,
		}),
		modules: document.modules,
		forms: document.forms,
		fields: document.fields,
		moduleOrder: document.moduleOrder,
		formOrder: document.formOrder,
		fieldOrder: document.fieldOrder,
		...(document.logo !== null && { logo: document.logo }),
		...flatSlots,
	};
}

/**
 * A deep, writable copy of a raw document for one transform run: every step
 * mutates its own copy and never the document the plan read.
 */
export function copyRawDocument(document: RawDocument): RawDocument {
	return structuredClone(document) as RawDocument;
}
