/**
 * The change-set workspace and commit against a REAL Postgres — replay
 * determinism, private-state isolation, handles end-to-end, exclusivity,
 * rebase classification, and the all-or-nothing canonical transition.
 *
 * The private-state isolation gate is asserted directly: staging changes NO
 * canonical row — not `apps`, not `blueprint_entities`, not `app_changes`
 * (whose count is also what SSE/peers/fold can ever observe) — and the
 * private candidate may carry gating findings the whole time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { asDesignId } from "@/lib/agent/design/ids";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { commitGuardedBatch } from "@/lib/db/apps";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import type {
	Automation,
	BlueprintDoc,
	Field,
	Form,
	Module,
	Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { asUuid } from "@/lib/domain/uuid";
import { emptyGenesisBase } from "../baseLoader";
import { commitDesignChangeSet } from "../commit";
import { canonicalJsonDigest } from "../digest";
import {
	ChangeSetScopeLostError,
	ChangeSetStagingRejectedError,
} from "../errors";
import { CHANGE_SET_TOOL_REGISTRY } from "../registry";
import { changeSetHandleSchema } from "../schemas";
import {
	beginAppEditChangeSet,
	beginGenesisChangeSet,
	loadChangeSet,
	loadChangeSetSteps,
	stageChangeSetRequest,
} from "../store";
import type { ChangeSetLineage } from "../types";
import {
	ChangeSetMutationWorkspace,
	type ChangeSetWorkspaceHost,
} from "../workspace";

const h = setupAppStateTestDb("change_set_runtime_");

const ACTOR = "actor-user";
const PROJECT = "project-test";
const RUN = "run-1";

const host: ChangeSetWorkspaceHost = {
	actorUserId: ACTOR,
	runId: RUN,
	conversionImpact: vi.fn(async () => {
		throw new Error("conversionImpact is not exercised by these tests");
	}),
};

/* Every change-set identity column is FK-bound (design_sessions with the
 * design-session unit; revision/plan/attempt with the orchestrator unit),
 * so the lineage helper seeds the whole FK-valid chain. */
async function lineage(): Promise<ChangeSetLineage> {
	const seeded = await h.seedDesignLineage();
	return {
		designSessionId: seeded.designSessionId,
		designRevisionId: seeded.designRevisionId,
		designRevisionDigest: seeded.designRevisionDigest,
		buildPlanId: seeded.buildPlanId,
		buildPlanDigest: seeded.buildPlanDigest,
		sliceId: asDesignId(seeded.sliceId),
		attemptId: seeded.attemptId,
	};
}

interface TestApp {
	readonly appId: string;
	readonly starter: {
		readonly moduleUuid: Uuid;
		readonly formUuid: Uuid;
		readonly fieldUuid: Uuid;
	};
	readonly doc: BlueprintDoc;
}

async function createTestApp(): Promise<TestApp> {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	const receipt = await createExplicitBlankApp(
		ACTOR,
		PROJECT,
		crypto.randomUUID(),
		{
			name: "Change-set runtime app",
			status: "complete",
		},
	);
	const doc = structuredClone(receipt.blueprint) as unknown as BlueprintDoc;
	return { appId: receipt.appId, starter: receipt.starter, doc };
}

/** A guaranteed-valid field literal: the canonical starter question with a
 *  fresh identity — never a hand-invented shape. */
function starterFieldClone(doc: BlueprintDoc, starterFieldUuid: Uuid): Field {
	const template = doc.fields[starterFieldUuid];
	if (template === undefined) throw new Error("starter field missing");
	return {
		...structuredClone(template),
		uuid: asUuid(crypto.randomUUID()),
		id: `q_${crypto.randomUUID().slice(0, 8)}`,
	};
}

async function openWorkspace(appId: string) {
	const changeSet = await beginAppEditChangeSet({
		appId,
		expectedProjectId: PROJECT,
		lineage: await lineage(),
		ownerUserId: ACTOR,
		ownerRunId: RUN,
	});
	await h
		.db()
		.updateTable("design_slice_attempts")
		.set({ change_set_id: changeSet.id })
		.where("id", "=", changeSet.attemptId)
		.execute();
	const workspace = await ChangeSetMutationWorkspace.open(host, changeSet.id);
	return { changeSet, workspace };
}

