import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	type Automation,
	automationMessageText,
	type BlueprintDoc,
	effectiveCaseTypes,
	type Form,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { validateAutomations } from "../rules/automations";

const FILTER_USER_PROPERTY_UUID = testUuid("validator-filter-user-property");

function docWithCriterion(
	scope: "case" | "parent" | "host",
	property: string,
	matchType: "has-value" | "equal" | "date-days",
	relationship: "child" | "extension" = "child",
): BlueprintDoc {
	const doc = buildDoc({
		appName: "Automation validation",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "state", label: "State", data_type: "text" }],
			},
			{
				name: "visit",
				parent_type: "household",
				relationship,
				properties: [{ name: "due", label: "Due", data_type: "date" }],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				forms: [{ name: "Follow up", type: "followup" }],
			},
		],
	});
	const uuid = testUuid(`validator-${scope}-${property}-${matchType}`);
	const automation: Automation = {
		uuid,
		kind: "case-update",
		name: "Update related case",
		caseType: "visit",
		criteriaOperator: "all",
		criteria: [
			{
				uuid: testUuid(`criterion-${scope}-${property}-${matchType}`),
				kind: "match-property",
				scope,
				property,
				matchType,
				...(matchType === "date-days"
					? { days: 0 }
					: matchType === "equal"
						? { value: "2026-01-01" }
						: {}),
			},
		],
		setupOnlyCriteria: [],
		updates: [],
		closeCase: true,
	};
	doc.automations = { [uuid]: automation };
	doc.automationOrder = [uuid];
	return doc;
}

function addAdvancedExtensionLink(
	doc: BlueprintDoc,
	identifier = "facility_host",
): void {
	const form = Object.values(doc.forms)[0] as Form | undefined;
	if (form === undefined) throw new Error("expected automation fixture form");
	form.caseOperations = [
		{
			uuid: testUuid(`advanced-extension-${identifier}`),
			id: `link_${identifier}`,
			action: "update",
			caseType: "visit",
			target: { kind: "session" },
			links: [
				{
					identifier,
					targetType: "household",
					target: {
						kind: "expression",
						expr: term(literal("household-case-id")),
					},
					relationship: "extension",
				},
			],
		},
	];
}

