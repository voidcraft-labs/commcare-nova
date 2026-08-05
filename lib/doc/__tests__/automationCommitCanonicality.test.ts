import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import {
	type Automation,
	automationMessageText,
	type BlueprintDoc,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const UPDATE_AUTOMATION_UUID = testUuid("canonical-update-automation");
const UPDATE_UUID = testUuid("canonical-update-item");
const CLOSED_PARENT_UUID = testUuid("canonical-closed-parent");
const ALERT_AUTOMATION_UUID = testUuid("canonical-alert-automation");
const RECIPIENT_UUID = testUuid("canonical-alert-recipient");
const EVENT_UUID = testUuid("canonical-alert-event");

function automationDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Automation commit gate",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "workflow_status", label: proseText("Workflow status") },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
							}),
							f({
								kind: "text",
								id: "workflow_status",
								label: proseText("Workflow status"),
								caseWrite: {
									caseType: "patient",
									property: "workflow_status",
								},
							}),
						],
					},
				],
			},
		],
	});
	const updateRule: Automation = {
		uuid: UPDATE_AUTOMATION_UUID,
		kind: "case-update",
		name: "Finish patients",
		caseType: "patient",
		criteriaOperator: "all",
		criteria: [{ uuid: CLOSED_PARENT_UUID, kind: "closed-parent" }],
		setupOnlyCriteria: [],
		updates: [
			{
				uuid: UPDATE_UUID,
				target: { scope: "case", property: "workflow_status" },
				value: { kind: "literal", value: "complete" },
			},
		],
		closeCase: true,
	};
	const alert: Automation = {
		uuid: ALERT_AUTOMATION_UUID,
		kind: "conditional-alert",
		name: "Remind patient",
		caseType: "patient",
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		recipients: [{ uuid: RECIPIENT_UUID, kind: "self" }],
		schedule: {
			kind: "immediate",
			events: [
				{
					uuid: EVENT_UUID,
					minutesToWait: 0,
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
	doc.automations = {
		[UPDATE_AUTOMATION_UUID]: updateRule,
		[ALERT_AUTOMATION_UUID]: alert,
	};
	doc.automationOrder = [UPDATE_AUTOMATION_UUID, ALERT_AUTOMATION_UUID];
	return doc;
}

function expectAutomationRefusal(
	mutations: Mutation[],
	expectedPath: string,
): void {
	const verdict = mutationCommitVerdict(
		automationDoc(),
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok).toBe(false);
	if (verdict.ok) return;
	const findings = verdict.findings.filter(
		(finding) => finding.code === "AUTOMATION_INVALID",
	);
	expect(findings).not.toHaveLength(0);
	expect(findings.map((finding) => finding.details?.path)).toContain(
		expectedPath,
	);
}

describe("automation mutation aggregate canonicality", () => {
	it("refuses the merged result when concurrent valid edits disable close and remove the final update", () => {
		const base = automationDoc();
		const disableClose: Mutation[] = [
			{
				kind: "updateAutomation",
				uuid: UPDATE_AUTOMATION_UUID,
				targetKind: "case-update",
				patch: { closeCase: false },
			},
		];
		const removeUpdate: Mutation[] = [
			{
				kind: "editAutomationItem",
				automationUuid: UPDATE_AUTOMATION_UUID,
				targetKind: "case-update",
				edit: {
					collection: "update",
					operation: "remove",
					uuid: UPDATE_UUID,
				},
			},
		];

		const disabled = mutationCommitVerdict(
			base,
			disableClose,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		const removed = mutationCommitVerdict(
			base,
			removeUpdate,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(disabled.ok).toBe(true);
		expect(removed.ok).toBe(true);
		if (!disabled.ok) return;

		const merged = mutationCommitVerdict(
			disabled.nextDoc,
			removeUpdate,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(merged.ok).toBe(false);
		if (merged.ok) return;
		expect(
			merged.findings
				.filter((finding) => finding.code === "AUTOMATION_INVALID")
				.map((finding) => finding.details?.path),
		).toContain("updates");
	});

	it("refuses removing the final alert recipient", () => {
		expectAutomationRefusal(
			[
				{
					kind: "editAutomationItem",
					automationUuid: ALERT_AUTOMATION_UUID,
					targetKind: "conditional-alert",
					edit: {
						collection: "recipient",
						operation: "remove",
						uuid: RECIPIENT_UUID,
					},
				},
			],
			"recipients",
		);
	});

	it("refuses removing the final scheduled event", () => {
		expectAutomationRefusal(
			[
				{
					kind: "editAutomationItem",
					automationUuid: ALERT_AUTOMATION_UUID,
					targetKind: "conditional-alert",
					edit: {
						collection: "immediate-event",
						operation: "remove",
						uuid: EVENT_UUID,
					},
				},
			],
			"schedule.events",
		);
	});

	it("refuses adding a second singleton condition", () => {
		expectAutomationRefusal(
			[
				{
					kind: "editAutomationItem",
					automationUuid: UPDATE_AUTOMATION_UUID,
					targetKind: "case-update",
					edit: {
						collection: "criterion",
						operation: "add",
						value: {
							uuid: testUuid("canonical-second-closed-parent"),
							kind: "closed-parent",
						},
					},
				},
			],
			"criteria",
		);
	});

	it("refuses adding a duplicate singleton recipient", () => {
		expectAutomationRefusal(
			[
				{
					kind: "editAutomationItem",
					automationUuid: ALERT_AUTOMATION_UUID,
					targetKind: "conditional-alert",
					edit: {
						collection: "recipient",
						operation: "add",
						value: {
							uuid: testUuid("canonical-second-self-recipient"),
							kind: "self",
						},
					},
				},
			],
			"recipients.1",
		);
	});

	it("refuses a granular event addition that violates schedule spacing", () => {
		expectAutomationRefusal(
			[
				{
					kind: "editAutomationItem",
					automationUuid: ALERT_AUTOMATION_UUID,
					targetKind: "conditional-alert",
					edit: {
						collection: "immediate-event",
						operation: "add",
						value: {
							uuid: testUuid("canonical-too-soon-event"),
							minutesToWait: 1,
							content: {
								kind: "sms",
								message: automationMessageText("Still waiting"),
							},
						},
					},
				},
			],
			"schedule.events.1.minutesToWait",
		);
	});

	it("refuses enabling descendant-location settings without a location recipient", () => {
		expectAutomationRefusal(
			[
				{
					kind: "updateAutomation",
					uuid: ALERT_AUTOMATION_UUID,
					targetKind: "conditional-alert",
					patch: { includeDescendantLocations: true },
				},
			],
			"includeDescendantLocations",
		);
	});
});
