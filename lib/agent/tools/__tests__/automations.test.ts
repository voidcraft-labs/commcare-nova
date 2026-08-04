import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import type { ToolExecutionContext } from "@/lib/agent/toolExecutionContext";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import type { Automation, BlueprintDoc } from "@/lib/domain";
import {
	addAutomationsTool,
	getAutomationsTool,
	removeAutomationTool,
	updateAutomationTool,
} from "../automations";

const RULE_UUID = testUuid("tool-automation");
const UPDATE_UUID = testUuid("tool-automation-update");

function makeCtx(): ToolExecutionContext {
	return {
		appId: "app-automations",
		projectId: "project-automations",
		userId: "member",
		runId: "run",
		recordMutations: vi.fn(async (prepared: PreparedMutationCandidate) => ({
			events: [],
			committedDoc: prepared.nextDoc,
		})),
		recordMutationStages: vi.fn(),
		recordConversation: vi.fn(),
		conversionImpact: vi.fn(),
	} as unknown as ToolExecutionContext;
}

function doc(): BlueprintDoc {
	const value = structuredClone(
		makeCanonicalGenesisDoc("Automations", "app-automations"),
	);
	value.caseTypes = [
		{
			name: "visit",
			properties: [
				{
					name: "state",
					label: { parts: [{ kind: "text", text: "State" }] },
					data_type: "text",
				},
			],
		},
	];
	return value;
}

function rule(): Automation {
	return {
		uuid: RULE_UUID,
		kind: "case-update",
		name: "Resolve visits",
		caseType: "visit",
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		runOnSave: false,
		updates: [
			{
				uuid: UPDATE_UUID,
				target: { scope: "case", property: "state" },
				value: { kind: "literal", value: "resolved" },
			},
		],
		closeCase: false,
	};
}

describe("automation shared tools", () => {
	it("adds, reads, granularly updates, and removes the same canonical object", async () => {
		const ctx = makeCtx();
		const added = await addAutomationsTool.execute(
			{ automations: [rule()] },
			ctx,
			doc(),
		);
		if (added.mutations.length === 0) {
			throw new Error(JSON.stringify(added.result));
		}
		expect(added.mutations).toHaveLength(1);
		expect(added.newDoc.automations?.[RULE_UUID]).toEqual(rule());
		const read = await getAutomationsTool.execute({}, ctx, added.newDoc);
		expect(read.data).toEqual([
			expect.objectContaining({
				automation: rule(),
				executesInPreview: false,
				setupGuide: expect.objectContaining({
					requiredPlan: "Data Cleanup (Pro or higher)",
				}),
			}),
		]);

		const beforeUpdate = rule() as Extract<Automation, { kind: "case-update" }>;
		const updatedRule = {
			...beforeUpdate,
			name: "Resolve old visits",
			runOnSave: true,
		} satisfies Automation;
		const updated = await updateAutomationTool.execute(
			{ automation: updatedRule },
			ctx,
			added.newDoc,
		);
		expect(updated.mutations).toEqual([
			expect.objectContaining({
				kind: "updateAutomation",
				uuid: RULE_UUID,
			}),
		]);
		expect(updated.newDoc.automations?.[RULE_UUID]).toEqual(updatedRule);

		const removed = await removeAutomationTool.execute(
			{ automationUuid: RULE_UUID },
			ctx,
			updated.newDoc,
		);
		expect(removed.newDoc.automations).toBeUndefined();
		expect(removed.newDoc.automationOrder).toBeUndefined();
	});

	it("refuses duplicate nested identities and kind changes without saving", async () => {
		const existing = doc();
		existing.automations = { [RULE_UUID]: rule() };
		existing.automationOrder = [RULE_UUID];
		const ctx = makeCtx();
		const duplicate = await addAutomationsTool.execute(
			{
				automations: [
					{
						...rule(),
						uuid: testUuid("tool-automation-second"),
					},
				],
			},
			ctx,
			existing,
		);
		expect(duplicate.mutations).toEqual([]);
		expect(duplicate.result).toHaveProperty("error");

		const changedKind = await updateAutomationTool.execute(
			{
				automation: {
					...rule(),
					kind: "conditional-alert",
					recipients: [{ uuid: testUuid("tool-recipient"), kind: "self" }],
					schedule: {
						kind: "immediate",
						events: [
							{
								uuid: testUuid("tool-event"),
								minutesToWait: 0,
								content: { kind: "sms", message: "Hi" },
							},
						],
					},
					includeDescendantLocations: false,
					locationLevelUuids: [],
					userDataFilters: [],
					useUserCaseForFilter: false,
				},
			},
			ctx,
			existing,
		);
		expect(changedKind.mutations).toEqual([]);
		expect(changedKind.result).toHaveProperty("error");
	});
});