async function canonicalTableCounts(appId: string) {
	const db = h.db();
	const [changes, entities, app] = await Promise.all([
		db
			.selectFrom("app_changes")
			.select(db.fn.countAll().as("count"))
			.where("app_id", "=", appId)
			.executeTakeFirstOrThrow(),
		db
			.selectFrom("blueprint_entities")
			.select(db.fn.countAll().as("count"))
			.where("app_id", "=", appId)
			.executeTakeFirstOrThrow(),
		db
			.selectFrom("apps")
			.select(["mutation_seq", "app_name"])
			.where("id", "=", appId)
			.executeTakeFirstOrThrow(),
	]);
	return {
		appChanges: Number(changes.count),
		entities: Number(entities.count),
		mutationSeq: Number(app.mutation_seq),
		appName: app.app_name,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("private staging isolation", () => {
	it("returns resolved shared-tool schema misses as ordinary staging rejections", async () => {
		const app = await createTestApp();
		const { workspace } = await openWorkspace(app.appId);

		await expect(
			workspace.stageDispatch({
				toolName: "createModule",
				requestId: "malformed-complete-module",
				input: {
					moduleUuid: { handle: "@registry" },
					name: "Household registry",
					case_type: null,
					displayCondition: null,
					forms: [
						{
							formUuid: { handle: "@survey" },
							name: "Household survey",
							type: "survey",
							fields: [
								{
									fieldUuid: { handle: "@status" },
									kind: "single_select",
									id: "status",
								},
							],
						},
					],
				},
			}),
		).rejects.toMatchObject({
			name: "ChangeSetStagingRejectedError",
			code: "STAGING_FORBIDDEN",
			message: expect.stringContaining("forms.0.fields.0.label"),
		});
	});

	it("creates a complete shared module with handles and reuses those bindings", async () => {
		const app = await createTestApp();
		const before = await canonicalTableCounts(app.appId);
		const { workspace } = await openWorkspace(app.appId);
		const created = await workspace.stageDispatch({
			toolName: "createModule",
			requestId: "complete-module",
			input: {
				moduleUuid: { handle: "@registry" },
				name: "Household registry",
				case_type: null,
				forms: [
					{
						formUuid: { handle: "@survey" },
						name: "Household survey",
						type: "survey",
						fields: [
							{
								fieldUuid: { handle: "@status" },
								kind: "single_select",
								id: "status",
								label: proseText("Status"),
								optionsSource: {
									kind: "inline",
									options: [
										{
											optionUuid: { handle: "@active" },
											value: "active",
											label: proseText("Active"),
										},
										{
											optionUuid: { handle: "@closed" },
											value: "closed",
											label: proseText("Closed"),
										},
									],
								},
							},
						],
					},
				],
			},
		});
		expect(created.receipt?.disposition).toBe("staged");
		expect(created.result).not.toHaveProperty("error");
		expect(created.receipt?.handles).toMatchObject({
			"@registry": expect.stringMatching(/^[0-9a-f-]{36}$/),
			"@survey": expect.stringMatching(/^[0-9a-f-]{36}$/),
			"@status": expect.stringMatching(/^[0-9a-f-]{36}$/),
			"@active": expect.stringMatching(/^[0-9a-f-]{36}$/),
			"@closed": expect.stringMatching(/^[0-9a-f-]{36}$/),
		});

		const edited = await workspace.stageDispatch({
			toolName: "editField",
			requestId: "reuse-field",
			input: {
				moduleUuid: { handle: "@registry" },
				formUuid: { handle: "@survey" },
				fieldUuid: { handle: "@status" },
				updates: {
					kind: "single_select",
					label: proseText("Current status"),
					optionsSource: {
						kind: "inline",
						options: [
							{
								optionUuid: { handle: "@active" },
								value: "active",
								label: proseText("Active"),
							},
							{
								optionUuid: { handle: "@pending" },
								value: "pending",
								label: proseText("Pending"),
							},
						],
					},
				},
			},
		});
		expect(edited.receipt?.disposition).toBe("staged");
		expect(edited.result).not.toHaveProperty("error");
		expect(edited.receipt?.handles).toMatchObject({
			"@pending": expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		const statusUuid =
			created.receipt?.handles[changeSetHandleSchema.parse("@status")];
		const activeUuid =
			created.receipt?.handles[changeSetHandleSchema.parse("@active")];
		if (statusUuid === undefined || activeUuid === undefined) {
			throw new Error("creation handles missing");
		}
		const status = workspace.currentSnapshot().doc.fields[statusUuid];
		if (status?.kind !== "single_select")
			throw new Error("status field missing");
		if (status.optionsSource.kind !== "inline")
			throw new Error("status options missing");
		expect(status.optionsSource.options[0]?.uuid).toBe(activeUuid);
		expect(await canonicalTableCounts(app.appId)).toEqual(before);
	});

	it("stages module + form + fields with handles while NO canonical row changes", async () => {
		const app = await createTestApp();
		const before = await canonicalTableCounts(app.appId);
		const { changeSet, workspace } = await openWorkspace(app.appId);

		const staged = await workspace.stageDispatch({
			toolName: "stageModule",
			requestId: "call-1",
			input: { moduleUuid: { handle: "@intake" }, name: "Intake" },
		});
		expect(staged.replayed).toBe(false);
		expect(staged.receipt?.disposition).toBe("staged");
		const moduleUuid =
			staged.receipt?.handles[changeSetHandleSchema.parse("@intake")];
		expect(moduleUuid).toMatch(/^[0-9a-f-]{36}$/);

		const stagedForm = await workspace.stageDispatch({
			toolName: "stageForm",
			requestId: "call-2",
			input: {
				formUuid: { handle: "@reg" },
				moduleUuid: { handle: "@intake" },
				name: "Register client",
				type: "survey",
			},
		});
		expect(stagedForm.receipt?.disposition).toBe("staged");

		/* The private candidate holds an EMPTY form — a gating finding class
		 * (`EMPTY_FORM`) that could never persist canonically. */
		const diagnostics = await workspace.inspect();
		expect(diagnostics.allFindings.map((finding) => finding.code)).toContain(
			"EMPTY_FORM",
		);
		expect(diagnostics.canCommit).toBe(false);

		/* The isolation gate: nothing canonical moved. */
		expect(await canonicalTableCounts(app.appId)).toEqual(before);

		/* Completing the form through a SHARED tool staged over the overlay
		 * resolves the finding — same module, same admission, private grain. */
		const formUuid =
			stagedForm.receipt?.handles[changeSetHandleSchema.parse("@reg")];
		if (formUuid === undefined) throw new Error("@reg was not bound");
		const field = starterFieldClone(app.doc, app.starter.fieldUuid);
		const completed = await workspace.invoke({
			toolName: "addField-direct",
			requestId: "call-3",
			input: { fieldUuid: field.uuid },
			execute: async (ctx) =>
				ctx.applyBatch({
					mutations: [
						{ kind: "addField", parentUuid: formUuid, field },
					] satisfies Mutation[],
					intentIds: [asDesignId(crypto.randomUUID())],
				}),
		});
		expect(completed.ok).toBe(true);
		const after = await workspace.inspect();
		expect(after.allFindings).toEqual([]);
		expect(after.canCommit).toBe(true);
		expect(after.sliceIntentCoverage).toHaveLength(1);

		/* Still nothing canonical. */
		expect(await canonicalTableCounts(app.appId)).toEqual(before);
		expect((await loadChangeSet(changeSet.id))?.status).toBe("open");
	});

	it("replays a lost response with identical receipt, handles, and revision — and survives process death", async () => {
		const app = await createTestApp();
		const { changeSet, workspace } = await openWorkspace(app.appId);
		const intentId = asDesignId(crypto.randomUUID());
		const input = { moduleUuid: { handle: "@m" }, name: "Visits" };
		const first = await workspace.stageDispatch({
			toolName: "stageModule",
			requestId: "call-1",
			input,
			intentIds: [intentId],
		});

		/* Same workspace instance. */
		const replay = await workspace.stageDispatch({
			toolName: "stageModule",
			requestId: "call-1",
			input,
			intentIds: [intentId],
		});
		expect(replay.replayed).toBe(true);
		expect(replay.receipt).toEqual(first.receipt);

		/* A NEW process: rehydrate from durable state alone. */
		const reopened = await ChangeSetMutationWorkspace.open(host, changeSet.id);
		expect(reopened.currentSnapshot().revision).toBe(1);
		expect(canonicalJsonDigest(reopened.currentSnapshot().doc.modules)).toBe(
			canonicalJsonDigest(workspace.currentSnapshot().doc.modules),
		);
		expect(reopened.currentExecutionCheckpoint()).toMatchObject({
			intentCoverage: [{ intentId, stepCount: 1 }],
			handles: [{ handle: "@m", entityKind: "module" }],
		});
		const replayAfterDeath = await reopened.stageDispatch({
			toolName: "stageModule",
			requestId: "call-1",
			input,
			intentIds: [intentId],
		});
		expect(replayAfterDeath.replayed).toBe(true);
		expect(replayAfterDeath.receipt).toEqual(first.receipt);
	});

	it("rejects admission failures before a step appends, with a durable rejection receipt", async () => {
		const app = await createTestApp();
		const { changeSet, workspace } = await openWorkspace(app.appId);

		const outcome = await workspace.invoke({
			toolName: "removeField-direct",
			requestId: "call-bad",
			input: { target: "missing" },
			execute: async (ctx) =>
				ctx.applyBatch({
					mutations: [
						{ kind: "removeField", uuid: asUuid(crypto.randomUUID()) },
					] satisfies Mutation[],
				}),
		});
		expect(outcome.ok).toBe(false);
		expect(await loadChangeSetSteps(changeSet.id)).toHaveLength(0);
		expect((await loadChangeSet(changeSet.id))?.revision).toBe(0);
	});

	it("refuses an unregistered (external-effect) tool at dispatch", async () => {
		const app = await createTestApp();
		const { workspace } = await openWorkspace(app.appId);
		await expect(
			workspace.stageDispatch({
				toolName: "removeMediaAsset",
				requestId: "call-x",
				input: { assetId: crypto.randomUUID() },
			}),
		).rejects.toBeInstanceOf(ChangeSetStagingRejectedError);
	});

	it("dispatches the organization-deriving tools, whose reads answer from the overlay", async () => {
		/* These three used to be fenced out of the registry because their
		 * bodies read the persisted app instead of the workspace snapshot —
		 * which would have made an executor's own staged state invisible to
		 * its read-backs. They are overlay-native now, so membership alone is
		 * not the claim: each read must SEE what this change set staged. */
		for (const toolName of [
			"getAutomations",
			"getOrganization",
			"updateAutomation",
		]) {
			expect(CHANGE_SET_TOOL_REGISTRY.has(toolName)).toBe(true);
		}

		const app = await createTestApp();
		const { workspace } = await openWorkspace(app.appId);

		const levelUuid = asUuid(crypto.randomUUID());
		const stagedLevel = await workspace.stageDispatch({
			toolName: "addOrganizationLevels",
			requestId: "add-level",
			input: {
				levels: [
					{
						uuid: levelUuid,
						code: "district",
						name: "District",
						description: null,
						parentLevelUuid: null,
						caseFlow: { workers: "none", ownsCases: false },
						addressBook: { reach: "own-branch" },
					},
				],
			},
		});
		expect(stagedLevel.receipt?.disposition).toBe("staged");

		const organization = await workspace.stageDispatch({
			toolName: "getOrganization",
			requestId: "read-organization",
			input: { limit: 25 },
		});
		const organizationData = (
			organization.result as { data: { levels: { uuid: string }[] } }
		).data;
		expect(organizationData.levels.map((level) => level.uuid)).toEqual([
			levelUuid,
		]);

		const automationUuid = asUuid(crypto.randomUUID());
		const stagedAutomation = await workspace.stageDispatch({
			toolName: "addAutomations",
			requestId: "add-automation",
			input: {
				automations: [
					{
						uuid: automationUuid,
						kind: "case-update",
						name: "Close stale visits",
						caseType: "visit",
						criteriaOperator: "all",
						criteria: [],
						setupOnlyCriteria: [],
						updates: [],
						closeCase: true,
					},
				],
			},
		});
		expect(stagedAutomation.receipt?.disposition).toBe("staged");

		const automations = await workspace.stageDispatch({
			toolName: "getAutomations",
			requestId: "read-automations",
			input: {},
		});
		const automationData = (
			automations.result as {
				data: { automation: { uuid: string; name: string } }[];
			}
		).data;
		expect(automationData.map((entry) => entry.automation.uuid)).toEqual([
			automationUuid,
		]);

		/* The zero-diff arm: on a private overlay the snapshot itself is the
		 * proof, so the no-op returns from the overlay with no adoption (which
		 * the change-set workspace refuses outright). */
		const noop = await workspace.stageDispatch({
			toolName: "updateAutomation",
			requestId: "update-automation-noop",
			input: {
				automation: {
					uuid: automationUuid,
					kind: "case-update",
					name: "Close stale visits",
					caseType: "visit",
					criteriaOperator: "all",
					criteria: [],
					setupOnlyCriteria: [],
					updates: [],
					closeCase: true,
				},
			},
		});
		expect(noop.result).toMatchObject({
			mutations: [],
			result: { message: expect.stringContaining("already has") },
		});
	});

	it("rejects an organization-deriving write that carried no revision fence (READ_SET_UNRECORDED)", async () => {
		const app = await createTestApp();
		const { changeSet, workspace } = await openWorkspace(app.appId);
		/* addAutomations' reviewed policy declares the organization read set;
		 * a staged write under that name without the exact revision fence
		 * must not become a silently unfenced step. */
		const outcome = await workspace.invoke({
			toolName: "addAutomations",
			requestId: "unfenced-1",
			input: { simulated: true },
			execute: async (ctx) =>
				ctx.applyBatch({
					mutations: [
						{ kind: "setAppName", name: "Unfenced write" },
					] satisfies Mutation[],
				}),
		});
		expect(outcome.ok).toBe(false);
		expect(!outcome.ok && outcome.error).toContain("organization");
		const stored = await loadChangeSetSteps(changeSet.id);
		expect(stored).toHaveLength(0);

		/* The same write WITH the fence stages, capturing the dependency. */
		const fenced = await workspace.invoke({
			toolName: "addAutomations",
			requestId: "fenced-1",
			input: { simulated: true, fenced: true },
			execute: async (ctx) =>
				ctx.applyBatch({
					mutations: [
						{ kind: "setAppName", name: "Fenced write" },
					] satisfies Mutation[],
					policy: { expectedOrganizationRevision: "0" },
				}),
		});
		expect(fenced.ok).toBe(true);
		const steps = await loadChangeSetSteps(changeSet.id);
		expect(steps[0]?.readSet).toEqual([
			{ kind: "organization", projectId: PROJECT, revision: "0" },
		]);
	});

	it("names the recoverable open change set when an attempt begins twice", async () => {
		const app = await createTestApp();
		const shared = await lineage();
		await beginAppEditChangeSet({
			appId: app.appId,
			expectedProjectId: PROJECT,
			lineage: shared,
			ownerUserId: ACTOR,
			ownerRunId: RUN,
		});
		await expect(
			beginAppEditChangeSet({
				appId: app.appId,
				expectedProjectId: PROJECT,
				lineage: shared,
				ownerUserId: ACTOR,
				ownerRunId: RUN,
			}),
		).rejects.toThrow(/already has an open change set/);
	});

	it("fences batch-exclusive mutations: exclusive-not-alone and exclusive-set-closed", async () => {
		const app = await createTestApp();
		const { workspace } = await openWorkspace(app.appId);
		await workspace.stageDispatch({
			toolName: "stageModule",
			requestId: "call-1",
			input: { name: "Ordinary first" },
		});

		const notAlone = await workspace.invoke({
			toolName: "renameCaseProperties-direct",
			requestId: "call-2",
			input: { renames: 1 },
			execute: async (ctx) =>
				ctx.applyBatch({
					mutations: [
						{
							kind: "renameCaseProperties",
							renames: [
								{ caseType: "client", from: "old_name", to: "new_name" },
							],
						},
					] satisfies Mutation[],
				}),
		});
		expect(notAlone.ok).toBe(false);
		expect(!notAlone.ok && notAlone.error).toContain("batch-exclusive");

		/* A set already holding its exclusive step admits nothing further.
		 * (The exclusive step itself is seeded through the store — a REAL
		 * rename needs a case-typed base app, which is the rename suite's
		 * territory; the fence under test here is the closed-set arm.) */
		const second = await openWorkspace(app.appId);
		await stageChangeSetRequest({
			changeSetId: second.changeSet.id,
			requestId: "seed-exclusive",
			toolName: "renameCaseProperties",
			inputDigest: canonicalJsonDigest("seed-exclusive"),
			expectedRevision: 0,
			actorUserId: ACTOR,
			runId: RUN,
			outcome: {
				kind: "stage",
				mutations: admitMutationBatch([
					{ kind: "setAppName", name: "Exclusive placeholder" },
				]),
				stageSlices: [],
				handles: [],
				intentIds: [],
				readSet: [],
				exclusiveKind: "renameCaseProperties",
				diagnostics: {
					candidateDigest: canonicalJsonDigest("candidate"),
					findingCount: 0,
					findingFingerprints: [],
					canCommit: false,
				},
			},
		});
		const reopened = await ChangeSetMutationWorkspace.open(
			host,
			second.changeSet.id,
		);
		expect((await loadChangeSet(second.changeSet.id))?.exclusiveKind).toBe(
			"renameCaseProperties",
		);
		const closed = await reopened.stageDispatch({
			toolName: "stageModule",
			requestId: "call-2",
			input: { name: "After exclusive" },
		});
		expect(closed.receipt?.disposition).toBe("rejected");
		expect(closed.receipt?.error?.code).toBe("EXCLUSIVE_SET_CLOSED");
	});
});

describe("genesis staging", () => {
	it("stages automation writes against the honest revision-zero place snapshot", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const proposedAppId = crypto.randomUUID();
		const changeSet = await beginGenesisChangeSet({
			proposedAppId,
			projectId: PROJECT,
			baseSnapshotDigest: emptyGenesisBase(proposedAppId).digest,
			lineage: await lineage(),
			ownerUserId: ACTOR,
			ownerRunId: RUN,
		});
		const workspace = await ChangeSetMutationWorkspace.open(host, changeSet.id);
		const automation: Automation = {
			uuid: asUuid(crypto.randomUUID()),
			kind: "case-update",
			name: "Close stale visits",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [],
			closeCase: true,
		};
		const staged = await workspace.stageDispatch({
			toolName: "addAutomations",
			requestId: "genesis-automation",
			input: { automations: [automation] },
			intentIds: [asDesignId(crypto.randomUUID())],
		});
		expect(staged.receipt?.disposition).toBe("staged");
		expect((await loadChangeSetSteps(changeSet.id))[0]?.readSet).toEqual([
			{ kind: "organization", projectId: PROJECT, revision: "0" },
		]);
	});

	it("builds a private candidate over the empty base and reaches export readiness", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const proposedAppId = crypto.randomUUID();
		const base = emptyGenesisBase(proposedAppId);
		const changeSet = await beginGenesisChangeSet({
			proposedAppId,
			projectId: PROJECT,
			baseSnapshotDigest: base.digest,
			lineage: await lineage(),
			ownerUserId: ACTOR,
			ownerRunId: RUN,
		});
		const workspace = await ChangeSetMutationWorkspace.open(host, changeSet.id);
		expect(workspace.currentSnapshot().canonicalSeq).toBeNull();

		await workspace.stageDispatch({
			toolName: "stageModule",
			requestId: "g-1",
			input: { moduleUuid: { handle: "@m" }, name: "Survey" },
		});
		const formStaged = await workspace.stageDispatch({
			toolName: "stageForm",
			requestId: "g-2",
			input: {
				formUuid: { handle: "@f" },
				moduleUuid: { handle: "@m" },
				name: "Survey form",
				type: "survey",
			},
		});
		const incomplete = await workspace.inspect();
		expect(incomplete.canCommit).toBe(false);

		/* One text question completes the smallest export-ready shape —
		 * proven by the genesis export-readiness preflight in canCommit. */
		const donor = await createTestApp();
		const field = starterFieldClone(donor.doc, donor.starter.fieldUuid);
		const formUuid =
			formStaged.receipt?.handles[changeSetHandleSchema.parse("@f")];
		if (formUuid === undefined) throw new Error("@f was not bound");
		await workspace.invoke({
			toolName: "addField-direct",
			requestId: "g-3",
			input: { fieldUuid: field.uuid },
			execute: async (ctx) =>
				ctx.applyBatch({
					mutations: [
						{ kind: "addField", parentUuid: formUuid, field },
					] satisfies Mutation[],
				}),
		});
		const complete = await workspace.inspect();
		expect(complete.allFindings).toEqual([]);
		expect(complete.canCommit).toBe(true);

		/* No app row exists for the proposed identity — genesis is private. */
		const app = await h.readAppRow(proposedAppId);
		expect(app).toBe(undefined);
	});

	it("refuses the app-edit commit path for a genesis set", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const proposedAppId = crypto.randomUUID();
		const changeSet = await beginGenesisChangeSet({
			proposedAppId,
			projectId: PROJECT,
			baseSnapshotDigest: emptyGenesisBase(proposedAppId).digest,
			lineage: await lineage(),
			ownerUserId: ACTOR,
			ownerRunId: RUN,
		});
		await expect(
			commitDesignChangeSet({
				changeSetId: changeSet.id,
				actorUserId: ACTOR,
				runId: RUN,
				kind: "mcp",
				expectedRevision: 0,
				owningIntentIds: [],
			}),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);
	});
});

describe("commitDesignChangeSet", () => {
	async function stageCompleteWorkflow(appId: string, donor: TestApp) {
		const intentId = asDesignId(crypto.randomUUID());
		const { changeSet, workspace } = await openWorkspace(appId);
		await workspace.stageDispatch({
			toolName: "stageModule",
			requestId: "c-1",
			input: { moduleUuid: { handle: "@m" }, name: "Committed module" },
			intentIds: [intentId],
		});
		const form = await workspace.stageDispatch({
			toolName: "stageForm",
			requestId: "c-2",
			input: {
				formUuid: { handle: "@f" },
				moduleUuid: { handle: "@m" },
				name: "Committed form",
				type: "survey",
			},
			intentIds: [intentId],
		});
		const field = starterFieldClone(donor.doc, donor.starter.fieldUuid);
		const formUuid = form.receipt?.handles[changeSetHandleSchema.parse("@f")];
		if (formUuid === undefined) throw new Error("@f was not bound");
		await workspace.invoke({
			toolName: "addField-direct",
			requestId: "c-3",
			input: { fieldUuid: field.uuid },
			execute: async (ctx) =>
				ctx.applyBatch({
					mutations: [
						{ kind: "addField", parentUuid: formUuid, field },
					] satisfies Mutation[],
					stage: "fields",
					intentIds: [intentId],
				}),
		});
		return { changeSet, workspace, intentId };
	}

	it("commits all steps as ONE canonical batch with the receipt sidecar, atomically", async () => {
		const app = await createTestApp();
		const { changeSet, intentId } = await stageCompleteWorkflow(app.appId, app);
		const before = await canonicalTableCounts(app.appId);

		const outcome = await commitDesignChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 3,
			owningIntentIds: [intentId],
		});
		expect(outcome.kind).toBe("committed");
		if (outcome.kind !== "committed") throw new Error("unreachable");
		expect(outcome.replayed).toBe(false);
		expect(outcome.receipt.seq).toBe(before.mutationSeq + 1);
		expect(outcome.receipt.batchId).toMatch(
			new RegExp(`^design-change-set:${changeSet.id}:r3:[a-f0-9]{24}$`),
		);
		expect(outcome.receipt.mutationCount).toBe(3);

		const after = await canonicalTableCounts(app.appId);
		expect(after.appChanges).toBe(before.appChanges + 1);
		expect(after.mutationSeq).toBe(before.mutationSeq + 1);
		const row = await loadChangeSet(changeSet.id);
		expect(row?.status).toBe("committed");
		expect(row?.committedSeq).toBe(outcome.receipt.seq);
		expect(row?.committedBatchId).toBe(outcome.receipt.batchId);
		const attempt = await h
			.db()
			.selectFrom("design_slice_attempts")
			.select("status")
			.where("change_set_id", "=", changeSet.id)
			.executeTakeFirst();
		expect(attempt?.status).toBe("committed");

		/* A commit retry converges on the stored receipt. */
		const retry = await commitDesignChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 3,
			owningIntentIds: [],
		});
		expect(retry.kind).toBe("committed");
		if (retry.kind !== "committed") throw new Error("unreachable");
		expect(retry.replayed).toBe(true);
		expect(retry.receipt).toEqual(outcome.receipt);
		expect(await canonicalTableCounts(app.appId)).toEqual(after);
	});

	it("refuses copied plan groups unless durable mutation steps prove exact coverage", async () => {
		const app = await createTestApp();
		const { changeSet, intentId } = await stageCompleteWorkflow(app.appId, app);
		const missingIntent = asDesignId(crypto.randomUUID());
		const before = await canonicalTableCounts(app.appId);
		const outcome = await commitDesignChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 3,
			owningIntentIds: [intentId, missingIntent],
		});
		expect(outcome).toMatchObject({
			kind: "gate-rejected",
			message: expect.stringMatching(/does not cover every construction group/),
		});
		expect(await canonicalTableCounts(app.appId)).toEqual(before);
		expect((await loadChangeSet(changeSet.id))?.status).toBe("open");
	});

	it("refuses a durable step that claims a group outside the slice", async () => {
		const app = await createTestApp();
		const { changeSet } = await stageCompleteWorkflow(app.appId, app);
		const outcome = await commitDesignChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 3,
			owningIntentIds: [asDesignId(crypto.randomUUID())],
		});
		expect(outcome).toMatchObject({
			kind: "gate-rejected",
			message: expect.stringMatching(/not assigned to this slice/),
		});
		expect((await loadChangeSet(changeSet.id))?.status).toBe("open");
	});

	it("merges cleanly over a newer canonical head (clean replay)", async () => {
		const app = await createTestApp();
		const { changeSet, intentId } = await stageCompleteWorkflow(app.appId, app);

		await commitGuardedBatch({
			appId: app.appId,
			batchId: crypto.randomUUID(),
			mutations: admitMutationBatch([
				{ kind: "setAppName", name: "Concurrently renamed" },
			]),
			actorUserId: ACTOR,
			kind: "autosave",
			expectedProjectId: PROJECT,
		});

		const outcome = await commitDesignChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 3,
			owningIntentIds: [intentId],
		});
		expect(outcome.kind).toBe("committed");
		if (outcome.kind !== "committed") throw new Error("unreachable");
		expect(outcome.receipt.seq).toBe(3);
		const counts = await canonicalTableCounts(app.appId);
		expect(counts.appName).toBe("Concurrently renamed");
	});

	it("returns a structured TARGET_REMOVED rebase report and retains every step", async () => {
		const app = await createTestApp();

		/* A second module committed canonically, then targeted by a staged
		 * edit, then removed canonically — the staged step's target vanished. */
		const module2: Module = {
			uuid: asUuid(crypto.randomUUID()),
			id: "second",
			name: "Second",
		};
		const form2: Form = {
			uuid: asUuid(crypto.randomUUID()),
			id: "second_form",
			name: "Second form",
			type: "survey",
		};
		const field2 = starterFieldClone(app.doc, app.starter.fieldUuid);
		await commitGuardedBatch({
			appId: app.appId,
			batchId: crypto.randomUUID(),
			mutations: admitMutationBatch([
				{ kind: "addModule", module: module2 },
				{ kind: "addForm", moduleUuid: module2.uuid, form: form2 },
				{ kind: "addField", parentUuid: form2.uuid, field: field2 },
			] satisfies Mutation[]),
			actorUserId: ACTOR,
			kind: "autosave",
			expectedProjectId: PROJECT,
		});

		const { changeSet, workspace } = await openWorkspace(app.appId);
		const intentId = asDesignId(crypto.randomUUID());
		const staged = await workspace.invoke({
			toolName: "removeField-direct",
			requestId: "r-1",
			input: { fieldUuid: field2.uuid },
			execute: async (ctx) =>
				ctx.applyBatch({
					mutations: [
						{ kind: "removeField", uuid: field2.uuid },
					] satisfies Mutation[],
					intentIds: [intentId],
				}),
		});
		expect(staged.ok).toBe(true);

		await commitGuardedBatch({
			appId: app.appId,
			batchId: crypto.randomUUID(),
			mutations: admitMutationBatch([
				{ kind: "removeModule", uuid: module2.uuid },
			] satisfies Mutation[]),
			actorUserId: ACTOR,
			kind: "autosave",
			expectedProjectId: PROJECT,
		});

		const outcome = await commitDesignChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 1,
			owningIntentIds: [intentId],
		});
		expect(outcome.kind).toBe("rebase-conflict");
		if (outcome.kind !== "rebase-conflict") throw new Error("unreachable");
		expect(outcome.report.conflicts).toEqual([
			expect.objectContaining({ code: "TARGET_REMOVED", stepOrdinal: 0 }),
		]);

		/* Steps retained, set still open, no canonical write happened. */
		expect((await loadChangeSet(changeSet.id))?.status).toBe("open");
		expect(await loadChangeSetSteps(changeSet.id)).toHaveLength(1);
	});

	it("rejects a candidate the fresh gate refuses, retaining amendable steps", async () => {
		const app = await createTestApp();
		const { changeSet, workspace } = await openWorkspace(app.appId);
		const intentId = asDesignId(crypto.randomUUID());

		/* Removing the starter question leaves EMPTY_FORM — stageable
		 * privately, refused canonically. */
		const staged = await workspace.invoke({
			toolName: "removeField-direct",
			requestId: "gate-1",
			input: { fieldUuid: app.starter.fieldUuid },
			execute: async (ctx) =>
				ctx.applyBatch({
					mutations: [
						{ kind: "removeField", uuid: app.starter.fieldUuid },
					] satisfies Mutation[],
					intentIds: [intentId],
				}),
		});
		expect(staged.ok).toBe(true);
		const before = await canonicalTableCounts(app.appId);

		const outcome = await commitDesignChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 1,
			owningIntentIds: [intentId],
		});
		expect(outcome.kind).toBe("gate-rejected");
		expect(await canonicalTableCounts(app.appId)).toEqual(before);
		expect((await loadChangeSet(changeSet.id))?.status).toBe("open");
		expect(await loadChangeSetSteps(changeSet.id)).toHaveLength(1);
	});

	it("is terminal after a Project move", async () => {
		const app = await createTestApp();
		const { changeSet, intentId } = await stageCompleteWorkflow(app.appId, app);
		await h.seedProjectMember(ACTOR, "project-b", "owner");
		await h.moveAppToProject(app.appId, "project-b", ACTOR);

		await expect(
			commitDesignChangeSet({
				changeSetId: changeSet.id,
				actorUserId: ACTOR,
				runId: RUN,
				kind: "mcp",
				expectedRevision: 3,
				owningIntentIds: [intentId],
			}),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);
	});

	it("writes intent provenance rows in the commit transaction", async () => {
		const app = await createTestApp();
		const { changeSet, intentId } = await stageCompleteWorkflow(app.appId, app);

		const outcome = await commitDesignChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 3,
			owningIntentIds: [intentId],
		});
		expect(outcome.kind).toBe("committed");
		if (outcome.kind !== "committed") throw new Error("unreachable");

		const rows = await h
			.db()
			.selectFrom("app_change_intents")
			.select(["intent_id", "coordinate_kind"])
			.where("app_id", "=", app.appId)
			.execute();
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					intent_id: intentId,
					coordinate_kind: "module",
				}),
				expect.objectContaining({
					intent_id: intentId,
					coordinate_kind: "form",
				}),
				expect.objectContaining({
					intent_id: intentId,
					coordinate_kind: "field",
				}),
			]),
		);
	});
});
