import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema, type Uuid } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../validator/runner";
export function admitNestedDoc(
	doc: BlueprintDoc,
	lookup: LookupValidationContext = LOOKUP_CONTEXT_UNAVAILABLE,
) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, lookup);
	if (findings.length) throw new Error(JSON.stringify(findings, null, 2));
}
export function nestSecondModule(doc: BlueprintDoc): {
	root: Uuid;
	child: Uuid;
	childForm?: Uuid;
} {
	const [root, child] = doc.moduleOrder;
	if (root === undefined || child === undefined) {
		throw new Error("nested-menu fixture needs two modules");
	}
	doc.modules[child].parentModuleUuid = root;
	return { root, child, childForm: doc.formOrder[child]?.[0] };
}

export function followupNestedDoc(
	options: {
		readonly sameCaseType?: boolean;
		readonly parentSelect?: boolean;
		readonly caseListOnly?: boolean;
		readonly parentFirstSurvey?: boolean;
		readonly parentCreatesChild?: boolean;
		readonly childPostSubmitPrevious?: boolean;
		readonly childFilter?: boolean;
	} = {},
): BlueprintDoc {
	const childType = options.sameCaseType ? "gold-fish" : "guppy";
	const doc = buildDoc({
		appName: "Nested care",
		caseTypes: [
			{
				name: "gold-fish",
				properties: [{ name: "care_status", label: proseText("Status") }],
			},
			...(options.sameCaseType
				? []
				: [
						{
							name: "guppy",
							...(options.parentSelect && { parent_type: "gold-fish" }),
							properties: [
								{ name: "care_status", label: proseText("Status") },
								{ name: "case_name", label: proseText("Name") },
							],
						},
					]),
		],
		modules: [
			{
				name: "Parents",
				caseType: "gold-fish",
				caseListConfig: caseListConfig([
					{ field: "care_status", header: "Status" },
				]),
				forms: [
					...(options.parentFirstSurvey
						? [
								{
									name: "Parent survey",
									type: "survey" as const,
									fields: [f({ kind: "text", id: "survey_note" })],
								},
							]
						: []),
					{
						name: "Parent visit",
						type: "followup",
						fields: options.parentCreatesChild
							? [
									f({
										kind: "text",
										id: "child_name",
										label: proseText("Child name"),
										caseWrite: {
											caseType: childType,
											property: "case_name",
										},
									}),
								]
							: [f({ kind: "text", id: "parent_note" })],
					},
				],
			},
			{
				name: "Child care",
				caseType: childType,
				caseListOnly: options.caseListOnly,
				caseListConfig: {
					...caseListConfig([{ field: "care_status", header: "Status" }]),
					...(options.childFilter !== false && {
						filter: eq(prop(childType, "care_status"), literal("active")),
					}),
				},
				forms: options.caseListOnly
					? []
					: [
							{
								name: "Child visit",
								type: "followup",
								...(options.childPostSubmitPrevious && {
									postSubmit: "previous" as const,
								}),
								displayCondition: eq(
									prop(childType, "care_status"),
									literal("active"),
								),
								fields: [
									f({
										kind: "hidden",
										id: "copied_status",
										calculate: `#${childType}/care_status`,
									}),
								],
							},
						],
			},
		],
	});
	nestSecondModule(doc);
	admitNestedDoc(doc);
	return doc;
}

export function registrationNestedDoc(createsChild = false): BlueprintDoc {
	const doc = buildDoc({
		appName: "Nested registration",
		caseTypes: [
			{ name: "plan", properties: [] },
			{
				name: "service",
				parent_type: "plan",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			...(createsChild
				? [{ name: "task", parent_type: "service", properties: [] }]
				: []),
		],
		modules: [
			{
				name: "Plans",
				caseType: "plan",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Plan visit",
						type: "followup",
						fields: [f({ kind: "text", id: "plan_note" })],
					},
				],
			},
			{
				name: "Services",
				caseType: "service",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Create service",
						type: "registration",
						postSubmit: "previous",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: {
									caseType: "service",
									property: "case_name",
								},
							}),
							...(createsChild
								? [
										f({
											kind: "text",
											id: "task_name",
											caseWrite: { caseType: "task", property: "case_name" },
										}),
									]
								: []),
						],
					},
				],
			},
			...(createsChild
				? [
						{
							name: "Tasks",
							caseType: "task",
							caseListOnly: true,
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Name" },
							]),
							forms: [],
						},
					]
				: []),
		],
	});
	nestSecondModule(doc);
	admitNestedDoc(doc);
	return doc;
}

export function sameTypeFormlessRootDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Shared case menu",
		caseTypes: [
			{
				name: "gold-fish",
				properties: [{ name: "care_status", label: proseText("Status") }],
			},
		],
		modules: [
			{
				name: "All fish",
				caseType: "gold-fish",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "care_status", header: "Status" },
				]),
				forms: [],
			},
			{
				name: "Fish care",
				caseType: "gold-fish",
				caseListConfig: caseListConfig([
					{ field: "care_status", header: "Status" },
				]),
				forms: [
					{
						name: "Fish visit",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								id: "copied_status",
								calculate: "#gold-fish/care_status",
							}),
						],
					},
				],
			},
		],
	});
	nestSecondModule(doc);
	admitNestedDoc(doc);
	return doc;
}

/** A form over several cases has shared answers; scalar case reads are invalid. */
export function setSharedFormAnswers(doc: BlueprintDoc, moduleUuid: Uuid) {
	for (const formUuid of doc.formOrder[moduleUuid]) {
		const form = doc.forms[formUuid];
		delete form.displayCondition;
		for (const fieldUuid of doc.fieldOrder[formUuid]) {
			const field = doc.fields[fieldUuid];
			if (field.kind === "hidden")
				field.calculate = {
					parts: [{ kind: "text", text: "'shared answer'" }],
				};
		}
	}
}
export const nestedMenuScenarios = [
	"different",
	"same",
	"same-bare",
	"same-multiple",
	"same-smaller",
	"parent",
	"parent-multiple",
	"previous",
	"registration",
	"registration-children",
] as const;
export function nestedMenuWireFixture(
	scenario: (typeof nestedMenuScenarios)[number],
) {
	const doc = scenario.startsWith("registration")
		? registrationNestedDoc(scenario === "registration-children")
		: scenario.startsWith("same-") && scenario !== "same-smaller"
			? sameTypeFormlessRootDoc()
			: followupNestedDoc({
					sameCaseType: scenario === "same" || scenario === "same-smaller",
					parentSelect:
						scenario === "parent" ||
						scenario === "parent-multiple" ||
						scenario === "previous",
					parentCreatesChild: scenario === "previous",
					childPostSubmitPrevious: scenario === "previous",
					childFilter: scenario !== "previous",
				});
	if (scenario === "same-multiple" || scenario === "parent-multiple") {
		for (const uuid of doc.moduleOrder) {
			const config = doc.modules[uuid].caseListConfig;
			if (!config) throw new Error("Missing nested case list");
			config.selection = { kind: "multiple", maximum: 5 };
		}
	}
	if (scenario === "same-multiple" || scenario === "parent-multiple")
		setSharedFormAnswers(doc, doc.moduleOrder[1]);
	if (scenario === "same-smaller") {
		for (const [index, uuid] of doc.moduleOrder.entries()) {
			const config = doc.modules[uuid].caseListConfig;
			if (!config) throw new Error("Missing nested case list");
			config.selection = { kind: "multiple", maximum: index === 0 ? 5 : 4 };
			setSharedFormAnswers(doc, uuid);
		}
	}
	admitNestedDoc(doc);
	return doc;
}
