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

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asDesignId } from "@/lib/agent/design/ids";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database } from "@/lib/case-store/sql/database";
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
	loadHandleBindings,
	stageChangeSetRequest,
} from "../store";
import type { ChangeSetLineage } from "../types";
import {
	ChangeSetMutationWorkspace,
	type ChangeSetWorkspaceHost,
} from "../workspace";

/* Route the case store to the per-test database — production parity, just
 * bypassing the singleton's Cloud SQL connector. The same recipe as
 * `materializeGenesis.integration.test.ts`.
 *
 * These tests need it because a change set that edits worker properties
 * changes the `commcare-user` case type's property surface, so the commit
 * materializes a schema the way any other case-type change does. Without the
 * routing the commit reaches the real connector and fails on a missing
 * `NOVA_DB_WORKLOAD`, which is the singleton refusing to guess a connection
 * budget rather than anything wrong with the commit. */
const { withSchemaContextMock, withProjectContextMock } = vi.hoisted(() => ({
	withSchemaContextMock: vi.fn(),
	withProjectContextMock: vi.fn(),
}));
vi.mock("@/lib/case-store", async () => {
	const actual = (await vi.importActual("@/lib/case-store")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		withSchemaContext: withSchemaContextMock,
		withProjectContext: withProjectContextMock,
	};
});

const h = setupAppStateTestDb("change_set_runtime_");

