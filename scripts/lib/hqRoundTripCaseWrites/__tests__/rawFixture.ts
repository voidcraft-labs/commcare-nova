/**
 * A pre-step fixture as the cutover reads it from the database.
 *
 * Each `fixtures/pre-step/<id>.json` is a stored document in the shape
 * `main` persisted (`toPersistableDoc`). The cutover never parses such a
 * document with a schema: it reads the app's carriers, the `apps` root
 * columns as text and one `blueprint_entities` row per entity, through
 * `oldShape.ts::readRawDocument`. This helper lays a fixture out as exactly
 * those carriers, the way `lib/db/blueprintRows.ts::decomposeBlueprint` does
 * (parentage from the order arrays, `ordinal` the array index) but without
 * its head schema parse, which the old shape no longer passes, and hands them
 * to the production reader.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	PersistedBlueprintRootText,
	PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import type { Uuid } from "@/lib/domain";
import {
	RAW_FLAT_COLLECTIONS,
	type RawCarriers,
	type RawDocument,
	readRawDocument,
} from "../oldShape";

export const PRE_STEP = join(import.meta.dirname, "fixtures", "pre-step");

/** Every fixture id the directory holds, in id order. */
export const PRE_STEP_FIXTURE_IDS: readonly string[] = readdirSync(PRE_STEP)
	.filter(
		(name) =>
			name.endsWith(".json") &&
			name !== "facts.json" &&
			name !== "digests.json",
	)
	.map((name) => name.slice(0, -".json".length))
	.sort();

type JsonObject = Record<string, unknown>;

export function readPreStepJson(name: string): unknown {
	return JSON.parse(readFileSync(join(PRE_STEP, name), "utf8"));
}

function textOf(value: unknown): string | null {
	return value === undefined || value === null ? null : JSON.stringify(value);
}

function orderOf(doc: JsonObject, slot: string): readonly string[] {
	const order = doc[slot];
	return Array.isArray(order) ? (order as string[]) : [];
}

function recordsOf(doc: JsonObject, slot: string): Record<string, JsonObject> {
	return (doc[slot] ?? {}) as Record<string, JsonObject>;
}

/** The carriers a stored document's app holds, built from its JSON alone. */
export function carriersOfPersistedDoc(doc: JsonObject): RawCarriers {
	const root: PersistedBlueprintRootText = {
		app_name: doc.appName as string,
		connect_type: (doc.connectType ??
			null) as PersistedBlueprintRootText["connect_type"],
		case_types_text: textOf(doc.caseTypes),
		localization_text: textOf(doc.localization),
		app_settings_text: textOf(doc.appSettings),
		logo: (doc.logo ?? null) as PersistedBlueprintRootText["logo"],
	};
	const rows: PersistedEntityRowText[] = [];
	const row = (
		kind: PersistedEntityRowText["kind"],
		uuid: string,
		parent: string | null,
		ordinal: number,
		data: JsonObject | undefined,
	): void => {
		if (data === undefined)
			throw new Error(
				`The fixture's order names ${kind} ${uuid}, which its records do not hold.`,
			);
		rows.push({
			uuid: uuid as Uuid,
			kind,
			parent_uuid: parent as Uuid | null,
			ordinal,
			data_text: JSON.stringify(data),
		});
	};

	const modules = recordsOf(doc, "modules");
	const forms = recordsOf(doc, "forms");
	const fields = recordsOf(doc, "fields");
	const formOrder = (doc.formOrder ?? {}) as Record<string, string[]>;
	const fieldOrder = (doc.fieldOrder ?? {}) as Record<string, string[]>;
	for (const [index, moduleUuid] of orderOf(doc, "moduleOrder").entries()) {
		row("module", moduleUuid, null, index, modules[moduleUuid]);
		for (const [formIndex, formUuid] of (formOrder[moduleUuid] ?? []).entries())
			row("form", formUuid, moduleUuid, formIndex, forms[formUuid]);
	}
	for (const [parentUuid, children] of Object.entries(fieldOrder))
		for (const [index, fieldUuid] of children.entries())
			row("field", fieldUuid, parentUuid, index, fields[fieldUuid]);
	for (const [kind, slot, orderSlot] of RAW_FLAT_COLLECTIONS) {
		const records = recordsOf(doc, slot);
		for (const [index, uuid] of orderOf(doc, orderSlot).entries())
			row(kind, uuid, null, index, records[uuid]);
	}
	return { root, rows };
}

/** The `RawDocument` the cutover reads for pre-step fixture `id`. */
export function rawFixture(id: string): RawDocument {
	const doc = readPreStepJson(`${id}.json`) as JsonObject;
	return readRawDocument(doc.appId as string, carriersOfPersistedDoc(doc));
}
