import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { Automation, BlueprintDoc } from "@/lib/domain";
import { validateAutomations } from "../rules/automations";

function docWithCriterion(
	scope: "case" | "parent" | "host",
	property: string,
	matchType: "has-value" | "equal" | "date-days",
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
				relationship: "child",
				properties: [{ name: "due", label: "Due", data_type: "date" }],
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

describe("automation property criteria validation", () => {
	it("resolves a parent criterion against the declared parent case type", () => {
		expect(
			validateAutomations(docWithCriterion("parent", "state", "has-value")),
		).toEqual([]);
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
					{ name: "case_id", label: "Case ID", data_type: "text" },
					{ name: "case_type", label: "Case type", data_type: "text" },
					{ name: "due", label: "Due", data_type: "date" },
					{ name: "alarm_time", label: "Alarm time", data_type: "time" },
				],
			},
		],
	});
	doc.automations = { [automation.uuid]: automation };
	doc.automationOrder = [automation.uuid];
	return validateAutomations(doc);
}

function alertWithContent(
	message: string,
): Extract<Automation, { kind: "conditional-alert" }> {
	return {
		uuid: testUuid(`validator-alert-${message}`),
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
					content: { kind: "sms", message },
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
		expect(validateOne(alertWithContent("Hello {case.case_name}"))).toEqual([]);
		expect(validateOne(alertWithContent("Type {case.case_type}"))).toEqual([]);
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
		expect(validateOne(alertWithContent("Hello {case.status}"))).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					path: "schedule.events.0.content.message.caseProperty.0",
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
					content: { kind: "sms", message: "Reminder" },
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
	});
});
