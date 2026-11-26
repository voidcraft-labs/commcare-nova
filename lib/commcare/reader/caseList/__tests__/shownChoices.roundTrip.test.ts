/** A property can supply independently ordered stored tokens and translated labels to the same list.
 * The labels its column shows are a native source of catalog choices. A raw column preserves
 * writer-derived choices and keeps its identity across an HQ layout edit. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import {
	type BlueprintDoc,
	type CaseProperty,
	casePropertyOptionTranslationUnitId,
	plainColumn,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import { type ProseTemplate, proseText } from "@/lib/domain/prose";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";
import { comparableList } from "./listReading";

const SELECT = testUuid("shown-select");
const WELL = testUuid("shown-well");
const SICK = testUuid("shown-sick");
const COLUMN = testUuid("shown-column");

const choiceUnit = (option: string) =>
	makeTranslationUnitId("field", SELECT, "option", option);
const propertyUnit = (value: string) =>
	casePropertyOptionTranslationUnitId("patient", "condition_level", value);

/** A menu whose list shows `condition_level`, which one select question writes ("Well",
 *  "Sick"), the catalog giving it `options`; English, then Spanish, with `spanish` translations. */
function patients(
	options: CaseProperty["options"] | undefined,
	spanish: ReadonlyMap<TranslationUnitId, string>,
): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{
						name: "condition_level",
						label: proseText("Status"),
						...(options !== undefined && {
							data_type: "single_select" as const,
							options,
						}),
					},
				],
			},
		],
		modules: [
			{
				uuid: testUuid("shown-menu"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [plainColumn(COLUMN, "condition_level", "Status")],
					searchInputs: [],
				},
				forms: [
					{
						uuid: testUuid("shown-form"),
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "single_select",
								id: "condition_level",
								uuid: SELECT,
								optionsSource: {
									kind: "inline",
									options: [
										{ value: "well", label: proseText("Well"), uuid: WELL },
										{ value: "sick", label: proseText("Sick"), uuid: SICK },
									],
								},
								caseWrite: { caseType: "patient", property: "condition_level" },
							}),
						],
					},
				],
			},
		],
	});
	const units = translationUnitsById(doc);
	const entries: Record<TranslationUnitId, TranslationEntry> = {};
	for (const [unitId, text] of spanish) {
		const unit = units.get(unitId);
		if (unit === undefined) throw new Error(`The document holds no ${unitId}.`);
		entries[unitId] = {
			value: proseText(text),
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	}
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: { spa: entries },
	};
	return doc;
}

const option = (value: string, label: string) => ({
	value,
	label: proseText(label),
});

function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** The property's catalog entry, the Spanish the document holds, and the menu's list. */
function shownFacts(doc: BlueprintDoc) {
	const module = doc.modules[doc.moduleOrder[0] ?? ""];
	return {
		property: doc.caseTypes
			?.find((type) => type.name === "patient")
			?.properties.find((one) => one.name === "condition_level"),
		spanish: Object.fromEntries(
			Object.entries(doc.localization?.translations.spa ?? {}).map(
				([unit, entry]) => [unit, (entry?.value as ProseTemplate) ?? null],
			),
		),
		list:
			module?.caseListConfig === undefined
				? undefined
				: comparableList(module.caseListConfig),
	};
}

async function readBack(
	doc: BlueprintDoc,
	modules?: (modules: Record<string, unknown>[]) => Record<string, unknown>[],
) {
	return readHqApp(
		await inputFor(
			exportedBody(doc, modules === undefined ? {} : { modules }),
			{
				resolver: matchingResolver(
					"app-1",
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				recordDialect: recordDialectRoundTrip,
			},
		),
	);
}

async function expectReadsBack(doc: BlueprintDoc): Promise<void> {
	const outcome = await readBack(doc);
	expect(outcome.defects).toEqual([]);
	expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	if (outcome.kind !== "read") return;
	expect(shownFacts(outcome.draft.doc)).toEqual(shownFacts(canonical(doc)));
}

describe("a plain column over a property select questions write", () => {
	it("keeps the label and saved value columns' identities after HQ changes their order", async () => {
		const doc = patients(
			[option("well", "Well"), option("sick", "Sick")],
			new Map(),
		);
		const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
		if (!config) throw new Error("Expected the patient list.");
		const raw = plainColumn(
			testUuid("shown-raw"),
			"condition_level",
			"Status",
			{ showChoice: "saved-value" },
		);
		config.columns.push(raw);
		config.listColumnOrder.push(raw.uuid);
		config.detailColumnOrder.push(raw.uuid);
		const answer = await readBack(doc, (modules) =>
			modules.map((module) => {
				const pair = module.case_details as {
					short: { columns: unknown[] };
					long: { columns: unknown[] };
				};
				pair.short.columns.reverse();
				pair.long.columns.reverse();
				return module;
			}),
		);
		expect(answer.defects).toEqual([]);
		expect(answer.kind === "account" ? answer.findings : []).toEqual([]);
		expect(answer.kind).toBe("read");
		if (answer.kind !== "read") return;
		const read = answer.draft.doc;
		expect(
			read.modules[read.moduleOrder[0]].caseListConfig?.columns,
		).toMatchObject([
			{ uuid: raw.uuid, showChoice: "saved-value" },
			{ uuid: COLUMN },
		]);
	});

	it("reads the labels' translations from the column, not from the select's choices", async () => {
		await expectReadsBack(
			patients(
				[option("well", "Well"), option("sick", "Sick")],
				new Map([
					[choiceUnit(WELL), "Bien"],
					[choiceUnit(SICK), "Enfermo"],
				]),
			),
		);
	});

	it("reads the labels' own translations where they differ from the select's", async () => {
		await expectReadsBack(
			patients(
				[option("well", "Well"), option("sick", "Sick")],
				new Map([
					[choiceUnit(WELL), "Bien"],
					[propertyUnit("well"), "Sano"],
					[propertyUnit("sick"), "Enfermo"],
				]),
			),
		);
	});

	it("reads the labels and the choices the column shows, where they differ from the select's", async () => {
		await expectReadsBack(
			patients(
				[option("sick", "Unwell"), option("well", "Doing well")],
				new Map(),
			),
		);
	});

	it("keeps a raw display when the reading rediscovers choices from the writer", async () => {
		const doc = patients(undefined, new Map([[choiceUnit(WELL), "Bien"]]));
		await expectReadsBack(doc);
		const outcome = await readBack(doc);
		if (outcome.kind !== "read") return;
		expect(
			shownFacts(outcome.draft.doc).property?.options?.map((one) => one.value),
		).toEqual(["well", "sick"]);
	});

	it("keeps raw values and translated labels as separate columns over the same property", async () => {
		const doc = patients(
			[option("well", "Well"), option("sick", "Sick")],
			new Map(),
		);
		const outcome = await readBack(doc, (modules) =>
			modules.map((module) => {
				const details = module.case_details as {
					long: { columns: Record<string, unknown>[] };
				};
				details.long.columns = details.long.columns.map((column) => ({
					...column,
					field: "condition_level",
					useXpathExpression: false,
					format: "plain",
					enum: [],
				}));
				return module;
			}),
		);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("read");
		if (outcome.kind !== "read") return;
		const read = outcome.draft.doc;
		const columns = read.modules[read.moduleOrder[0]].caseListConfig?.columns;
		expect(columns).toMatchObject([
			{ kind: "plain", field: "condition_level", visibleInDetail: false },
			{
				kind: "plain",
				field: "condition_level",
				showChoice: "saved-value",
				notOnList: true,
			},
		]);
		await expectReadsBack(read);
	});
});
