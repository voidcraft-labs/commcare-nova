import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationTargetsInvalid } from "@/lib/db/commitGuard";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { mutationIdentityAdmissionIssue } from "@/lib/doc/mutationIdentityAdmission";
import type { Mutation } from "@/lib/doc/types";
import { type Automation, automationMessageText } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

function fixture() {
	const doc = buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								id: "status",
								label: proseText("Status"),
								options: [
									{ value: "open", label: proseText("Open") },
									{ value: "closed", label: proseText("Closed") },
								],
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const fieldUuid = doc.fieldOrder[formUuid][0];
	const field = doc.fields[fieldUuid];
	if (!("optionsSource" in field) || field.optionsSource.kind !== "inline") {
		throw new Error("select fixture missing");
	}
	return {
		doc,
		moduleUuid,
		formUuid,
		fieldUuid,
		optionUuid: field.optionsSource.options[0].uuid,
		columnUuid:
			doc.modules[moduleUuid].caseListConfig?.columns[0]?.uuid ??
			testUuid("missing-column"),
	};
}

function expectRejected(
	doc: ReturnType<typeof fixture>["doc"],
	batch: Mutation[],
) {
	const issue = mutationIdentityAdmissionIssue(doc, batch);
	expect(issue).toBeDefined();
	expect(mutationTargetsInvalid(doc, batch)).toBe(true);
	const verdict = mutationCommitVerdict(doc, batch, LOOKUP_CONTEXT_UNAVAILABLE);
	expect(verdict.ok).toBe(false);
	if (verdict.ok) return;
	expect(verdict.findings.map((finding) => finding.code)).toEqual([
		"MUTATION_IDENTITY_COLLISION",
	]);
}

function alertFixture() {
	const fx = fixture();
	const automationUuid = testUuid("identity-alert");
	const eventUuid = testUuid("identity-alert-event");
	const automation: Automation = {
		uuid: automationUuid,
		kind: "conditional-alert",
		name: "Patient reminder",
		caseType: "patient",
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		recipients: [{ uuid: testUuid("identity-alert-recipient"), kind: "owner" }],
		schedule: {
			kind: "immediate",
			events: [
				{
					uuid: eventUuid,
					minutesToWait: 5,
					content: {
						kind: "sms",
						message: automationMessageText("Please follow up"),
					},
				},
			],
		},
		includeDescendantLocations: false,
		locationLevelUuids: [],
		userDataFilters: [],
		useUserCaseForFilter: false,
	};
	fx.doc.automations = { [automationUuid]: automation };
	fx.doc.automationOrder = [automationUuid];
	return { ...fx, automation, automationUuid, eventUuid };
}

