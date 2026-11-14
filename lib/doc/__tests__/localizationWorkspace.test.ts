import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { wireTable } from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import {
	collectTranslationUnits,
	makeTranslationUnitId,
	proseText,
} from "@/lib/domain";
import { eq, literal, tableColumn, tableLookup } from "@/lib/domain/expression";
import { createLocalizationWorkspace } from "../localizationWorkspace";

const FIELD = testUuid("workspace-name");
const APP_NAME = makeTranslationUnitId("app", "name");
const FIELD_LABEL = makeTranslationUnitId("field", FIELD, "label");

function fixture() {
	const doc = buildDoc({
		appName: "Care visits",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						type: "survey",
						name: "Visit",
						fields: [
							f({
								uuid: FIELD,
								kind: "text",
								id: "first_name",
								label: proseText("First name"),
							}),
						],
					},
				],
			},
		],
	});
	const unit = collectTranslationUnits(doc).find(
		(unit) => unit.id === APP_NAME,
	);
	if (!unit) throw new Error("Missing app-name unit");
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: {
			spa: {
				[APP_NAME]: {
					value: "Visitas",
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		},
	};
	return doc;
}

it("offers the selected target values and status while source values remain available for copying", () => {
	const doc = fixture();
	const view = createLocalizationWorkspace(doc, "spa", "unavailable");
	expect(view.selectedTag).toBe("spa");
	expect(view.selectedUnits.find((unit) => unit.id === APP_NAME)).toMatchObject(
		{ source: "Care visits", effective: "Visitas", status: "ready" },
	);
	expect(
		view.selectedUnits.find((unit) => unit.id === FIELD_LABEL),
	).toMatchObject({
		source: proseText("First name"),
		effective: proseText("First name"),
		status: "missing",
	});
	expect(
		view.unitsForLanguage("eng").find((unit) => unit.id === APP_NAME)
			?.effective,
	).toBe("Care visits");
	expect(view.unitsForLanguage("spa")).toBe(view.selectedUnits);
	expect(doc.appName).toBe("Care visits");
});

it("keeps a snapshot's cache coherent and resolves renamed identities and removed languages in the next snapshot", () => {
	const doc = fixture();
	const before = createLocalizationWorkspace(doc, "spa", "unavailable");
	const reference = { parts: [{ kind: "field-ref" as const, uuid: FIELD }] };
	expect(before.projectValue(reference)).toBe("#form/first_name");
	const changed = structuredClone(doc);
	changed.fields[FIELD].id = "given_name";
	delete changed.localization;
	const after = createLocalizationWorkspace(changed, "spa", "unavailable");
	expect(after.selectedTag).toBe("eng");
	expect(
		after.selectedUnits.find((unit) => unit.id === APP_NAME)?.effective,
	).toBe("Care visits");
	expect(after.projectValue(reference)).toBe("#form/given_name");
	expect(before.projectValue(reference)).toBe("#form/first_name");
	expect(
		before.selectedUnits.find((unit) => unit.id === APP_NAME)?.effective,
	).toBe("Visitas");
});

it("prints a calculated value that reads a data table by the table's current name", () => {
	const doc = fixture();
	const table = wireTable("regions", [
		{ name: "value", type: "text" },
		{ name: "label", type: "text" },
	]);
	const [value, label] = table.columns;
	const field = doc.fields[FIELD];
	if (field.kind !== "text") throw new Error("The fixture's question is text.");
	field.label = {
		parts: [
			{ kind: "text", text: "Region " },
			{
				kind: "value",
				expression: tableLookup(
					table.id,
					label.id,
					eq(tableColumn(table.id, value.id), literal("north")),
				),
			},
		],
	};
	const view = createLocalizationWorkspace(
		doc,
		"spa",
		new Map([[table.id, table]]),
	);
	const unit = view.selectedUnits.find((unit) => unit.id === FIELD_LABEL);
	if (unit === undefined) throw new Error("Missing field-label unit");
	expect(view.projectValue(unit.source, unit)).toBe(
		"Region instance('regions')/regions_list/regions[value = 'north'][1]/label",
	);
});
