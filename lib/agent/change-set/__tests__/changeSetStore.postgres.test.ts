import { afterEach, expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import {
	beginPlanReview,
	finishPlanReview,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import {
	addAutomationsTool,
	updateAutomationTool,
} from "@/lib/agent/tools/automations";
import { getAuthDb } from "@/lib/auth/db";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createAndClaimDesignSessionRun } from "@/lib/db/designSessions";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Automation } from "@/lib/domain";
import { asUuid } from "@/lib/domain/uuid";
import { emptyGenesisBase } from "../baseLoader";
import { canonicalJsonDigest, workspaceCallInputDigest } from "../digest";
import {
	ChangeSetRequestIdCollisionError,
	ChangeSetWorkspaceRevisionStaleError,
} from "../errors";
import { rehydrateChangeSet } from "../runtime";
import {
	__setStageTransactionFaultHookForTests,
	abandonChangeSet,
	beginGenesisChangeSet,
	loadChangeSet,
	loadChangeSetSteps,
	lookupStageRequest,
	resumeOpenChangeSet,
	type StageChangeSetRequestArgs,
	type StageTransactionBoundary,
	stageChangeSetRequest,
} from "../store";
import { ChangeSetMutationWorkspace } from "../workspace";

const h = setupAppStateTestDb("authoring_workspace_", {
	authSchema: "migrated",
	poolMax: 4,
});
const ACTOR = "architect";
const PROJECT = "workspace-project";
const RUN = "build-run";

async function session() {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	const claimed = await createAndClaimDesignSessionRun({
		projectId: PROJECT,
		actorUserId: ACTOR,
		runId: RUN,
		cost: 100,
	});
	const authority = {
		sessionId: claimed.designSessionId,
		projectId: PROJECT,
		actorUserId: ACTOR,
		runId: RUN,
		holderNonce: claimed.holderNonce,
	};
	await writeAppPlan({
		authority,
		writer: { editor: "architect" },
		requestId: "plan",
		expectedRevision: 0,
		change: {
			markdown: "Record individual loans, then return the selected loan.",
		},
	});
	const begin = {
		lineage: { designSessionId: claimed.designSessionId, planRevision: 1 },
		ownerUserId: ACTOR,
		ownerRunId: RUN,
		holderNonce: claimed.holderNonce,
		proposedAppId: claimed.proposedAppId,
		projectId: PROJECT,
		baseSnapshotDigest: emptyGenesisBase(claimed.proposedAppId).digest,
	};
	return {
		authority,
		begin,
		holder: {
			source: "chat" as const,
			mode: "build" as const,
			runId: RUN,
			nonce: claimed.holderNonce,
		},
	};
}
async function open() {
	const fixture = await session();
	const review = await beginPlanReview(fixture.authority, "review");
	await finishPlanReview(fixture.authority, review.reviewId);
	const workspace = await beginGenesisChangeSet(fixture.begin);
	return { ...fixture, workspace };
}
function stage(
	fixture: Awaited<ReturnType<typeof open>>,
	overrides: Partial<StageChangeSetRequestArgs> = {},
): StageChangeSetRequestArgs {
	const mutations = admitMutationBatch([
		{ kind: "setAppName", name: "Tool library" },
	]);
	return {
		changeSetId: fixture.workspace.id,
		requestId: "name",
		toolName: "updateApp",
		expectedRevision: 0,
		actorUserId: ACTOR,
		runId: RUN,
		chatRunHolder: fixture.holder,
		inputDigest: workspaceCallInputDigest({
			toolName: "updateApp",
			expectedWorkspaceRevision: 0,
			projectedInput: { name: "Tool library" },
		}),
		outcome: {
			kind: "stage",
			replayResult: { kind: "mutate", mutations: [], result: { ok: true } },
			mutations,
			stageSlices: [{ stage: "Name", start: 0, end: 1 }],
			exclusiveKind: null,
			diagnostics: {
				candidateDigest: canonicalJsonDigest("advisory"),
				findingCount: 0,
				findingFingerprints: [],
				canCommit: false,
			},
		},
		...overrides,
	};
}
afterEach(() => __setStageTransactionFaultHookForTests(null));