describe("automation property criteria validation", () => {
	it("resolves a parent criterion against the declared parent case type", () => {
		expect(
			validateAutomations(docWithCriterion("parent", "state", "has-value")),
		).toEqual([]);
	});

	it("resolves parent criteria and update properties through a canonical extension edge", () => {
		const doc = docWithCriterion("parent", "state", "has-value", "extension");
		const automation = Object.values(doc.automations ?? {})[0];
		if (automation?.kind !== "case-update") {
			throw new Error("expected automatic update");
		}
		automation.updates = [
			{
				uuid: testUuid("validator-extension-parent-update"),
				target: { scope: "parent", property: "state" },
				value: {
					kind: "case-property",
					source: { scope: "parent", property: "state" },
				},
			},
		];
		automation.closeCase = false;

		expect(validateAutomations(doc)).toEqual([]);
	});

	it("keeps alert case.parent templates child-only on an extension case type", () => {
		const doc = docWithCriterion("parent", "state", "has-value", "extension");
		const uuid = testUuid("validator-extension-parent-template");
		const alert: Automation = {
			uuid,
			kind: "conditional-alert",
			name: "Extension template",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [
				{ uuid: testUuid("validator-extension-template-owner"), kind: "owner" },
			],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("validator-extension-template-event"),
						minutesToWait: 0,
						content: {
							kind: "sms",
							message: {
								parts: [
									{
										kind: "case-property",
										scope: "parent",
										caseType: "household",
										property: "state",
									},
								],
							},
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [],
			useUserCaseForFilter: false,
		};
		doc.automations = { [uuid]: alert };
		doc.automationOrder = [uuid];

		expect(validateAutomations(doc)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					path: "schedule.events.0.content.message.parts.0",
				}),
			}),
		]);
	});

	it("rejects a scope with no matching relationship", () => {
		expect(
			validateAutomations(docWithCriterion("host", "state", "has-value")),
		).toEqual([
			expect.objectContaining({
				code: "AUTOMATION_INVALID",
				details: expect.objectContaining({ path: "criteria.0.scope" }),
			}),
		]);
	});

	it("type-checks date comparisons in the related case scope", () => {
		expect(
			validateAutomations(docWithCriterion("parent", "state", "date-days")),
		).toEqual([
			expect.objectContaining({
				code: "AUTOMATION_INVALID",
				details: expect.objectContaining({ path: "criteria.0.matchType" }),
			}),
		]);
	});

	it("accepts projected standard reads and standard datetime date comparisons", () => {
		expect(
			validateAutomations(docWithCriterion("case", "case_name", "has-value")),
		).toEqual([]);
		expect(
			validateAutomations(docWithCriterion("case", "date_opened", "date-days")),
		).toEqual([]);
	});

	it("refuses status and text equality against HQ datetime model fields", () => {
		expect(
			validateAutomations(docWithCriterion("case", "status", "has-value")),
		).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ path: "criteria.0.property" }),
			}),
		]);
		expect(
			validateAutomations(docWithCriterion("case", "date_opened", "equal")),
		).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ path: "criteria.0.matchType" }),
			}),
		]);
	});

	it.each(["case_id", "case_type"])(
		"treats %s as implicit text metadata for automation criteria only",
		(property) => {
			const doc = docWithCriterion("case", property, "has-value");
			const visit = effectiveCaseTypes(doc).find(
				(caseType) => caseType.name === "visit",
			);
			expect(visit?.properties.some((entry) => entry.name === property)).toBe(
				false,
			);
			expect(validateAutomations(doc)).toEqual([]);
		},
	);

	it("refuses every host read when advanced operations can add a second extension", () => {
		const criterionDoc = docWithCriterion(
			"host",
			"state",
			"has-value",
			"extension",
		);
		addAdvancedExtensionLink(criterionDoc);
		expect(validateAutomations(criterionDoc)).toEqual([
			expect.objectContaining({
				message: expect.stringContaining("does not define which extension"),
				details: expect.objectContaining({ path: "criteria.0.scope" }),
			}),
		]);

		const updateDoc = docWithCriterion("case", "due", "has-value", "extension");
		const update = Object.values(updateDoc.automations ?? {})[0];
		if (update?.kind !== "case-update") {
			throw new Error("expected automatic update");
		}
		update.criteria = [];
		update.updates = [
			{
				uuid: testUuid("ambiguous-host-update"),
				target: { scope: "case", property: "due" },
				value: {
					kind: "case-property",
					source: { scope: "host", property: "state" },
				},
			},
		];
		update.closeCase = false;
		addAdvancedExtensionLink(updateDoc);
		expect(validateAutomations(updateDoc)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					path: "updates.0.value.source.scope",
				}),
			}),
		]);

		const templateDoc = docWithCriterion(
			"case",
			"due",
			"has-value",
			"extension",
		);
		const alertUuid = testUuid("ambiguous-host-template-alert");
		templateDoc.automations = {
			[alertUuid]: {
				uuid: alertUuid,
				kind: "conditional-alert",
				name: "Ambiguous host template",
				caseType: "visit",
				criteriaOperator: "all",
				criteria: [],
				setupOnlyCriteria: [],
				recipients: [
					{ uuid: testUuid("ambiguous-host-recipient"), kind: "owner" },
				],
				schedule: {
					kind: "immediate",
					events: [
						{
							uuid: testUuid("ambiguous-host-event"),
							minutesToWait: 0,
							content: {
								kind: "sms",
								message: {
									parts: [
										{
											kind: "case-property",
											scope: "host",
											caseType: "household",
											property: "state",
										},
									],
								},
							},
						},
					],
				},
				includeDescendantLocations: false,
				locationLevelUuids: [],
				userDataFilters: [],
				useUserCaseForFilter: false,
			},
		};
		templateDoc.automationOrder = [alertUuid];
		addAdvancedExtensionLink(templateDoc);
		expect(validateAutomations(templateDoc)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					path: "schedule.events.0.content.message.parts.0.scope",
				}),
			}),
		]);
	});

	it("keeps parent reads and non-ambiguous advanced extension links valid", () => {
		const parentDoc = docWithCriterion(
			"parent",
			"state",
			"has-value",
			"extension",
		);
		addAdvancedExtensionLink(parentDoc);
		expect(validateAutomations(parentDoc)).toEqual([]);

		const canonicalHostDoc = docWithCriterion(
			"host",
			"state",
			"has-value",
			"extension",
		);
		addAdvancedExtensionLink(canonicalHostDoc, "parent");
		expect(validateAutomations(canonicalHostDoc)).toEqual([]);
	});
});

