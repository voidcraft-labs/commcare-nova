import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	calculatedColumn,
	caseMappingTextUnit,
	columnSort,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	translationUnitsById,
} from "@/lib/domain";
import {
	concat,
	eq,
	literal,
	matchAll,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-case-choice-values";
const uuid = (name: string) => targetedUuid(ID, name);

export function choiceValueColumns() {
	const form = uuid("visit");
	const firstMatch = {
		...idMappingColumn(uuid("area-rule"), "area", "Visit priority", [
			{
				uuid: uuid("east-bank-rule"),
				when: eq(prop("member", "area"), literal("upper east bank")),
				label: "Priority",
			},
			{ uuid: uuid("otherwise-rule"), when: matchAll(), label: "Routine" },
		]),
		behavior: "first-match" as const,
	};
	const word = { uuid: uuid("visit-word"), label: "Visit" };
	const visitLabel = {
		...calculatedColumn(
			uuid("visit-label"),
			"Visit label",
			concat(
				{ kind: "case-text", textUuid: word.uuid },
				term(literal(" ")),
				term(prop("member", "case_name")),
			),
		),
		texts: [word],
	};
	const doc = buildDoc({
		appId: ID,
		appName: "Village visits",
		caseTypes: [
			{
				name: "member",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "area", label: proseText("Area") },
					{
						name: "village",
						label: proseText("Village"),
						data_type: "single_select",
						options: [
							{ value: "a", label: proseText("West") },
							{ value: "z", label: proseText("East") },
						],
					},
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Members",
				caseType: "member",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
					plainColumn(uuid("label"), "village", "Village", {
						sort: columnSort("asc", 1),
					}),
					plainColumn(uuid("code"), "village", "Village code", {
						showChoice: "saved-value",
						sort: columnSort("asc", 0),
					}),
					idMappingColumn(uuid("unassigned"), "area", "Unassigned", [
						idMappingEntry("", "Unassigned"),
					]),
					idMappingColumn(uuid("bank"), "area", "Zone", [
						idMappingEntry("east bank", "River zone"),
					]),
					firstMatch,
					imageMapColumn(uuid("optional-image"), "area", "Visit image", [
						{
							uuid: uuid("blank-image-rule"),
							match: "exact",
							value: "upper east bank",
							altText: "Assigned to east bank",
						},
					]),
					visitLabel,
				]),
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("notes"),
								id: "notes",
								label: proseText("Notes"),
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
		translations: { fra: {} },
	};
	const units = translationUnitsById(doc);
	for (const [index, row] of firstMatch.mapping.entries()) {
		const id = caseMappingTextUnit(firstMatch.uuid, row, "mapping");
		const unit = units.get(id);
		if (!unit) throw new Error(`No translation unit for rule ${index + 1}.`);
		doc.localization.translations.fra[id] = {
			value: index === 0 ? "Urgent" : "Normal",
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	}
	const wordUnit = makeTranslationUnitId(
		"column",
		visitLabel.uuid,
		"calculation-text",
		word.uuid,
	);
	const unit = units.get(wordUnit);
	if (!unit) throw new Error("No translation unit for the visit label.");
	doc.localization.translations.fra[wordUnit] = {
		value: "Visite",
		sourceFingerprint: unit.sourceFingerprint,
		origin: "human",
		review: "reviewed",
		translatedFrom: "eng",
	};
	const restore = restoreXml({
		cases: [
			{
				id: "cv-bea",
				type: "member",
				name: "Bea",
				properties: { village: "z", area: "east banker" },
			},
			{
				id: "cv-ana",
				type: "member",
				name: "Ana",
				properties: { village: "a", area: "upper east bank" },
			},
			{
				id: "cv-cy",
				type: "member",
				name: "Cy",
				properties: { village: "past" },
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["menus-and-case-lists, saved choice values and localized labels"],
		doc,
		expected: {
			intent: [
				...(["local", "A"] as const).flatMap((exportName) =>
					(["en", "fr"] as const).map((locale) => ({
						id: `first-matching-label-${locale}-${exportName}`,
						export: exportName,
						form,
						restore: "restore.xml",
						request: {
							session: { command: "m0-f0" },
							locale,
							caseList: { sortIndex: 6 },
						},
						expect:
							locale === "en"
								? [
										{ pointer: "/caseList/rows/0/caseId", value: "cv-ana" },
										{ pointer: "/caseList/rows/0/fields/5", value: "Priority" },
										{
											pointer: "/caseList/rows/0/fields/7",
											value: "Visit Ana",
										},
										{ pointer: "/caseList/rows/0/fields/6", value: "\u00a0" },
										{ pointer: "/caseList/rows/2/fields/6", value: "" },
										{ pointer: "/caseList/rows/2/fields/5", value: "Routine" },
									]
								: [
										{ pointer: "/caseList/rows/0/fields/5", value: "Normal" },
										{ pointer: "/caseList/rows/2/caseId", value: "cv-ana" },
										{ pointer: "/caseList/rows/2/fields/5", value: "Urgent" },
										{
											pointer: "/caseList/rows/2/fields/7",
											value: "Visite Ana",
										},
									],
					})),
				),
				{
					id: "saved-value-order",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { sortIndex: 3 },
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "cv-ana" },
						{ pointer: "/caseList/rows/0/fields/1", value: "West" },
						{ pointer: "/caseList/rows/0/fields/2", value: "a" },
						{ pointer: "/caseList/rows/0/fields/3", value: "" },
						{ pointer: "/caseList/rows/0/fields/4", value: "River zone" },
						{ pointer: "/caseList/rows/1/fields/3", value: "Unassigned" },
						{ pointer: "/caseList/rows/2/fields/4", value: "" },
						{ pointer: "/caseList/rows/1/fields/1", value: "past" },
						{ pointer: "/caseList/rows/1/fields/2", value: "past" },
						{ pointer: "/caseList/rows/2/caseId", value: "cv-bea" },
					],
				},
				{
					id: "choice-label-order",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { sortIndex: 2 },
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "cv-bea" },
						{ pointer: "/caseList/rows/0/fields/1", value: "East" },
						{ pointer: "/caseList/rows/0/fields/2", value: "z" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