async function toolWorkspace(fixture: Awaited<ReturnType<typeof open>>) {
	return ChangeSetMutationWorkspace.open(
		{
			actorUserId: ACTOR,
			runId: RUN,
			chatRunHolder: fixture.holder,
			conversionImpact: async () => {
				throw new Error("This test does not convert fields");
			},
		},
		fixture.workspace.id,
	);
}

it("proves an unchanged private automation without reading an app and replays that semantic answer", async () => {
	const fixture = await open();
	const workspace = await toolWorkspace(fixture);
	await workspace.stageDispatch({
		toolName: "createModule",
		requestId: "visits",
		input: {
			name: "Visits",
			case_type: "visit",
			forms: [
				{
					name: "Register",
					type: "registration",
					fields: [
						{
							kind: "text",
							id: "state",
							label: "State",
							caseWrite: { caseType: "visit", property: "state" },
						},
					],
				},
			],
		},
	});
	const automation: Automation = {
		uuid: asUuid(crypto.randomUUID()),
		name: "Resolve visits",
		kind: "case-update",
		caseType: "visit",
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		closeCase: false,
		updates: [
			{
				uuid: asUuid(crypto.randomUUID()),
				target: { scope: "case", property: "state" },
				value: { kind: "literal", value: "resolved" },
			},
		],
	};
	await workspace.invoke({
		toolName: "addAutomations",
		requestId: "rule",
		input: { automations: [automation] },
		execute: (ctx) =>
			addAutomationsTool.execute({ automations: [automation] }, ctx),
	});
	const revision = workspace.current().revision;
	const call = {
		toolName: "updateAutomation",
		requestId: "unchanged",
		input: { automation },
		execute: (ctx: Parameters<typeof updateAutomationTool.execute>[1]) =>
			updateAutomationTool.execute({ automation }, ctx),
	};
	const result = await workspace.invoke(call);
	expect(result).toMatchObject({
		kind: "mutate",
		mutations: [],
		result: { ok: true, unchanged: true, automationUuids: [automation.uuid] },
	});
	expect(workspace.current().revision).toBe(revision);
	const reopened = await toolWorkspace(fixture);
	expect(await reopened.invoke(call)).toEqual(result);
	expect(await h.db().selectFrom("apps").select("id").execute()).toEqual([]);
});

it("replays a shared creation's exact identities after concurrent retries and reopening", async () => {
	const fixture = await open();
	const first = await toolWorkspace(fixture);
	const second = await toolWorkspace(fixture);
	const call = {
		toolName: "createModule",
		requestId: "create",
		input: {
			name: "Intake",
			forms: [
				{
					name: "Register",
					type: "survey",
					fields: [{ kind: "text", id: "name", label: "Name" }],
				},
			],
		},
	};
	const results = await whileBlocked(
		h,
		(pg) =>
			pg.query("SELECT id FROM design_sessions WHERE id = $1 FOR UPDATE", [
				fixture.authority.sessionId,
			]),
		() => Promise.all([first.stageDispatch(call), second.stageDispatch(call)]),
		async (settled, pg) => {
			expect(settled).toBe(false);
			await expect
				.poll(async () => {
					await pg.query("SELECT pg_stat_clear_snapshot()");
					const rows = await pg.query<{ count: number }>(
						"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0",
					);
					return rows.rows[0].count;
				})
				.toBe(2);
		},
	);
	expect(results[1].result).toEqual(results[0].result);
	const recovered = await toolWorkspace(fixture);
	expect((await recovered.stageDispatch(call)).result).toEqual(
		results[0].result,
	);
	expect(results[0].result).toMatchObject({
		kind: "mutate",
		result: {
			ok: true,
			moduleUuid: recovered.currentSnapshot().doc.moduleOrder[0],
		},
	});
	expect(await loadChangeSetSteps(fixture.workspace.id)).toHaveLength(1);
});

