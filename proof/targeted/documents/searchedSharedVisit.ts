import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	calculatedColumn,
	columnSort,
	makeTranslationUnitId,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	simpleSearchInputDef,
	translationUnitsById,
} from "@/lib/domain";
import {
	ancestorPath,
	prop,
	relationStep,
	term,
} from "@/lib/domain/expression";
import { chosenCaseId } from "@/lib/domain/expression/chosenCase";
import { caseListOf, targetedDocument, targetedUuid } from "../build";

const id = "targeted-searched-shared-visit";
const uuid = (name: string) => targetedUuid(id, name);

/** A household found in Search leads to a visit through either child menu. */
export function searchedSharedVisit() {
	const households = uuid("households");
	const visits = uuid("visits");
	const clinic = uuid("clinic");
	const region = calculatedColumn(
		uuid("district-region"),
		"District region",
		term(
			prop(
				"household",
				"region",
				ancestorPath(relationStep("parent", "district")),
			),
		),
	);
	const doc = buildDoc({
		appId: id,
		appName: "Household visits",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		caseTypes: [
			{
				name: "district",
				properties: [{ name: "region", label: proseText("Region") }],
			},
			{
				name: "household",
				parent_type: "district",
				properties: [{ name: "cohort", label: proseText("Cohort") }],
			},
			{
				name: "person",
				parent_type: "household",
				properties: [{ name: "visit_note", label: proseText("Visit note") }],
			},
		],
		modules: [
			{
				uuid: households,
				name: "Households",
				caseType: "household",
				caseListConfig: caseListOf(
					[
						plainColumn(uuid("household-name"), "case_name", "Household", {
							sort: columnSort("asc", 0),
						}),
						region,
					],
					{
						searchInputs: [
							simpleSearchInputDef(
								uuid("search-name"),
								"cohort",
								"Cohort",
								"text",
								"cohort",
							),
						],
					},
				),
				forms: [
					{
						uuid: uuid("household-note"),
						name: "Review household",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("household-review"),
								id: "review",
								label: proseText("Review"),
							}),
						],
					},
				],
			},
			{
				uuid: visits,
				name: "Visits",
				caseType: "person",
				caseListConfig: caseListOf([
					plainColumn(uuid("person-name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: uuid("visit"),
						name: "Record visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Visit note"),
								caseWrite: { caseType: "person", property: "visit_note" },
							}),
							f({
								kind: "hidden",
								uuid: uuid("selected-household"),
								id: "selected_household",
								calculate: chosenCaseId(households),
							}),
							f({
								kind: "hidden",
								uuid: uuid("selected-person"),
								id: "selected_person",
								calculate: chosenCaseId(visits),
							}),
						],
					},
				],
			},
			{
				uuid: clinic,
				name: "Clinic",
				caseListConfig: caseListOf([
					plainColumn(uuid("clinic-name"), "case_name", "Name"),
				]),
				forms: [],
			},
		],
	});
	for (const child of [visits, clinic]) {
		doc.modules[child].parentModuleUuid = households;
		doc.modules[child].parentCaseModuleUuid = households;
	}
	doc.modules[clinic].formsFromMenu = { menuUuid: visits };
	const units = translationUnitsById(doc);
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fra" },
		translations: { fra: {} },
	};
	for (const [id, value] of [
		[
			makeTranslationUnitId("column", region.uuid, "header"),
			"Région du district",
		],
		[
			makeTranslationUnitId("search-input", uuid("search-name"), "label"),
			"Cohorte",
		],
	] as const) {
		const unit = units.get(id);
		if (!unit)
			throw new Error("The Search fixture is missing a translation unit.");
		doc.localization.translations.fra[id] = {
			value,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	}
	const edit = structuredClone(doc);
	edit.moduleOrder = [households, clinic, visits];
	return targetedDocument({
		id,
		rows: ["One physical visit through two child menus after a parent search"],
		doc,
		edit,
		expected: { intent: [] },
	});
}