function validateOne(
	automation: Automation,
): ReturnType<typeof validateAutomations> {
	const doc = buildDoc({
		appName: "Automation property slots",
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "due", label: "Due", data_type: "date" },
					{ name: "alarm_time", label: "Alarm time", data_type: "time" },
				],
			},
		],
	});
	doc.userProperties = {
		[FILTER_USER_PROPERTY_UUID]: {
			uuid: FILTER_USER_PROPERTY_UUID,
			slug: "cadre",
			label: "Cadre",
		},
	};
	doc.userPropertyOrder = [FILTER_USER_PROPERTY_UUID];
	doc.automations = { [automation.uuid]: automation };
	doc.automationOrder = [automation.uuid];
	return validateAutomations(doc);
}

function alertWithContent(
	text: string,
	property?: string,
): Extract<Automation, { kind: "conditional-alert" }> {
	return {
		uuid: testUuid(`validator-alert-${text}-${property ?? "literal"}`),
		kind: "conditional-alert",
		name: "Alert",
		caseType: "visit",
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		recipients: [{ uuid: testUuid("validator-alert-owner"), kind: "owner" }],
		schedule: {
			kind: "immediate",
			events: [
				{
					uuid: testUuid("validator-alert-event"),
					minutesToWait: 0,
					content: {
						kind: "sms",
						message:
							property === undefined
								? automationMessageText(text)
								: {
										parts: [
											...(text === "" ? [] : [{ kind: "text" as const, text }]),
											{
												kind: "case-property",
												scope: "case",
												caseType: "visit",
												property,
											},
										],
									},
					},
				},
			],
		},
		includeDescendantLocations: false,
		locationLevelUuids: [],
		userDataFilters: [],
		useUserCaseForFilter: false,
	};
}

