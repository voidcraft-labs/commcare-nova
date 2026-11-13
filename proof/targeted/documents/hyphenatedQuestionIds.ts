/**
 * Question IDs holding hyphens (`targeted-hyphenated-question-ids`).
 *
 * A question ID follows HQ's form builder's grammar, hyphen included
 * (`lib/domain/questionId.ts::QUESTION_ID_PATTERN`): the builder itself
 * writes `copy-1-of-<id>` when a person duplicates a question. Three names
 * Nova derives from IDs rested on an ID holding no hyphen, and this document
 * holds a question beside each name a hyphen could make collide:
 *
 * - an itext id is the field's path joined with `-`, so the group `a`
 *   holding `b-c` and the group `a-b` holding `c` would share one, and each
 *   is labelled differently in two languages, so a shared id shows as two
 *   equal labels on a reader;
 * - an option's itext id is `<field>-opt<i>-label`, beside the question
 *   `mood-opt0`;
 * - Preview names a query repeat's wrapper `<id>.query`, beside the question
 *   `kin-query`.
 *
 * It also holds every generated node a hyphenated owner names: the trimmed
 * case name `first-name` gives, the count of the repeat `visit-rows` whose
 * count is an expression, and the lifted count of the validation on
 * `copy-1-of-age`; a calculation `#form/copy-1-of-age - 1`, a minus a reader
 * must not read into the name; a default that reads `current()/../first-name`;
 * and a label that shows `first-name`.
 *
 * The edit renames `first-name` to `given-name` and the group `a-b` to
 * `a-b2`, so a reader left reading a hyphenated path shows in proof 5.
 *
 * Fixed values: the registration, opened as its menu's registration, holds
 * the name as answered under its question's path.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-hyphenated-question-ids";
const uuid = (name: string) => targetedUuid(ID, name);

/** The French entries of `texts`, each over its unit's current source. */
function frenchEntries(
	doc: BlueprintDoc,
	texts: ReadonlyMap<TranslationUnitId, string>,
): Record<TranslationUnitId, TranslationEntry> {
	const units = translationUnitsById(doc);
	const entries: Record<TranslationUnitId, TranslationEntry> = {};
	for (const [unitId, value] of texts) {
		const unit = units.get(unitId);
		if (unit === undefined)
			throw new Error(
				`${ID} names the translation unit ${unitId}, which it does not hold.`,
			);
		entries[unitId] = {
			value: proseText(value),
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	}
	return entries;
}

/** The app before the edit, and after it (`edited`): `first-name` renamed `given-name`, the group `a-b` renamed `a-b2`. */
function hyphenatedApp(edited: boolean): BlueprintDoc {
	const name = edited ? "given-name" : "first-name";
	const pairGroup = edited ? "a-b2" : "a-b";
	const doc = buildDoc({
		appId: ID,
		appName: "Hyphenated questions",
		caseTypes: [
			{
				name: "client",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Clients",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(uuid("name-column"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: uuid("register"),
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("first-name"),
								id: name,
								label: proseText("First name"),
								caseWrite: { caseType: "client", property: "case_name" },
							}),
							f({
								kind: "int",
								uuid: uuid("copy-1-of-age"),
								id: "copy-1-of-age",
								label: proseText("Age"),
								validate: ". >= count(#form/visit-rows[visit-note != ''])",
							}),
							f({
								kind: "text",
								uuid: uuid("a-"),
								id: "a-",
								label: proseText("A note"),
							}),
							f({
								kind: "group",
								uuid: uuid("a"),
								id: "a",
								label: proseText("First group"),
								children: [
									f({
										kind: "text",
										uuid: uuid("b-c"),
										id: "b-c",
										label: proseText("In the first group"),
									}),
								],
							}),
							f({
								kind: "group",
								uuid: uuid("a-b"),
								id: pairGroup,
								label: proseText("Second group"),
								children: [
									f({
										kind: "text",
										uuid: uuid("c"),
										id: "c",
										label: proseText("In the second group"),
									}),
								],
							}),
							f({
								kind: "single_select",
								uuid: uuid("mood"),
								id: "mood",
								label: proseText("Mood"),
								options: [
									{
										uuid: `targeted:${ID}:mood-calm`,
										value: "calm",
										label: "Calm",
									},
									{
										uuid: `targeted:${ID}:mood-tired`,
										value: "tired",
										label: "Tired",
									},
								],
							}),
							f({
								kind: "text",
								uuid: uuid("mood-opt0"),
								id: "mood-opt0",
								label: proseText("Anything else about the mood"),
							}),
							f({
								kind: "repeat",
								uuid: uuid("visit-rows"),
								id: "visit-rows",
								label: proseText("Visit"),
								repeat_mode: "count_bound",
								repeat_count: "int(#form/copy-1-of-age div 10)",
								children: [
									f({
										kind: "text",
										uuid: uuid("visit-note"),
										id: "visit-note",
										label: proseText("Visit note"),
									}),
								],
							}),
							f({
								kind: "repeat",
								uuid: uuid("kin"),
								id: "kin",
								label: proseText("Relative"),
								repeat_mode: "query_bound",
								data_source: { ids_query: "'kin-1 kin-2'" },
								children: [
									f({
										kind: "hidden",
										uuid: uuid("kin-id"),
										id: "kin-id",
										calculate: "current()/../@id",
									}),
								],
							}),
							f({
								kind: "text",
								uuid: uuid("kin-query"),
								id: "kin-query",
								label: proseText("Who else to ask"),
							}),
							f({
								kind: "hidden",
								uuid: uuid("age-before"),
								id: "age-before",
								calculate: "#form/copy-1-of-age - 1",
							}),
							f({
								kind: "text",
								uuid: uuid("called"),
								id: "called",
								label: proseText("Called"),
								default_value: `current()/../${name}`,
							}),
							f({
								kind: "label",
								uuid: uuid("greeting"),
								id: "greeting",
								label: `Hello {{${name}}}`,
							}),
						],
					},
					{
						uuid: uuid("visit"),
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("visit-summary"),
								id: "visit-summary",
								label: proseText("Summary"),
							}),
						],
					},
				],
			},
		],
	});
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fr" },
		translations: {
			fra: frenchEntries(
				doc,
				new Map([
					[
						makeTranslationUnitId("field", uuid("a"), "label"),
						"Premier groupe",
					],
					[
						makeTranslationUnitId("field", uuid("b-c"), "label"),
						"Dans le premier groupe",
					],
					[
						makeTranslationUnitId("field", uuid("a-b"), "label"),
						"Deuxième groupe",
					],
					[
						makeTranslationUnitId("field", uuid("c"), "label"),
						"Dans le deuxième groupe",
					],
				]),
			),
		},
	};
	return doc;
}

export function hyphenatedQuestionIds() {
	return targetedDocument({
		id: ID,
		rows: ["names, a question ID holding a hyphen"],
		doc: hyphenatedApp(false),
		edit: hyphenatedApp(true),
		expected: {
			intent: [
				answerHeld(
					"name-held",
					uuid("register"),
					"/data/first-name",
					"Ada",
					"local",
					{
						command: "m0-f0",
						data: { case_id_new_client_0: "targeted-new-client" },
					},
				),
			],
		},
	});
}