beforeEach(() => {
	withSchemaContextMock.mockReset();
	withProjectContextMock.mockReset();
	const store = (projectId: string | null, ownerId: string | null) =>
		new PostgresCaseStore({
			projectId,
			actorUserId: ACTOR,
			ownerId,
			db: h.db() as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
	withSchemaContextMock.mockImplementation(async () => store(null, null));
	withProjectContextMock.mockImplementation(
		async (projectId: string, _actor: string, ownerId: string) =>
			store(projectId, ownerId),
	);
});

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
	it("keeps built-in menu icons out of the uploaded-media read set", async () => {
		const app = await createTestApp();
		const { changeSet, workspace } = await openWorkspace(app.appId);
		const staged = await workspace.stageDispatch({
			toolName: "setMenuMedia",
			requestId: "built-in-menu-icon",
			input: {
				items: [
					{
						target: "module",
						moduleUuid: app.starter.moduleUuid,
						icon: "nutrition",
						audioLabel: null,
					},
				],
			},
		});

		expect(staged.receipt?.disposition).toBe("staged");
		expect(
			workspace.currentSnapshot().doc.modules[app.starter.moduleUuid]?.icon,
		).toBe("nova-icon:nutrition");
		expect((await loadChangeSetSteps(changeSet.id))[0]?.readSet).toEqual([]);
	});

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
			code: "TOOL_INPUT_INVALID",
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

	it("replays a lost response with identical receipt, handles, and revision — and survives process death", async () => {
		const app = await createTestApp();
		const { changeSet, workspace } = await openWorkspace(app.appId);
		const input = {
			moduleUuid: { handle: "@m" },
			name: "Visits",
			case_type: null,
			forms: [
				{
					formUuid: { handle: "@visit_form" },
					name: "Record visit",
					type: "survey",
					fields: [
						{
							fieldUuid: { handle: "@visit_note" },
							kind: "text",
							id: "visit_note",
							label: proseText("Visit note"),
						},
					],
				},
			],
		};
		const first = await workspace.stageDispatch({
			toolName: "createModule",
			requestId: "call-1",
			input,
		});

		/* Same workspace instance. */
		const replay = await workspace.stageDispatch({
			toolName: "createModule",
			requestId: "call-1",
			input,
		});
		expect(replay.replayed).toBe(true);
		expect(replay.receipt).toEqual(first.receipt);

		/* A NEW process: rehydrate from durable state alone. */
		const reopened = await ChangeSetMutationWorkspace.open(host, changeSet.id);
		expect(reopened.currentSnapshot().revision).toBe(1);
		expect(canonicalJsonDigest(reopened.currentSnapshot().doc.modules)).toBe(
			canonicalJsonDigest(workspace.currentSnapshot().doc.modules),
		);
		expect(reopened.currentExecutionCheckpoint().handles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ handle: "@m", entityKind: "module" }),
			]),
		);
		const replayAfterDeath = await reopened.stageDispatch({
			toolName: "createModule",
			requestId: "call-1",
			input,
		});
		expect(replayAfterDeath.replayed).toBe(true);
		expect(replayAfterDeath.receipt).toEqual(first.receipt);
	});

	it("prunes a removed handle from the verified projection while retaining its append-only declaration", async () => {
		const app = await createTestApp();
		const { changeSet, workspace } = await openWorkspace(app.appId);
		await workspace.stageDispatch({
			toolName: "createModule",
			requestId: "temporary-module",
			input: {
				moduleUuid: { handle: "@temporary" },
				name: "Temporary",
				case_type: null,
				forms: [
					{
						formUuid: { handle: "@temporary_form" },
						name: "Temporary form",
						type: "survey",
						fields: [
							{
								fieldUuid: { handle: "@temporary_note" },
								kind: "text",
								id: "temporary_note",
								label: proseText("Temporary note"),
							},
						],
					},
				],
			},
		});
		expect(workspace.currentExecutionCheckpoint().handles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ handle: "@temporary", entityKind: "module" }),
			]),
		);
		await workspace.stageDispatch({
			toolName: "removeModule",
			requestId: "remove-temporary-module",
			input: { moduleUuid: { handle: "@temporary" } },
		});
		expect(workspace.currentExecutionCheckpoint().handles).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ handle: "@temporary" }),
			]),
		);
		expect(await loadHandleBindings(changeSet.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					handle: "@temporary",
					entityKind: "module",
				}),
				expect.objectContaining({ handle: "@temporary_form" }),
				expect.objectContaining({ handle: "@temporary_note" }),
			]),
		);
		const reopened = await ChangeSetMutationWorkspace.open(host, changeSet.id);
		expect(reopened.currentExecutionCheckpoint().handles).toEqual([]);
	});

	it("carries worker symbols across model steps, process recovery, commit, and a later slice", async () => {
		const app = await createTestApp();
		const sharedLineage = await lineage();
		const first = await beginAppEditChangeSet({
			appId: app.appId,
			expectedProjectId: PROJECT,
			lineage: sharedLineage,
			ownerUserId: ACTOR,
			ownerRunId: RUN,
		});
		await h
			.db()
			.updateTable("design_slice_attempts")
			.set({ change_set_id: first.id })
			.where("id", "=", first.attemptId)
			.execute();
		const firstWorkspace = await ChangeSetMutationWorkspace.open(
			host,
			first.id,
		);

		const workerProperty = await firstWorkspace.stageDispatch({
			toolName: "addUserProperties",
			requestId: "worker-property-step",
			input: {
				properties: [
					{
						userPropertyUuid: { handle: "@worker_role" },
						slug: "worker_role",
						label: "Worker role",
						choices: ["supervisor", "agent"],
					},
				],
			},
		});
		const workerPropertyUuid =
			workerProperty.receipt?.handles[
				changeSetHandleSchema.parse("@worker_role")
			];
		if (workerPropertyUuid === undefined)
			throw new Error("worker property handle was not bound");

		/* This is the original failure boundary: the worker property was created
		 * in one model step, then the in-memory workspace disappeared before a
		 * later createModule referenced it. */
		const recovered = await ChangeSetMutationWorkspace.open(host, first.id);
		expect(recovered.currentExecutionCheckpoint()).toMatchObject({
			handles: [
				{
					handle: "@worker_role",
					uuid: workerPropertyUuid,
					entityKind: "worker_property",
				},
			],
		});

		await recovered.stageDispatch({
			toolName: "addUserTypes",
			requestId: "worker-type-step",
			input: {
				userTypes: [
					{
						userTypeUuid: { handle: "@supervisor_type" },
						name: "Supervisor",
						values: [
							{
								userPropertyUuid: { handle: "@worker_role" },
								value: "supervisor",
							},
						],
					},
				],
			},
		});
		await recovered.stageDispatch({
			toolName: "addPersonas",
			requestId: "persona-step",
			input: {
				personas: [
					{
						personaUuid: { handle: "@asha" },
						name: "Asha",
						userTypeUuid: { handle: "@supervisor_type" },
						values: [
							{
								userPropertyUuid: { handle: "@worker_role" },
								value: "supervisor",
							},
						],
					},
				],
			},
		});
		await recovered.stageDispatch({
			toolName: "addLocationProperties",
			requestId: "location-property-step",
			input: {
				properties: [
					{
						locationPropertyUuid: { handle: "@facility_code" },
						slug: "facility_code",
						label: "Facility code",
					},
				],
			},
		});
		const module = await recovered.stageDispatch({
			toolName: "createModule",
			requestId: "later-module-step",
			input: {
				moduleUuid: { handle: "@restricted_module" },
				name: "Restricted workflow",
				case_type: null,
				forms: [
					{
						formUuid: { handle: "@restricted_form" },
						name: "Restricted survey",
						type: "survey",
						fields: [
							{
								fieldUuid: { handle: "@restricted_note" },
								kind: "text",
								id: "note",
								label: proseText("Note"),
								relevant: {
									parts: [
										{
											kind: "user-property-ref",
											userPropertyUuid: { handle: "@worker_role" },
										},
										{ kind: "text", text: " = 'supervisor'" },
									],
								},
							},
						],
					},
				],
			},
		});
		const noteUuid =
			module.receipt?.handles[changeSetHandleSchema.parse("@restricted_note")];
		if (noteUuid === undefined) throw new Error("note handle was not bound");
		expect(
			(
				recovered.currentSnapshot().doc.fields[noteUuid] as
					| { relevant?: unknown }
					| undefined
			)?.relevant,
		).toEqual({
			parts: [
				{
					kind: "user-property-ref",
					userPropertyUuid: workerPropertyUuid,
				},
				{ kind: "text", text: " = 'supervisor'" },
			],
		});
		expect((await recovered.inspect()).canCommit).toBe(true);
		const firstCommit = await commitDesignChangeSet({
			changeSetId: first.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 5,
		});
		expect(firstCommit.kind).toBe("committed");
		if (firstCommit.kind !== "committed") throw new Error("first slice failed");

		const priorAttempt = await h
			.db()
			.selectFrom("design_slice_attempts")
			.selectAll()
			.where("id", "=", sharedLineage.attemptId)
			.executeTakeFirstOrThrow();
		const secondAttemptId = crypto.randomUUID();
		const secondSliceId = asDesignId(crypto.randomUUID());
		await h
			.db()
			.insertInto("design_slice_attempts")
			.values({
				...priorAttempt,
				id: secondAttemptId,
				slice_id: secondSliceId,
				attempt: 1,
				base_kind: "app",
				base_app_id: app.appId,
				base_proposed_app_id: null,
				base_seq: firstCommit.receipt.seq,
				base_snapshot_digest: firstCommit.receipt.committedSnapshotDigest,
				change_set_id: null,
				brief_digest: canonicalJsonDigest(`brief:${secondAttemptId}`),
				execution_run_ids: JSON.stringify([RUN]),
				status: "running",
				failure_code: null,
				wall_clock_ms_used: 0,
				wall_clock_accrued_at: new Date(),
				created_at: new Date(),
				updated_at: new Date(),
			})
			.execute();
		const secondLineage: ChangeSetLineage = {
			...sharedLineage,
			sliceId: secondSliceId,
			attemptId: secondAttemptId,
		};
		const second = await beginAppEditChangeSet({
			appId: app.appId,
			expectedProjectId: PROJECT,
			lineage: secondLineage,
			ownerUserId: ACTOR,
			ownerRunId: RUN,
		});
		await h
			.db()
			.updateTable("design_slice_attempts")
			.set({ change_set_id: second.id })
			.where("id", "=", secondAttemptId)
			.execute();
		const secondWorkspace = await ChangeSetMutationWorkspace.open(
			host,
			second.id,
		);
		expect(secondWorkspace.currentExecutionCheckpoint().handles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					handle: "@worker_role",
					uuid: workerPropertyUuid,
					entityKind: "worker_property",
				}),
				expect.objectContaining({
					handle: "@supervisor_type",
					entityKind: "user_type",
				}),
				expect.objectContaining({
					handle: "@facility_code",
					entityKind: "location_property",
				}),
			]),
		);
		const laterPersona = await secondWorkspace.stageDispatch({
			toolName: "addPersonas",
			requestId: "later-slice-persona",
			input: {
				personas: [
					{
						personaUuid: { handle: "@later_persona" },
						name: "Later slice persona",
						userTypeUuid: { handle: "@supervisor_type" },
						values: [
							{
								userPropertyUuid: { handle: "@worker_role" },
								value: "supervisor",
							},
						],
					},
				],
			},
		});
		expect(laterPersona.result).not.toHaveProperty("error");
		const reopenedSecond = await ChangeSetMutationWorkspace.open(
			host,
			second.id,
		);
		expect(reopenedSecond.currentExecutionCheckpoint().handles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ handle: "@worker_role" }),
				expect.objectContaining({ handle: "@later_persona" }),
			]),
		);
		await reopenedSecond.stageDispatch({
			toolName: "removeModule",
			requestId: "remove-inherited-module",
			input: { moduleUuid: { handle: "@restricted_module" } },
		});
		const reopenedAfterInheritedDelete = await ChangeSetMutationWorkspace.open(
			host,
			second.id,
		);
		expect(
			reopenedAfterInheritedDelete.currentExecutionCheckpoint().handles,
		).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ handle: "@restricted_module" }),
				expect.objectContaining({ handle: "@restricted_form" }),
				expect.objectContaining({ handle: "@restricted_note" }),
			]),
		);
		expect((await reopenedAfterInheritedDelete.inspect()).canCommit).toBe(true);
		expect(
			await commitDesignChangeSet({
				changeSetId: second.id,
				actorUserId: ACTOR,
				runId: RUN,
				kind: "mcp",
				expectedRevision: 2,
			}),
		).toMatchObject({ kind: "committed" });
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
		const { changeSet, workspace } = await openWorkspace(app.appId);

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
		expect(noop.receipt?.disposition).toBe("noop");

		const reopened = await ChangeSetMutationWorkspace.open(host, changeSet.id);
		const replay = await reopened.stageDispatch({
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
		expect(replay.replayed).toBe(true);
		expect(replay.receipt).toEqual(noop.receipt);
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
			toolName: "createModule",
			requestId: "call-1",
			input: {
				moduleUuid: { handle: "@ordinary" },
				name: "Ordinary first",
				case_type: null,
				forms: [
					{
						formUuid: { handle: "@ordinary_form" },
						name: "Ordinary form",
						type: "survey",
						fields: [
							{
								fieldUuid: { handle: "@ordinary_field" },
								kind: "text",
								id: "ordinary_field",
								label: proseText("Ordinary field"),
							},
						],
					},
				],
			},
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
				retainedHandleUuids: [],
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
			toolName: "createModule",
			requestId: "call-2",
			input: {
				moduleUuid: { handle: "@after_exclusive" },
				name: "After exclusive",
				case_type: null,
				forms: [
					{
						formUuid: { handle: "@after_exclusive_form" },
						name: "After exclusive form",
						type: "survey",
						fields: [
							{
								fieldUuid: { handle: "@after_exclusive_field" },
								kind: "text",
								id: "after_exclusive_field",
								label: proseText("After exclusive field"),
							},
						],
					},
				],
			},
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
			toolName: "createModule",
			requestId: "g-1",
			input: {
				moduleUuid: { handle: "@m" },
				name: "Survey",
				case_type: null,
				forms: [
					{
						formUuid: { handle: "@f" },
						name: "Survey form",
						type: "survey",
						fields: [
							{
								fieldUuid: { handle: "@question" },
								kind: "text",
								id: "question",
								label: proseText("Question"),
							},
						],
					},
				],
			},
		});
		await workspace.stageDispatch({
			toolName: "setMenuMedia",
			requestId: "g-2",
			input: {
				items: [
					{
						target: "module",
						moduleUuid: { handle: "@m" },
						icon: "nutrition",
						audioLabel: null,
					},
				],
			},
		});
		const complete = await workspace.inspect();
		expect(complete.allFindings).toEqual([]);
		expect(complete.finalizationFindings).toEqual([]);
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
			}),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);
	});
});

