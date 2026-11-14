/**
 * Calculated values in text (`targeted-prose-value`).
 *
 * A follow-up form of households, in English and Spanish, whose texts hold
 * prose `value` parts: the date chip HQ's form builder draws for
 * `format-date(date(x), '<pattern>')` (Vellum `richText.js::extractXPathInfo`),
 * a `concat` of literals with spaces, a comparison with `<` and `>` in an
 * `if`, a string literal holding `"` and `&`, a lookup table read, a hint, a
 * help text and a choice label each holding a value, a validation message
 * holding a formatted date and one holding a value beside a reference, a
 * value in a repeat reading its own row, a Spanish label that moves its value,
 * and a label whose literal text is `instance('casedb')`. Each value is an
 * `<output value>` with the shadow a reference's output carries
 * (`lib/commcare/xform/builder.ts::buildLabelNodes`). The document declares
 * both platforms.
 *
 * What the lane reads here: HQ's form builder saving the form twice and the
 * outputs it keeps (proof 4), HQ's build of it (proof 2), and each runtime's
 * reading of the labels. The native family `expression` reads the same
 * calculated values through Core (`ProseValueRuntimeTest`).
 *
 * Fixed values: the visit date the worker gives is the value the form holds,
 * over a restore holding the household and the region table.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	type ProseTemplate,
	plainColumn,
	proseText,
	translationUnitsById,
} from "@/lib/domain";
import {
	type Expression,
	eq,
	literal,
	tableColumn,
	tableLookup,
} from "@/lib/domain/expression";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

const ID = "targeted-prose-value";
const uuid = (name: string) => targetedUuid(ID, name);
const REGIONS = "regions";
const FORMATTED_VISIT = "format-date(date(#form/visit), '%e %b %Y')";
const HOUSEHOLD = "targeted-household";

/** A calculated value, its expression as form text or as a tree, which the
 *  fixture parses in the text's prose slot. */
const value = (expression: Expression | string) =>
	({ kind: "value", expression }) as const;

function spanishLabel(doc: BlueprintDoc, field: string, label: ProseTemplate) {
	const unitId = makeTranslationUnitId("field", uuid(field), "label");
	const unit = translationUnitsById(doc).get(unitId);
	if (unit === undefined)
		throw new Error(`${ID} has no label unit for ${field}.`);
	return {
		[unitId]: {
			value: label,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human" as const,
			review: "reviewed" as const,
			translatedFrom: "eng" as const,
		},
	};
}

export function proseValue() {
	const table = wireTable(REGIONS, [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const [code, name] = table.columns;
	if (code === undefined || name === undefined)
		throw new Error(`The ${REGIONS} table has no code and name columns.`);
	const rows = [wireRow(table, "north", { code: "north", name: "Northland" })];
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "Household visits",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Households",
				caseType: "household",
				caseListConfig: caseListOf([
					plainColumn(uuid("name-column"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "date",
								uuid: uuid("visit"),
								id: "visit",
								label: proseText("Visit date"),
							}),
							f({
								kind: "text",
								uuid: uuid("name"),
								id: "name",
								label: proseText("Who did you meet?"),
							}),
							f({
								kind: "int",
								uuid: uuid("age"),
								id: "age",
								label: proseText("Age"),
							}),
							f({
								kind: "label",
								uuid: uuid("summary"),
								id: "summary",
								label: {
									parts: [
										{ kind: "text", text: "Visit on " },
										value(FORMATTED_VISIT),
									],
								},
							}),
							f({
								kind: "label",
								uuid: uuid("greeting"),
								id: "greeting",
								label: {
									parts: [value("concat('Seen ', #form/name, ' today')")],
								},
							}),
							f({
								kind: "label",
								uuid: uuid("age_band"),
								id: "age_band",
								label: {
									parts: [
										value(
											"if(#form/age < 5 and #form/age > 1, 'young', 'older')",
										),
									],
								},
							}),
							f({
								kind: "label",
								uuid: uuid("quoted"),
								id: "quoted",
								label: { parts: [value(`concat('say "hi" & bye', '')`)] },
							}),
							f({
								kind: "label",
								uuid: uuid("region"),
								id: "region",
								label: {
									parts: [
										{ kind: "text", text: "Region: " },
										value(
											tableLookup(
												table.id,
												name.id,
												eq(tableColumn(table.id, code.id), literal("north")),
											),
										),
									],
								},
							}),
							f({
								kind: "single_select",
								uuid: uuid("colour"),
								id: "colour",
								label: proseText("Door colour"),
								hint: { parts: [value("concat(#form/name, '?')")] },
								help: {
									parts: [
										{ kind: "text", text: "Seen " },
										value(FORMATTED_VISIT),
									],
								},
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: uuid("red"),
											value: "red",
											label: {
												parts: [value("concat('Red for ', #form/name)")],
											},
										},
										{
											uuid: uuid("blue"),
											value: "blue",
											label: proseText("Blue"),
										},
									],
								},
							}),
							f({
								kind: "int",
								uuid: uuid("rooms"),
								id: "rooms",
								label: proseText("Rooms"),
								validate: ". > 0",
								validate_msg: { parts: [value(FORMATTED_VISIT)] },
							}),
							f({
								kind: "int",
								uuid: uuid("people"),
								id: "people",
								label: proseText("People"),
								validate: ". > 0",
								validate_msg: {
									parts: [
										{ kind: "field-ref", uuid: uuid("name") },
										{ kind: "text", text: " on " },
										value(FORMATTED_VISIT),
									],
								},
							}),
							f({
								kind: "repeat",
								uuid: uuid("items"),
								id: "items",
								repeat_mode: "user_controlled",
								label: proseText("Items"),
								children: [
									f({
										kind: "text",
										uuid: uuid("item"),
										id: "item",
										label: proseText("Item"),
									}),
									f({
										kind: "label",
										uuid: uuid("item_echo"),
										id: "item_echo",
										label: { parts: [value("concat(../item, '!')")] },
									}),
								],
							}),
							f({
								kind: "label",
								uuid: uuid("instance_text"),
								id: "instance_text",
								label: proseText(
									"This text reads instance('casedb') as words.",
								),
							}),
						],
					},
				],
			},
		],
	});
	// The Spanish label moves the English label's value to its front.
	const summary = doc.fields[uuid("summary")];
	const moved =
		summary !== undefined && "label" in summary
			? summary.label?.parts[1]
			: undefined;
	if (moved?.kind !== "value")
		throw new Error(`${ID}'s summary label holds no calculated value.`);
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: {
			spa: spanishLabel(doc, "summary", {
				parts: [moved, { kind: "text", text: " es la visita" }],
			}),
		},
	};
	return targetedDocument({
		id: ID,
		rows: ["questions, a calculated value in text"],
		doc,
		lookup: {
			projectId: "project-targeted-prose-value",
			projectRevision: parseLookupRevision("1"),
			definitions: [table],
			rowsByTable: new Map([[table.id, rows]]),
		},
		expected: {
			intent: [
				{
					...answerHeld(
						"visit-held",
						form,
						"/data/visit",
						"2026-03-04",
						"local",
						{ command: "m0-f0", caseId: HOUSEHOLD },
					),
					restore: "restore.xml",
				},
			],
		},
		files: {
			"restore.xml": restoreXml({
				cases: [{ id: HOUSEHOLD, type: "household", name: "Mensah" }],
				tables: [
					{
						tag: REGIONS,
						fields: ["code", "name"],
						rows: [["north", "Northland"]],
					},
				],
			}),
		},
	});
}