it("does not stage an edit when its tool fails after preparing the candidate", async () => {
	const fixture = await open();
	const workspace = await toolWorkspace(fixture);
	const before = workspace.currentSnapshot();
	await expect(
		workspace.invoke({
			toolName: "updateApp",
			requestId: "failure",
			input: { name: "Lost" },
			execute: async (ctx) => {
				const prepared = await ctx.applyBatch({
					mutations: [{ kind: "setAppName", name: "Lost" }],
				});
				expect(prepared.ok).toBe(true);
				throw new Error("Failed to prepare the answer");
			},
		}),
	).rejects.toThrow("Failed to prepare the answer");
	expect(workspace.currentSnapshot()).toEqual(before);
	expect(await loadChangeSetSteps(fixture.workspace.id)).toEqual([]);
	expect(
		await lookupStageRequest(fixture.workspace.id, "failure"),
	).toBeUndefined();
});

it("preserves rejection details in the shared tool envelope after recovery", async () => {
	const fixture = await open();
	const workspace = await toolWorkspace(fixture);
	const call = {
		toolName: "updateApp",
		requestId: "rejected",
		input: { name: "Invalid" },
		execute: async (
			ctx: import("@/lib/agent/workspace/types").ToolInvocationContext,
		) => {
			const outcome = await ctx.applyBatch({
				mutations: [
					{
						kind: "updateForm",
						uuid: crypto.randomUUID(),
						form: { name: "Missing" },
					},
				],
			});
			if (outcome.ok) throw new Error("A nonexistent target was accepted");
			return {
				kind: "mutate" as const,
				mutations: [],
				result: { error: outcome.error },
			};
		},
	};
	const first = await workspace.invoke(call);
	expect(first.result.error).toBeTruthy();
	expect(await (await toolWorkspace(fixture)).invoke(call)).toEqual(first);
	expect(await loadChangeSetSteps(fixture.workspace.id)).toEqual([]);
});

it("requires peer review and admits one private workspace for the session", async () => {
	const fixture = await session();
	await expect(beginGenesisChangeSet(fixture.begin)).rejects.toThrow(
		"peer review",
	);
	const review = await beginPlanReview(fixture.authority, "review");
	await finishPlanReview(fixture.authority, review.reviewId);
	const workspace = await beginGenesisChangeSet(fixture.begin);
	await expect(beginGenesisChangeSet(fixture.begin)).rejects.toThrow(
		"still open",
	);
	expect(workspace.baseSnapshotDigest).toBe(fixture.begin.baseSnapshotDigest);
	expect(await h.db().selectFrom("apps").select("id").execute()).toEqual([]);
});

it("recovers exact mutations and idempotent results without creating a visible app", async () => {
	const fixture = await open();
	const call = stage(fixture);
	const first = await stageChangeSetRequest(call);
	expect(await stageChangeSetRequest(call)).toEqual({
		...first,
		replayed: true,
	});
	await expect(
		stageChangeSetRequest({
			...call,
			inputDigest: canonicalJsonDigest("different"),
		}),
	).rejects.toBeInstanceOf(ChangeSetRequestIdCollisionError);
	const recovered = await resumeOpenChangeSet({
		designSessionId: fixture.authority.sessionId,
		projectId: PROJECT,
		actorUserId: ACTOR,
		runId: RUN,
		holderNonce: fixture.holder.nonce,
	});
	if (!recovered) throw new Error("Missing recovered workspace");
	expect((await rehydrateChangeSet(recovered)).overlay.doc.appName).toBe(
		"Tool library",
	);
	expect(await loadChangeSetSteps(recovered.id)).toHaveLength(1);
	expect(await h.db().selectFrom("apps").select("id").execute()).toEqual([]);
	expect(
		await h.db().selectFrom("app_changes").select("app_id").execute(),
	).toEqual([]);
});