describe("mutation identity admission", () => {
	it("rejects replacing an existing entity through an add with the same UUID", () => {
		const fx = fixture();
		expectRejected(fx.doc, [
			{
				kind: "addModule",
				module: {
					uuid: fx.moduleUuid,
					id: "replacement",
					name: "Replacement",
				},
			},
		]);
	});

	it("rejects a UUID already owned by a different authored kind", () => {
		const fx = fixture();
		expectRejected(fx.doc, [
			{
				kind: "addField",
				parentUuid: fx.formUuid,
				field: {
					uuid: fx.columnUuid,
					kind: "text",
					id: "collision",
					label: proseText("Collision"),
				},
			},
		]);
	});

	it("checks nested identities inside a newly added entity", () => {
		const fx = fixture();
		const config = structuredClone(
			fx.doc.modules[fx.moduleUuid].caseListConfig,
		);
		if (config === undefined) throw new Error("config fixture missing");
		config.columns[0].uuid = fx.fieldUuid;
		config.listColumnOrder = [fx.fieldUuid];
		config.detailColumnOrder = [fx.fieldUuid];
		expectRejected(fx.doc, [
			{
				kind: "addModule",
				module: {
					uuid: testUuid("nested-identity-module"),
					id: "nested_identity",
					name: "Nested identity",
					caseListConfig: config,
				},
			},
		]);
	});

	it("rejects two creators that predeclare the same UUID in one batch", () => {
		const fx = fixture();
		const shared = testUuid("same-batch-collision");
		expectRejected(fx.doc, [
			{
				kind: "addModule",
				module: { uuid: shared, id: "new_module", name: "New module" },
			},
			{
				kind: "addForm",
				moduleUuid: fx.moduleUuid,
				form: {
					uuid: shared,
					id: "new_form",
					name: "New form",
					type: "survey",
				},
			},
		]);
	});

	it("does not make a deleted identity reusable inside the same batch", () => {
		const fx = fixture();
		expectRejected(fx.doc, [
			{ kind: "removeModule", uuid: fx.moduleUuid },
			{
				kind: "addModule",
				module: {
					uuid: fx.moduleUuid,
					id: "reborn",
					name: "Reborn",
				},
			},
		]);
	});

	it("accepts distinct predeclared identities", () => {
		const fx = fixture();
		const moduleUuid = testUuid("distinct-module");
		const formUuid = testUuid("distinct-form");
		const batch: Mutation[] = [
			{
				kind: "addModule",
				module: { uuid: moduleUuid, id: "distinct", name: "Distinct" },
			},
			{
				kind: "addForm",
				moduleUuid,
				form: {
					uuid: formUuid,
					id: "distinct_form",
					name: "Distinct form",
					type: "survey",
				},
			},
		];
		expect(mutationIdentityAdmissionIssue(fx.doc, batch)).toBeUndefined();
		expect(mutationTargetsInvalid(fx.doc, batch)).toBe(false);
	});

	it("requires newly seeded inline options to use new identities", () => {
		const fx = fixture();
		expectRejected(fx.doc, [
			{
				kind: "convertField",
				uuid: fx.fieldUuid,
				toKind: "multi_select",
				optionsSource: {
					kind: "inline",
					options: [
						{
							uuid: fx.optionUuid,
							value: "open",
							label: proseText("Open"),
						},
						{
							uuid: testUuid("fresh-option"),
							value: "other",
							label: proseText("Other"),
						},
					],
				},
			},
		]);
	});

	it("allows an atomic option-source replacement to preserve its own option identities", () => {
		const fx = fixture();
		const field = fx.doc.fields[fx.fieldUuid];
		if (!("optionsSource" in field) || field.optionsSource.kind !== "inline") {
			throw new Error("select fixture missing");
		}
		const batch: Mutation[] = [
			{
				kind: "updateField",
				uuid: fx.fieldUuid,
				targetKind: "single_select",
				patch: {
					optionsSource: {
						kind: "inline",
						options: field.optionsSource.options.map((option) => ({
							...option,
							label: proseText(`Updated ${option.value}`),
						})),
					},
				},
			},
		];

		expect(mutationIdentityAdmissionIssue(fx.doc, batch)).toBeUndefined();
	});

	it("still rejects a duplicate option identity within one atomic replacement", () => {
		const fx = fixture();
		expectRejected(fx.doc, [
			{
				kind: "updateField",
				uuid: fx.fieldUuid,
				targetKind: "single_select",
				patch: {
					optionsSource: {
						kind: "inline",
						options: [
							{
								uuid: fx.optionUuid,
								value: "first",
								label: proseText("First"),
							},
							{
								uuid: fx.optionUuid,
								value: "second",
								label: proseText("Second"),
							},
						],
					},
				},
			},
		]);
	});

	it("does not let a removeOption plus whole-source update recreate that UUID", () => {
		const fx = fixture();
		const field = fx.doc.fields[fx.fieldUuid];
		if (!("optionsSource" in field) || field.optionsSource.kind !== "inline") {
			throw new Error("select fixture missing");
		}
		const batch: Mutation[] = [
			{
				kind: "removeOption",
				fieldUuid: fx.fieldUuid,
				uuid: fx.optionUuid,
			},
			{
				kind: "updateField",
				uuid: fx.fieldUuid,
				targetKind: "single_select",
				patch: { optionsSource: structuredClone(field.optionsSource) },
			},
		];

		expectRejected(fx.doc, batch);
		expect(mutationIdentityAdmissionIssue(fx.doc, batch)).toMatchObject({
			mutationIndex: 1,
			uuid: fx.optionUuid,
		});
	});

	it("does not let consecutive whole-source updates reintroduce an omitted option UUID", () => {
		const fx = fixture();
		const field = fx.doc.fields[fx.fieldUuid];
		if (!("optionsSource" in field) || field.optionsSource.kind !== "inline") {
			throw new Error("select fixture missing");
		}
		const [omitted, retained] = field.optionsSource.options;
		if (omitted === undefined || retained === undefined) {
			throw new Error("select fixture needs two options");
		}
		const batch: Mutation[] = [
			{
				kind: "updateField",
				uuid: fx.fieldUuid,
				targetKind: "single_select",
				patch: {
					optionsSource: {
						kind: "inline",
						options: [
							retained,
							{
								uuid: testUuid("identity-option-replacement-one"),
								value: "pending",
								label: proseText("Pending"),
							},
						],
					},
				},
			},
			{
				kind: "updateField",
				uuid: fx.fieldUuid,
				targetKind: "single_select",
				patch: {
					optionsSource: {
						kind: "inline",
						options: [
							omitted,
							{
								uuid: testUuid("identity-option-replacement-two"),
								value: "unknown",
								label: proseText("Unknown"),
							},
						],
					},
				},
			},
		];

		expect(mutationIdentityAdmissionIssue(fx.doc, batch)).toMatchObject({
			mutationIndex: 1,
			uuid: omitted.uuid,
		});
	});

	it("does not let a removed schedule event return through setAutomationSchedule", () => {
		const fx = alertFixture();
		if (fx.automation.schedule.kind !== "immediate") {
			throw new Error("alert fixture needs an immediate schedule");
		}
		const batch: Mutation[] = [
			{
				kind: "editAutomationItem",
				automationUuid: fx.automationUuid,
				targetKind: "conditional-alert",
				edit: {
					collection: "immediate-event",
					operation: "remove",
					uuid: fx.eventUuid,
				},
			},
			{
				kind: "setAutomationSchedule",
				uuid: fx.automationUuid,
				schedule: structuredClone(fx.automation.schedule),
			},
		];

		expectRejected(fx.doc, batch);
		expect(mutationIdentityAdmissionIssue(fx.doc, batch)).toMatchObject({
			mutationIndex: 1,
			uuid: fx.eventUuid,
		});
	});

	it("allows one schedule replacement to preserve its current event identities", () => {
		const fx = alertFixture();
		if (fx.automation.schedule.kind !== "immediate") {
			throw new Error("alert fixture needs an immediate schedule");
		}
		const event = fx.automation.schedule.events[0];
		if (event === undefined) throw new Error("alert fixture needs an event");

		expect(
			mutationIdentityAdmissionIssue(fx.doc, [
				{
					kind: "setAutomationSchedule",
					uuid: fx.automationUuid,
					schedule: {
						kind: "immediate",
						events: [{ ...event, minutesToWait: 15 }],
					},
				},
			]),
		).toBeUndefined();
	});

	it("does not let consecutive schedule replacements reintroduce an omitted event UUID", () => {
		const fx = alertFixture();
		if (fx.automation.schedule.kind !== "immediate") {
			throw new Error("alert fixture needs an immediate schedule");
		}
		const replacementEvent = {
			uuid: testUuid("identity-alert-replacement-event"),
			minutesToWait: 10,
			content: {
				kind: "sms" as const,
				message: automationMessageText("A replacement reminder"),
			},
		};
		const batch: Mutation[] = [
			{
				kind: "setAutomationSchedule",
				uuid: fx.automationUuid,
				schedule: { kind: "immediate", events: [replacementEvent] },
			},
			{
				kind: "setAutomationSchedule",
				uuid: fx.automationUuid,
				schedule: structuredClone(fx.automation.schedule),
			},
		];

		expect(mutationIdentityAdmissionIssue(fx.doc, batch)).toMatchObject({
			mutationIndex: 1,
			uuid: fx.eventUuid,
		});
	});
});