describe("automation HQ property-slot compatibility", () => {
	it("validates structural case-property recipient-filter values against dynamic case data", () => {
		const alert = alertWithContent("Reminder");
		alert.userDataFilters = [
			{
				uuid: testUuid("validator-structural-user-filter"),
				userPropertyUuid: FILTER_USER_PROPERTY_UUID,
				values: [
					{ kind: "literal", value: "" },
					{
						kind: "case-property",
						caseType: "visit",
						property: "due",
					},
				],
			},
		];
		expect(validateOne(alert)).toEqual([]);
		const filter = alert.userDataFilters[0];
		if (filter === undefined) throw new Error("missing recipient filter");

		filter.values[1] = {
			kind: "case-property",
			caseType: "household",
			property: "due",
		};
		expect(validateOne(alert)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					path: "userDataFilters.0.values.1.caseType",
				}),
			}),
		]);

		filter.values[1] = {
			kind: "case-property",
			caseType: "visit",
			property: "case_id",
		};
		expect(validateOne(alert)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					path: "userDataFilters.0.values.1",
				}),
			}),
		]);
	});

	it("refuses a scope whose stored case-property identity would be retargeted", () => {
		const alert = alertWithContent("Reminder");
		const content = alert.schedule.events[0]?.content;
		if (content?.kind !== "sms") throw new Error("missing SMS content");
		content.message = {
			parts: [
				{
					kind: "case-property",
					scope: "case",
					caseType: "household",
					property: "case_name",
				},
			],
		};
		expect(validateOne(alert)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					path: "schedule.events.0.content.message.parts.0.caseType",
				}),
			}),
		]);
	});

	it("rejects every HQ-shadowed custom message property in every relationship scope", () => {
		for (const scope of ["case", "parent", "host"] as const) {
			for (const property of ["owner", "host", "last_modified_by"] as const) {
				const relationship = scope === "host" ? "extension" : "child";
				const doc = buildDoc({
					appName: "Shadowed automation template",
					caseTypes: [
						{
							name: "household",
							properties: [
								{ name: property, label: property, data_type: "text" },
							],
						},
						{
							name: "visit",
							parent_type: "household",
							relationship,
							properties: [
								{ name: property, label: property, data_type: "text" },
							],
						},
					],
				});
				const alert = alertWithContent("Reminder");
				const content = alert.schedule.events[0]?.content;
				if (content?.kind !== "sms") throw new Error("missing SMS content");
				content.message = {
					parts: [
						{
							kind: "case-property",
							scope,
							caseType: scope === "case" ? "visit" : "household",
							property,
						},
					],
				};
				doc.automations = { [alert.uuid]: alert };
				doc.automationOrder = [alert.uuid];

				expect(validateAutomations(doc)).toEqual([
					expect.objectContaining({
						message: expect.stringContaining(`“${property}” is shadowed`),
						details: expect.objectContaining({
							path: "schedule.events.0.content.message.parts.0.property",
						}),
					}),
				]);
			}
		}
	});

	it("accepts projected update and template properties", () => {
		const update: Automation = {
			uuid: testUuid("validator-update-case-name"),
			kind: "case-update",
			name: "Rename",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: testUuid("validator-update-case-name-row"),
					target: { scope: "case", property: "case_name" },
					value: {
						kind: "case-property",
						source: { scope: "case", property: "external_id" },
					},
				},
			],
			closeCase: false,
		};
		expect(validateOne(update)).toEqual([]);
		expect(validateOne(alertWithContent("Hello ", "case_name"))).toEqual([]);
		expect(validateOne(alertWithContent("ID ", "case_id"))).toEqual([]);
		expect(validateOne(alertWithContent("Type ", "case_type"))).toEqual([]);

		for (const property of ["case_id", "case_type"] as const) {
			const metadataSource: Automation = {
				...update,
				uuid: testUuid(`validator-read-${property}`),
				updates: [
					{
						uuid: testUuid(`validator-read-${property}-row`),
						target: { scope: "case", property: "due" },
						value: {
							kind: "case-property",
							source: { scope: "case", property },
						},
					},
				],
			};
			expect(validateOne(metadataSource)).toEqual([]);

			const recipient = alertWithContent("Reminder");
			recipient.recipients = [
				{
					uuid: testUuid(`validator-recipient-${property}`),
					kind: "case-property-user-id",
					property,
				},
			];
			expect(validateOne(recipient)).toEqual([]);
		}
	});

	it("refuses unrepresentable update and template standard properties", () => {
		const update: Automation = {
			uuid: testUuid("validator-update-status"),
			kind: "case-update",
			name: "Set status",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: testUuid("validator-update-status-row"),
					target: { scope: "case", property: "status" },
					value: { kind: "literal", value: "closed" },
				},
			],
			closeCase: false,
		};
		expect(validateOne(update)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ path: "updates.0.target" }),
			}),
		]);
		const caseTypeUpdate: Automation = {
			...update,
			uuid: testUuid("validator-update-case-type"),
			updates: [
				{
					uuid: testUuid("validator-update-case-type-row"),
					target: { scope: "case", property: "case_type" },
					value: { kind: "literal", value: "archived_visit" },
				},
			],
		};
		expect(validateOne(caseTypeUpdate)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ path: "updates.0.target" }),
			}),
		]);
		const caseIdUpdate: Automation = {
			...update,
			uuid: testUuid("validator-update-case-id"),
			updates: [
				{
					uuid: testUuid("validator-update-case-id-row"),
					target: { scope: "case", property: "case_id" },
					value: { kind: "literal", value: "replacement-id" },
				},
			],
		};
		expect(validateOne(caseIdUpdate)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ path: "updates.0.target" }),
			}),
		]);
		expect(validateOne(alertWithContent("Hello ", "status"))).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					path: "schedule.events.0.content.message.parts.1",
				}),
			}),
		]);
	});

	it("uses model-field reads for dates but limits dynamic-only alert slots", () => {
		const alert = alertWithContent("Reminder");
		alert.schedule = {
			kind: "timed",
			repeatEvery: 1,
			totalIterations: 1,
			startOffsetDays: 0,
			startDayOfWeek: -1,
			start: { kind: "case-property", property: "date_opened" },
			events: [
				{
					uuid: testUuid("validator-timed-event"),
					day: 0,
					timing: { kind: "case-property-time", property: "alarm_time" },
					content: {
						kind: "sms",
						message: automationMessageText("Reminder"),
					},
				},
			],
		};
		alert.stopDateCaseProperty = "date_opened";
		expect(validateOne(alert)).toEqual([]);

		alert.resetCaseProperty = "case_name";
		expect(validateOne(alert)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ path: "resetCaseProperty" }),
			}),
		]);

		alert.resetCaseProperty = "case_id";
		expect(validateOne(alert)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ path: "resetCaseProperty" }),
			}),
		]);

		alert.resetCaseProperty = "case_type";
		expect(validateOne(alert)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ path: "resetCaseProperty" }),
			}),
		]);

		alert.resetCaseProperty = "unknown_property";
		expect(validateOne(alert)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ path: "resetCaseProperty" }),
			}),
		]);

		delete alert.resetCaseProperty;
		alert.stopDateCaseProperty = "alarm_time";
		expect(validateOne(alert)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ path: "stopDateCaseProperty" }),
			}),
		]);
	});
});