it.each<StageTransactionBoundary>([
	"after-authority-lock",
	"after-ledger-read",
	"after-request-insert",
	"after-step-insert",
	"after-stage-insert",
	"after-advance",
])("rolls back every staged write after a failure at %s", async (boundary) => {
	const fixture = await open();
	const call = stage(fixture);
	__setStageTransactionFaultHookForTests((at) => {
		if (at === boundary) throw new Error("Injected transaction failure");
	});
	await expect(stageChangeSetRequest(call)).rejects.toThrow(
		"Injected transaction failure",
	);
	expect((await loadChangeSet(fixture.workspace.id))?.revision).toBe(0);
	expect(
		await lookupStageRequest(fixture.workspace.id, call.requestId),
	).toBeUndefined();
	expect(await loadChangeSetSteps(fixture.workspace.id)).toEqual([]);
	__setStageTransactionFaultHookForTests(null);
	expect((await stageChangeSetRequest(call)).receipt.disposition).toBe(
		"staged",
	);
});

it("serializes independent database writers before advancing a workspace revision", async () => {
	const fixture = await open();
	const results = await whileBlocked(
		h,
		(pg) =>
			pg.query("SELECT id FROM design_sessions WHERE id = $1 FOR UPDATE", [
				fixture.authority.sessionId,
			]),
		() =>
			Promise.allSettled([
				stageChangeSetRequest(stage(fixture, { requestId: "one" })),
				stageChangeSetRequest(stage(fixture, { requestId: "two" })),
			]),
		async (settled, pg) => {
			expect(settled).toBe(false);
			await expect
				.poll(async () => {
					await pg.query("SELECT pg_stat_clear_snapshot()");
					const waiters = await pg.query<{ count: number }>(
						"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0",
					);
					return waiters.rows[0].count;
				})
				.toBe(2);
		},
	);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	const rejected = results.find((result) => result.status === "rejected");
	expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
		ChangeSetWorkspaceRevisionStaleError,
	);
	expect(
		(await loadChangeSetSteps(fixture.workspace.id)).map(
			(step) => step.ordinal,
		),
	).toEqual([0]);
});

it("tracks plan edits without rebuilding work and pauses construction during review", async () => {
	const fixture = await open();
	await stageChangeSetRequest(stage(fixture));
	await writeAppPlan({
		authority: fixture.authority,
		writer: { editor: "architect" },
		requestId: "clarify",
		expectedRevision: 1,
		change: {
			oldText: "selected loan",
			newText: "selected loan and its condition",
		},
	});
	expect((await loadChangeSet(fixture.workspace.id))?.planRevision).toBe(2);
	const review = await beginPlanReview(fixture.authority, "second-review");
	const call = stage(fixture, { requestId: "later", expectedRevision: 1 });
	await expect(stageChangeSetRequest(call)).rejects.toThrow("peer review");
	await finishPlanReview(fixture.authority, review.reviewId);
	expect((await stageChangeSetRequest(call)).receipt.workspaceRevision).toBe(2);
});

it("refuses replaced holders and revoked membership, including receipt replays and abandonment", async () => {
	const fixture = await open();
	const call = stage(fixture);
	await stageChangeSetRequest(call);
	await expect(
		stageChangeSetRequest({
			...call,
			chatRunHolder: { ...fixture.holder, nonce: crypto.randomUUID() },
		}),
	).rejects.toThrow();
	const db = await getAuthDb();
	await db
		.deleteFrom("auth_member")
		.where("userId", "=", ACTOR)
		.where("organizationId", "=", PROJECT)
		.execute();
	await expect(stageChangeSetRequest(call)).rejects.toThrow();
	await expect(
		abandonChangeSet({
			changeSetId: fixture.workspace.id,
			actorUserId: ACTOR,
			runId: RUN,
			chatRunHolder: fixture.holder,
		}),
	).rejects.toThrow();
	expect((await loadChangeSet(fixture.workspace.id))?.status).toBe("open");
});
