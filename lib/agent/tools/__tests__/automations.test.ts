import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
	type ToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import type { RecordMutationsOptions } from "@/lib/agent/toolExecutionContext";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import {
	type Automation,
	automationMessageText,
	type BlueprintDoc,
	type Uuid,
} from "@/lib/domain";

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

function makeHarness(initialDoc: BlueprintDoc): ToolWorkspaceHarness {
	return makeToolWorkspaceHarness(initialDoc, {
		appId: "app-automations",
		userId: "member",
		runId: "run",
	});
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

function surveyRule(formUuid: Uuid): Automation {
	return {
		uuid: RULE_UUID,
		kind: "conditional-alert",
		name: "Visit survey",
		caseType: "visit",
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		recipients: [{ uuid: testUuid("tool-survey-recipient"), kind: "self" }],
		schedule: {
			kind: "immediate",
			events: [
				{
					uuid: testUuid("tool-survey-event"),
					minutesToWait: 0,
					content: {
						kind: "sms-survey",
						formUuid,
						expirationHours: 24,
						reminderIntervalsMinutes: [],
						submitPartiallyCompletedForms: false,
						includeCaseUpdatesInPartialSubmissions: false,
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

beforeEach(() => {
	vi.clearAllMocks();
});

describe("automation shared tools", () => {
	it("keeps matching counts on Builder Preview instead of the read tool", () => {
		expect(getAutomationsTool.description).toContain(
			"match counts are available only in Builder Preview",
		);
		expect(getAutomationsTool.description).not.toContain(
			"locally counts matching cases",
		);
	});

	it("teaches contextual host and message-property refusals on both write tools", () => {
		for (const description of [
			addAutomationsTool.description,
			updateAutomationTool.description,
		]) {
			expect(description).toContain(
				"advanced case operation can add a second extension relationship",
			);
			expect(description).toContain("owner, host, or last_modified_by");
			expect(description).toContain("formatter context shadows those names");
			expect(description).toContain(
				"Recipient filters require only user-account recipient kinds",
			);
			expect(description).toContain("every triggering case must contain");
			expect(description).toContain("must begin with H:MM or HH:MM");
			expect(description).toContain("AM/PM and seconds are accepted");
			expect(description).toContain(
				"blank, nonmatching, or unparseable values",
			);
			expect(description).toContain("12:00 PM");
			expect(description).toContain(
				"requires exactly one live extension at runtime",
			);
			expect(description).toContain(
				"retained extra extension indices make the current-match count unavailable",
			);
		}
	});

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

	it("refuses a recipient-filter combination HQ would silently bypass", () => {
		const invalidFilteredAlert = {
			uuid: testUuid("tool-invalid-filter-alert"),
			kind: "conditional-alert",
			name: "Filtered case alert",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [
				{ uuid: testUuid("tool-invalid-filter-recipient"), kind: "self" },
			],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("tool-invalid-filter-event"),
						minutesToWait: 0,
						content: {
							kind: "sms",
							message: automationMessageText("Hello"),
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [
				{
					uuid: testUuid("tool-invalid-filter"),
					userPropertyUuid: testUuid("tool-invalid-filter-property"),
					values: [{ kind: "literal", value: "nurse" }],
				},
			],
			useUserCaseForFilter: false,
		};
		const parsed = addAutomationsInputSchema.safeParse({
			automations: [invalidFilteredAlert],
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						path: ["automations", 0, "recipients", 0, "kind"],
						message: expect.stringContaining("non-user contacts bypass"),
					}),
				]),
			);
		}
	});

	it("adds, reads, granularly updates, and removes the same canonical object", async () => {
		mocks.readOrganization.mockResolvedValue({ revision: "1", locations: [] });
		const h = makeHarness(doc());
		const added = await h.runTool(addAutomationsTool, {
			automations: [rule()],
		});
		if (added.mutations.length === 0) {
			throw new Error(JSON.stringify(added.result));
		}
		expect(added.mutations).toHaveLength(1);
		expect(h.currentDoc().automations?.[RULE_UUID]).toEqual(rule());
		expect(added.result).toMatchObject({
			setupGuides: [
				{
					automationUuid: RULE_UUID,
					executesInPreview: false,
					omittedCriteria: [],
				},
			],
		});
		const read = await h.runTool(getAutomationsTool, {});
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
		const updated = await h.runTool(updateAutomationTool, {
			automation: updatedRule,
		});
		expect(updated.mutations).toEqual([
			expect.objectContaining({
				kind: "updateAutomation",
				uuid: RULE_UUID,
			}),
		]);
		expect(h.currentDoc().automations?.[RULE_UUID]).toEqual(updatedRule);

		const removed = await h.runTool(removeAutomationTool, {
			automationUuid: RULE_UUID,
		});
		expect(removed.mutations).toEqual([
			{
				kind: "removeAutomation",
				uuid: RULE_UUID,
				targetKind: "case-update",
			},
		]);
		expect(h.currentDoc().automations).toBeUndefined();
		expect(h.currentDoc().automationOrder).toBeUndefined();
	});

	it("reads the workspace's automations and guides them from the authorized place catalog", async () => {
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
						content: {
							kind: "sms",
							message: automationMessageText("Hello"),
						},
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
		mocks.readOrganization.mockResolvedValue({
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
		});

		const read = await makeHarness(current).runTool(getAutomationsTool, {});
		/* The document comes from the workspace snapshot; only the places are
		 * read externally. */
		expect(mocks.readAuthoring).not.toHaveBeenCalled();
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

	it("commits and guides automatic-update parent references on an extension case type", async () => {
		const current = doc();
		const visit = current.caseTypes?.find(
			(caseType) => caseType.name === "visit",
		);
		if (visit === undefined) throw new Error("missing visit type");
		visit.parent_type = "household";
		visit.relationship = "extension";
		current.caseTypes = [
			...(current.caseTypes ?? []),
			{
				name: "household",
				properties: [
					{
						name: "parent_state",
						label: { parts: [{ kind: "text", text: "Parent state" }] },
						data_type: "text",
					},
				],
			},
		];
		const baseRule = rule();
		if (baseRule.kind !== "case-update") {
			throw new Error("expected automatic update");
		}
		const extensionRule: Extract<Automation, { kind: "case-update" }> = {
			...baseRule,
			criteria: [
				{
					uuid: testUuid("tool-extension-parent-criterion"),
					kind: "match-property",
					scope: "parent",
					property: "parent_state",
					matchType: "has-value",
				},
			],
			updates: [
				{
					uuid: UPDATE_UUID,
					target: { scope: "parent", property: "parent_state" },
					value: {
						kind: "case-property",
						source: { scope: "parent", property: "parent_state" },
					},
				},
			],
		};
		mocks.readOrganization.mockResolvedValue({ revision: "1", locations: [] });

		const added = await makeHarness(current).runTool(addAutomationsTool, {
			automations: [extensionRule],
		});

		expect(added.mutations).toHaveLength(1);
		expect(added.result).toMatchObject({
			setupGuides: [
				{
					setupGuide: {
						steps: expect.arrayContaining([
							expect.stringContaining("parent/parent_state"),
						]),
					},
				},
			],
		});
	});

	it("returns guidance from the merged committed rule after a concurrent edit", async () => {
		const existing = doc();
		existing.automations = { [RULE_UUID]: rule() };
		existing.automationOrder = [RULE_UUID];
		const h = makeHarness(existing);
		h.recordMutations.mockImplementation(
			async (prepared: PreparedMutationCandidate) => {
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
			},
		);
		mocks.readOrganization.mockResolvedValue({ revision: "2", locations: [] });

		const updated = await h.runTool(updateAutomationTool, {
			automation: { ...rule(), name: "My rename" },
		});

		expect(updated.mutations).toHaveLength(1);
		expect(h.currentDoc().automations?.[RULE_UUID]?.criteria).toEqual([
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

	it("proves a zero-diff update from one authoritative Blueprint and organization snapshot", async () => {
		const invocationDoc = doc();
		const formUuid = Object.keys(invocationDoc.forms)[0] as Uuid | undefined;
		if (formUuid === undefined) throw new Error("missing form");
		const requested = surveyRule(formUuid);
		invocationDoc.automations = { [RULE_UUID]: requested };
		invocationDoc.automationOrder = [RULE_UUID];

		const authoritativeDoc = structuredClone(invocationDoc);
		const authoritativeForm = authoritativeDoc.forms[formUuid];
		if (authoritativeForm === undefined) throw new Error("missing form");
		authoritativeForm.name = "Renamed peer survey";
		const moduleUuid = Object.keys(authoritativeDoc.modules)[0] as
			| Uuid
			| undefined;
		if (moduleUuid === undefined) throw new Error("missing module");
		const authoritativeModule = authoritativeDoc.modules[moduleUuid];
		if (authoritativeModule === undefined) throw new Error("missing module");
		authoritativeModule.name = "Renamed peer module";
		const peerBase = rule();
		if (peerBase.kind !== "case-update") {
			throw new Error("expected case-update peer rule");
		}
		const peerRule = {
			...peerBase,
			uuid: testUuid("tool-peer-automation"),
			updates: [
				{
					...peerBase.updates[0],
					uuid: testUuid("tool-peer-automation-update"),
				},
			],
		} satisfies Automation;
		authoritativeDoc.automations = {
			...authoritativeDoc.automations,
			[peerRule.uuid]: peerRule,
		};
		authoritativeDoc.automationOrder = [RULE_UUID, peerRule.uuid];
		mocks.readAuthoring.mockResolvedValue({
			blueprint: authoritativeDoc,
			blueprintSeq: 9,
			organization: { revision: "4", locations: [] },
		});
		const h = makeHarness(invocationDoc);

		const updated = await h.runTool(updateAutomationTool, {
			automation: requested,
		});

		expect(updated.mutations).toEqual([]);
		expect(h.currentDoc()).toBe(authoritativeDoc);
		expect(h.currentDoc().automations?.[peerRule.uuid]).toEqual(peerRule);
		expect(JSON.stringify(updated.result)).toContain("Renamed peer module");
		expect(JSON.stringify(updated.result)).toContain("Renamed peer survey");
		expect(updated.result).not.toHaveProperty("error");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(mocks.readOrganization).not.toHaveBeenCalled();
		expect(mocks.readAuthoring).toHaveBeenCalledTimes(1);
	});

	it("returns a fresh-doc conflict when a zero-diff invocation races a peer automation edit", async () => {
		const invocationDoc = doc();
		const requested = rule();
		invocationDoc.automations = { [RULE_UUID]: requested };
		invocationDoc.automationOrder = [RULE_UUID];
		const authoritativeDoc = structuredClone(invocationDoc);
		const peerAutomation = authoritativeDoc.automations?.[RULE_UUID];
		if (peerAutomation === undefined) throw new Error("missing automation");
		peerAutomation.name = "Peer renamed this rule";
		mocks.readAuthoring.mockResolvedValue({
			blueprint: authoritativeDoc,
			blueprintSeq: 10,
			organization: { revision: "5", locations: [] },
		});
		const h = makeHarness(invocationDoc);

		const updated = await h.runTool(updateAutomationTool, {
			automation: requested,
		});

		expect(updated).toMatchObject({
			mutations: [],
			result: {
				error:
					"This automation changed concurrently. Read automations again and retry from the current complete state.",
			},
		});
		expect(h.currentDoc()).toBe(authoritativeDoc);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(mocks.readOrganization).not.toHaveBeenCalled();
		expect(mocks.readAuthoring).toHaveBeenCalledTimes(1);
	});

	it("does not perform a fallible organization read after an add commits", async () => {
		let committed = false;
		mocks.readOrganization.mockImplementation(async () => {
			if (committed) throw new Error("organization changed after commit");
			return { revision: "1", locations: [] };
		});
		const h = makeHarness(doc());
		h.recordMutations.mockImplementation(
			async (prepared: PreparedMutationCandidate) => {
				committed = true;
				return { events: [], committedDoc: prepared.nextDoc };
			},
		);

		const added = await h.runTool(addAutomationsTool, {
			automations: [rule()],
		});

		expect(added.mutations).toHaveLength(1);
		expect(added.result).not.toHaveProperty("error");
		expect(mocks.readOrganization).toHaveBeenCalledTimes(1);
		expect(h.recordMutations).toHaveBeenCalledWith(
			expect.anything(),
			"automations",
			{ expectedOrganizationRevision: "1" },
		);
	});

	it("does not perform a fallible organization read after an update commits", async () => {
		const existing = doc();
		existing.automations = { [RULE_UUID]: rule() };
		existing.automationOrder = [RULE_UUID];
		let committed = false;
		mocks.readOrganization.mockImplementation(async () => {
			if (committed) throw new Error("organization changed after commit");
			return { revision: "1", locations: [] };
		});
		const h = makeHarness(existing);
		h.recordMutations.mockImplementation(
			async (prepared: PreparedMutationCandidate) => {
				committed = true;
				return { events: [], committedDoc: prepared.nextDoc };
			},
		);

		const updated = await h.runTool(updateAutomationTool, {
			automation: { ...rule(), name: "Updated safely" },
		});

		expect(updated.mutations).toHaveLength(1);
		expect(updated.result).not.toHaveProperty("error");
		expect(mocks.readOrganization).toHaveBeenCalledTimes(1);
		expect(h.recordMutations).toHaveBeenCalledWith(
			expect.anything(),
			"automations",
			{ expectedOrganizationRevision: "1" },
		);
	});

	it("rejects before persistence when a place rename, metadata edit, or move advances the guidance snapshot", async () => {
		mocks.readOrganization.mockResolvedValue({ revision: "7", locations: [] });
		const h = makeHarness(doc());
		h.recordMutations.mockImplementation(
			async (
				prepared: PreparedMutationCandidate,
				_stage?: string,
				options?: RecordMutationsOptions,
			) => {
				// Every location mutation advances this one organization clock. Model
				// the authoritative writer observing the concurrent generation after
				// the tool acquired revision 7 but before its Blueprint commit.
				const currentRevision = "8";
				if (
					options?.expectedOrganizationRevision !== undefined &&
					options.expectedOrganizationRevision !== currentRevision
				) {
					throw new BlueprintCommitRejectedError(
						"organization revision changed",
					);
				}
				return { events: [], committedDoc: prepared.nextDoc };
			},
		);

		await expect(
			h.runTool(addAutomationsTool, { automations: [rule()] }),
		).rejects.toThrow("organization revision changed");
		expect(h.recordMutations).toHaveBeenCalledWith(
			expect.anything(),
			"automations",
			{ expectedOrganizationRevision: "7" },
		);
	});

	it("refuses duplicate nested identities and kind changes without saving", async () => {
		const existing = doc();
		existing.automations = { [RULE_UUID]: rule() };
		existing.automationOrder = [RULE_UUID];
		const h = makeHarness(existing);
		mocks.readOrganization.mockResolvedValue({ revision: "1", locations: [] });
		const duplicate = await h.runTool(addAutomationsTool, {
			automations: [
				{
					...rule(),
					uuid: testUuid("tool-automation-second"),
				},
			],
		});
		expect(duplicate.mutations).toEqual([]);
		expect(duplicate.result).toHaveProperty("error");

		const changedKind = await h.runTool(updateAutomationTool, {
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
							content: {
								kind: "sms",
								message: automationMessageText("Hi"),
							},
						},
					],
				},
				includeDescendantLocations: false,
				locationLevelUuids: [],
				userDataFilters: [],
				useUserCaseForFilter: false,
			},
		});
		expect(changedKind.mutations).toEqual([]);
		expect(changedKind.result).toHaveProperty("error");
	});
});