describe("commitDesignChangeSet", () => {
	async function stageCompleteWorkflow(appId: string) {
		const { changeSet, workspace } = await openWorkspace(appId);
		await workspace.stageDispatch({
			toolName: "createModule",
			requestId: "c-1",
			input: {
				moduleUuid: { handle: "@m" },
				name: "Committed module",
				case_type: null,
				forms: [
					{
						formUuid: { handle: "@f" },
						name: "Committed form",
						type: "survey",
						fields: [
							{
								fieldUuid: { handle: "@field" },
								kind: "text",
								id: "committed_field",
								label: proseText("Committed field"),
							},
						],
					},
				],
			},
		});
		return { changeSet, workspace };
	}

	it("commits all steps as ONE canonical batch with the receipt sidecar, atomically", async () => {
		const app = await createTestApp();
		const { changeSet } = await stageCompleteWorkflow(app.appId);
		const before = await canonicalTableCounts(app.appId);
		await h
			.db()
			.updateTable("design_slice_attempts")
			.set({ outcome_evidence_state: "collecting" })
			.where("id", "=", changeSet.attemptId)
			.executeTakeFirstOrThrow();

		const outcome = await commitDesignChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 1,
		});
		expect(outcome.kind).toBe("committed");
		if (outcome.kind !== "committed") throw new Error("unreachable");
		expect(outcome.replayed).toBe(false);
		expect(outcome.receipt.seq).toBe(before.mutationSeq + 1);
		expect(outcome.receipt.batchId).toMatch(
			new RegExp(`^design-change-set:${changeSet.id}:r1:[a-f0-9]{24}$`),
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
			.select(["status", "outcome_evidence_state"])
			.where("change_set_id", "=", changeSet.id)
			.executeTakeFirst();
		expect(attempt?.status).toBe("committed");
		expect(attempt?.outcome_evidence_state).toBe("complete");

		/* A commit retry converges on the stored receipt. */
		const retry = await commitDesignChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
			kind: "mcp",
			expectedRevision: 1,
		});
		expect(retry.kind).toBe("committed");
		if (retry.kind !== "committed") throw new Error("unreachable");
		expect(retry.replayed).toBe(true);
		expect(retry.receipt).toEqual(outcome.receipt);
		expect(await canonicalTableCounts(app.appId)).toEqual(after);
	});

	it("merges cleanly over a newer canonical head (clean replay)", async () => {
		const app = await createTestApp();
		const { changeSet } = await stageCompleteWorkflow(app.appId);

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
			expectedRevision: 1,
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
		const staged = await workspace.invoke({
			toolName: "removeField-direct",
			requestId: "r-1",
			input: { fieldUuid: field2.uuid },
			execute: async (ctx) =>
				ctx.applyBatch({
					mutations: [
						{ kind: "removeField", uuid: field2.uuid },
					] satisfies Mutation[],
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
		});
		expect(outcome.kind).toBe("gate-rejected");
		expect(await canonicalTableCounts(app.appId)).toEqual(before);
		expect((await loadChangeSet(changeSet.id))?.status).toBe("open");
		expect(await loadChangeSetSteps(changeSet.id)).toHaveLength(1);
	});

	it("is terminal after a Project move", async () => {
		const app = await createTestApp();
		const { changeSet } = await stageCompleteWorkflow(app.appId);
		await h.seedProjectMember(ACTOR, "project-b", "owner");
		await h.moveAppToProject(app.appId, "project-b", ACTOR);

		await expect(
			commitDesignChangeSet({
				changeSetId: changeSet.id,
				actorUserId: ACTOR,
				runId: RUN,
				kind: "mcp",
				expectedRevision: 1,
			}),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);
	});
});
