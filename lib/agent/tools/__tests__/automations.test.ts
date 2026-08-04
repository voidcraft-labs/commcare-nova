import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import type { ToolExecutionContext } from "@/lib/agent/toolExecutionContext";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import type { Automation, BlueprintDoc } from "@/lib/domain";

const mocks = vi.hoisted(() => ({
	readOrganization: vi.fn(),
	readAuthoring: vi.fn(),
}));

vi.mock("@/lib/organization/service", () => ({
	readOrganization: mocks.readOrganization,
	readOrganizationAuthoringSnapshot: mocks.readAuthoring,
}));

import {
	addAutomationsInputSchema,
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

beforeEach(() => {
	vi.clearAllMocks();
});

describe("automation shared tools", () => {
	it("refuses HQ-invalid survey and schedule inputs on the shared SA/MCP schema", () => {
		const invalidSurvey = {
			uuid: testUuid("tool-invalid-survey"),
			kind: "conditional-alert",
			name: "Invalid survey",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [{ uuid: testUuid("tool-invalid-recipient"), kind: "self" }],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("tool-invalid-event"),
						minutesToWait: 0,
						content: {
							kind: "sms-survey",
							formUuid: testUuid("tool-invalid-form"),
							expirationHours: 1,
							reminderIntervalsMinutes: [60],
							submitPartiallyCompletedForms: false,
							includeCaseUpdatesInPartialSubmissions: true,
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [],
			useUserCaseForFilter: false,
		};
		expect(
			addAutomationsInputSchema.safeParse({ automations: [invalidSurvey] })
				.success,
		).toBe(false);
	});

	it("adds, reads, granularly updates, and removes the same canonical object", async () => {
		mocks.readOrganization.mockResolvedValue({ revision: "1", locations: [] });
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
		expect(added.result).toMatchObject({
			setupGuides: [
				{
					automationUuid: RULE_UUID,
					executesInPreview: false,
					omittedCriteria: [],
				},
			],
		});
		mocks.readAuthoring.mockResolvedValue({
			blueprint: added.newDoc,
			blueprintSeq: 2,
			organization: { revision: "1", locations: [] },
		});
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
			closeCase: false,
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

	it("derives read guidance from the authorized organization snapshot", async () => {
		const current = doc();
		const locationUuid = testUuid("tool-automation-location");
		const locatedRule: Automation = {
			uuid: RULE_UUID,
			kind: "conditional-alert",
			name: "District reminder",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [
				{
					uuid: testUuid("tool-location-recipient"),
					kind: "location",
					locationUuid,
				},
			],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("tool-location-event"),
						minutesToWait: 0,
						content: { kind: "sms", message: "Hello" },
					},
				],
			},
			includeDescendantLocations: true,
			locationLevelUuids: [],
			userDataFilters: [],
			useUserCaseForFilter: false,
		};
		current.automations = { [RULE_UUID]: locatedRule };
		current.automationOrder = [RULE_UUID];
		mocks.readAuthoring.mockResolvedValue({
			blueprint: current,
			blueprintSeq: 3,
			organization: {
				revision: "2",
				locations: [
					{
						id: locationUuid,
						levelUuid: testUuid("tool-location-level"),
						parentId: null,
						siteCode: "north",
						name: "North district",
						externalId: null,
						latitude: null,
						longitude: null,
						values: {},
						archivedAt: null,
						orderKey: "a0",
					},
				],
			},
		});

		const read = await getAutomationsTool.execute({}, makeCtx(), current);
		expect(read.data).toEqual([
			expect.objectContaining({
				setupGuide: expect.objectContaining({
					steps: expect.arrayContaining([
						expect.stringContaining("North district"),
					]),
				}),
			}),
		]);
	});

	it("returns guidance from the merged committed rule after a concurrent edit", async () => {
		const existing = doc();
		existing.automations = { [RULE_UUID]: rule() };
		existing.automationOrder = [RULE_UUID];
		const ctx = makeCtx();
		ctx.recordMutations = vi.fn(async (prepared: PreparedMutationCandidate) => {
			const committedDoc = structuredClone(prepared.nextDoc);
			const committed = committedDoc.automations?.[RULE_UUID];
			if (committed === undefined) throw new Error("missing automation");
			committed.criteria = [
				{
					uuid: testUuid("peer-criterion"),
					kind: "match-property",
					scope: "case",
					property: "state",
					matchType: "equal",
					value: "peer-value",
				},
			];
			return { events: [], committedDoc };
		});
		mocks.readOrganization.mockResolvedValue({ revision: "2", locations: [] });

		const updated = await updateAutomationTool.execute(
			{ automation: { ...rule(), name: "My rename" } },
			ctx,
			existing,
		);

		expect(updated.newDoc.automations?.[RULE_UUID]?.criteria).toEqual([
			expect.objectContaining({ value: "peer-value" }),
		]);
		expect(updated.result).toMatchObject({
			setupGuides: [
				{
					setupGuide: {
						steps: expect.arrayContaining([
							expect.stringContaining("peer-value"),
						]),
					},
				},
			],
		});
	});

	it("refuses duplicate nested identities and kind changes without saving", async () => {
		const existing = doc();
		existing.automations = { [RULE_UUID]: rule() };
		existing.automationOrder = [RULE_UUID];
		const ctx = makeCtx();
		mocks.readOrganization.mockResolvedValue({ revision: "1", locations: [] });
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
					uuid: RULE_UUID,
					kind: "conditional-alert",
					name: "Resolve visits",
					caseType: "visit",
					criteriaOperator: "all",
					criteria: [],
					setupOnlyCriteria: [],
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
