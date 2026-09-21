/** Private edits and canonical checkpoints over real Postgres.
 * Shared tools provide the authored writes; concurrent canonical changes exercise
 * the commit kernel's rebase and failure paths. No model responses are involved. */
import { expect, it } from "vitest";
import {
	beginPlanReview,
	finishPlanReview,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { claimAndReserveRun, commitGuardedBatch, loadApp } from "@/lib/db/apps";
import { createEditDesignSession } from "@/lib/db/designSessions";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import { commitDesignChangeSet } from "../commit";
import {
	ChangeSetRequestIdCollisionError,
	ChangeSetStagingRejectedError,
} from "../errors";
import {
	abandonChangeSet,
	beginAppEditChangeSet,
	loadChangeSet,
	loadChangeSetSteps,
} from "../store";
import { ChangeSetMutationWorkspace } from "../workspace";

const h = setupAppStateTestDb("private_authoring_commit_", {
	authSchema: "migrated",
	poolMax: 3,
});
const actor = "architect";
const project = "workspace-project";
const runId = "build-run";

async function fixture() {
	await h.seedProjectMember(actor, project, "owner");
	const app = await createExplicitBlankApp(
		actor,
		project,
		crypto.randomUUID(),
		{ name: "Visits", status: "complete" },
	);
	// Resume construction of an existing app, through the same claim and session writers.
	await h
		.db()
		.updateTable("apps")
		.set({ status: "error" })
		.where("id", "=", app.appId)
		.execute();
	const claim = await claimAndReserveRun(
		app.appId,
		"build",
		runId,
		actor,
		1,
		project,
	);
	const { designSessionId } = await createEditDesignSession({
		appId: app.appId,
		projectId: project,
		actorUserId: actor,
	});
	const authority = {
		sessionId: designSessionId,
		projectId: project,
		actorUserId: actor,
		runId,
		holderNonce: claim.holderNonce,
	};
	await writeAppPlan({
		authority,
		writer: { editor: "architect" },
		requestId: "plan",
		expectedRevision: 0,
		change: {
			markdown:
				"Add a household survey while retaining the existing visit workflow.",
		},
	});
	const review = await beginPlanReview(authority, "review");
	await finishPlanReview(authority, review.reviewId);
	const host = {
		conversionImpact: async () => {
			throw new Error("This test does not convert fields");
		},
		actorUserId: actor,
		runId,
		chatRunHolder: {
			source: "chat" as const,
			mode: "build" as const,
			runId,
			nonce: claim.holderNonce,
		},
	};
	async function open() {
		const changeSet = await beginAppEditChangeSet({
			appId: app.appId,
			expectedProjectId: project,
			lineage: { designSessionId, planRevision: 1 },
			ownerUserId: actor,
			ownerRunId: runId,
			holderNonce: claim.holderNonce,
		});
		return {
			changeSet,
			workspace: await ChangeSetMutationWorkspace.open(host, changeSet.id),
		};
	}
	const opened = await open();
	const commit = (revision = opened.workspace.current().revision) =>
		commitDesignChangeSet({
			changeSetId: opened.changeSet.id,
			actorUserId: actor,
			runId,
			chatRunHolder: host.chatRunHolder,
			kind: "chat",
			expectedRevision: revision,
		});
	const concurrent = (mutations: Mutation[]) =>
		commitGuardedBatch({
			appId: app.appId,
			batchId: crypto.randomUUID(),
			actorUserId: actor,
			expectedProjectId: project,
			kind: "chat",
			runId,
			chatRunHolder: host.chatRunHolder,
			mutations: admitMutationBatch(mutations),
		});
	return { ...opened, app, host, open, commit, concurrent, authority };
}
async function visible(appId: string) {
	return {
		app: await loadApp(appId),
		changes: await h
			.db()
			.selectFrom("app_changes")
			.selectAll()
			.where("app_id", "=", appId)
			.orderBy("seq")
			.execute(),
		entities: await h
			.db()
			.selectFrom("blueprint_entities")
			.selectAll()
			.where("app_id", "=", appId)
			.orderBy("uuid")
			.execute(),
	};
}
const create = {
	toolName: "createModule",
	requestId: "households",
	input: {
		name: "Households",
		forms: [
			{
				name: "Household survey",
				type: "survey",
				fields: [
					{
						kind: "single_select",
						id: "status",
						label: "Status",
						optionsSource: {
							kind: "inline",
							options: [
								{ value: "active", label: "Active" },
								{ value: "closed", label: "Closed" },
							],
						},
					},
					{ kind: "text", id: "notes", label: "Notes" },
				],
			},
		],
	},
};
function statusField(workspace: ChangeSetMutationWorkspace) {
	const field = Object.values(workspace.currentSnapshot().doc.fields).find(
		(field) => field.id === "status",
	);
	if (field?.kind !== "single_select" || field.optionsSource.kind !== "inline")
		throw new Error("Missing status choices");
	return field;
}

it("keeps private edits invisible, retains choice identities, and replays the exact semantic result after reopening", async () => {
	const f = await fixture();
	const before = await visible(f.app.appId);
	const first = await f.workspace.stageDispatch(create);
	expect(first.receipt?.disposition, JSON.stringify(first.result)).toBe(
		"staged",
	);
	const original = statusField(f.workspace);
	const active =
		original.optionsSource.kind === "inline"
			? original.optionsSource.options[0]
			: undefined;
	if (!active) throw new Error("Missing active choice");
	const edited = await f.workspace.stageDispatch({
		toolName: "editField",
		requestId: "edit-status",
		input: {
			fieldUuid: original.uuid,
			updates: {
				label: "Current status",
				optionsSource: {
					kind: "inline",
					options: [
						{ optionUuid: active.uuid, value: "active", label: "Active" },
						{ value: "pending", label: "Pending" },
					],
				},
			},
		},
	});
	expect(edited.receipt?.disposition).toBe("staged");
	const changed = statusField(f.workspace);
	expect(
		changed.optionsSource.kind === "inline" &&
			changed.optionsSource.options[0]?.uuid,
	).toBe(active.uuid);
	expect(await visible(f.app.appId)).toEqual(before);
	const reopened = await ChangeSetMutationWorkspace.open(
		f.host,
		f.changeSet.id,
	);
	const replay = await reopened.stageDispatch(create);
	expect(replay.replayed).toBe(true);
	expect(replay.result).toEqual(first.result);
	expect(replay.receipt).toEqual(first.receipt);
	expect(reopened.currentSnapshot()).toEqual(f.workspace.currentSnapshot());
	expect(await loadChangeSetSteps(f.changeSet.id)).toHaveLength(2);
});

it("resynchronizes a stale continuation before replay, and refuses reuse of a call id with different input", async () => {
	const f = await fixture();
	const winner = await ChangeSetMutationWorkspace.open(f.host, f.changeSet.id);
	const first = await winner.stageDispatch(create);
	const replay = await f.workspace.stageDispatch(create);
	expect(replay.result).toEqual(first.result);
	expect(f.workspace.currentSnapshot()).toEqual(winner.currentSnapshot());
	const hostile = JSON.parse('{"__proto__":{"changed":true}}');
	await expect(
		f.workspace.stageDispatch({
			...create,
			input: { ...create.input, ...hostile },
		}),
	).rejects.toBeInstanceOf(ChangeSetRequestIdCollisionError);
	expect(await loadChangeSetSteps(f.changeSet.id)).toHaveLength(1);
});

it("rejects malformed inputs and external writes without changing private or canonical state", async () => {
	const f = await fixture();
	const before = await visible(f.app.appId);
	await expect(
		f.workspace.stageDispatch({
			toolName: "editField",
			requestId: "invalid",
			input: { fieldUuid: "missing" },
		}),
	).rejects.toBeInstanceOf(ChangeSetStagingRejectedError);
	await expect(
		f.workspace.stageDispatch({
			toolName: "removeMediaAsset",
			requestId: "external",
			input: { assetId: crypto.randomUUID() },
		}),
	).rejects.toBeInstanceOf(ChangeSetStagingRejectedError);
	expect(await loadChangeSetSteps(f.changeSet.id)).toEqual([]);
	expect(await visible(f.app.appId)).toEqual(before);
});

it("commits the complete workspace once and returns the same checkpoint on retry", async () => {
	const f = await fixture();
	const before = await visible(f.app.appId);
	await f.workspace.stageDispatch(create);
	await f.workspace.stageDispatch({
		toolName: "updateApp",
		requestId: "title",
		input: { name: "Household visits" },
	});
	const result = await f.commit();
	expect(result.kind).toBe("committed");
	if (result.kind !== "committed") throw new Error("Checkpoint did not commit");
	const after = await visible(f.app.appId);
	expect(after.changes).toHaveLength(before.changes.length + 1);
	expect(after.app?.blueprint.appName).toBe("Household visits");
	expect(
		Object.values(after.app?.blueprint.modules ?? {}).some(
			(module) => module.name === "Households",
		),
	).toBe(true);
	expect(await loadChangeSet(f.changeSet.id)).toMatchObject({
		status: "committed",
		committedSeq: result.receipt.seq,
	});
	expect(await f.commit()).toEqual({ ...result, replayed: true });
	expect(await visible(f.app.appId)).toEqual(after);
});

it.each(["replacement-holder", "revoked-membership"] as const)(
	"rechecks authority on a committed replay after %s",
	async (reason) => {
		const f = await fixture();
		await f.workspace.stageDispatch(create);
		expect((await f.commit()).kind).toBe("committed");
		const before = await visible(f.app.appId);
		if (reason === "replacement-holder")
			await h
				.db()
				.updateTable("apps")
				.set({ run_holder_nonce: crypto.randomUUID() })
				.where("id", "=", f.app.appId)
				.execute();
		else
			await h
				.pool()
				.query(
					'DELETE FROM auth_member WHERE "userId"=$1 AND "organizationId"=$2',
					[actor, project],
				);
		await expect(f.commit()).rejects.toThrow();
		expect((await visible(f.app.appId)).changes).toEqual(before.changes);
	},
);

it("rebases private edits over a newer canonical change without overwriting it", async () => {
	const f = await fixture();
	await f.workspace.stageDispatch(create);
	await f.concurrent([{ kind: "setAppName", name: "Concurrent title" }]);
	const outcome = await f.commit();
	expect(outcome.kind).toBe("committed");
	const app = await loadApp(f.app.appId);
	expect(app?.blueprint.appName).toBe("Concurrent title");
	expect(
		Object.values(app?.blueprint.modules ?? {}).some(
			(module) => module.name === "Households",
		),
	).toBe(true);
});

it("reports a removed target and preserves private work for repair", async () => {
	const f = await fixture();
	await f.workspace.stageDispatch(create);
	expect((await f.commit()).kind).toBe("committed");
	const next = await f.open();
	const field = statusField(next.workspace);
	await next.workspace.stageDispatch({
		toolName: "editField",
		requestId: "private-label",
		input: { fieldUuid: field.uuid, updates: { label: "Status today" } },
	});
	await f.concurrent([{ kind: "removeField", uuid: field.uuid }]);
	const before = await visible(f.app.appId);
	const result = await commitDesignChangeSet({
		changeSetId: next.changeSet.id,
		actorUserId: actor,
		runId,
		chatRunHolder: f.host.chatRunHolder,
		kind: "chat",
		expectedRevision: 1,
	});
	expect(result).toMatchObject({
		kind: "rebase-conflict",
		report: {
			conflicts: [expect.objectContaining({ code: "TARGET_REMOVED" })],
		},
	});
	expect(await visible(f.app.appId)).toEqual(before);
	expect((await loadChangeSet(next.changeSet.id))?.status).toBe("open");
	expect(await loadChangeSetSteps(next.changeSet.id)).toHaveLength(1);
});

it("retains an invalid private candidate until repaired and refuses publication in the meantime", async () => {
	const f = await fixture();
	const field = f.app.starter.fieldUuid;
	const remove = await f.workspace.stageDispatch({
		toolName: "removeField",
		requestId: "remove-only-question",
		input: {
			moduleUuid: f.app.starter.moduleUuid,
			formUuid: f.app.starter.formUuid,
			fieldUuid: field,
		},
	});
	expect(remove.receipt?.disposition).toBe("staged");
	const before = await visible(f.app.appId);
	expect((await f.commit()).kind).toBe("gate-rejected");
	expect(await visible(f.app.appId)).toEqual(before);
	expect((await loadChangeSet(f.changeSet.id))?.status).toBe("open");
	await f.workspace.stageDispatch({
		toolName: "removeModule",
		requestId: "remove-empty-workflow",
		input: { moduleUuid: f.app.starter.moduleUuid },
	});
	await f.workspace.stageDispatch(create);
	expect((await f.commit()).kind).toBe("committed");
});

it("keeps exclusive property migrations separate from ordinary private edits", async () => {
	const f = await fixture();
	await f.concurrent([
		{ kind: "declareCaseType", caseType: "client" },
		{
			kind: "addCaseProperty",
			caseType: "client",
			property: {
				name: "old_name",
				label: { parts: [{ kind: "text", text: "Old name" }] },
			},
		},
	]);
	// Open from the new canonical head.
	await abandonChangeSet({
		changeSetId: f.changeSet.id,
		actorUserId: actor,
		runId,
		chatRunHolder: f.host.chatRunHolder,
	});
	const ordinary = await f.open();
	await ordinary.workspace.stageDispatch({
		toolName: "updateApp",
		requestId: "title",
		input: { name: "Visits today" },
	});
	const rename = {
		toolName: "renameCaseProperties",
		requestId: "rename",
		input: {
			renames: [{ caseType: "client", from: "old_name", to: "new_name" }],
		},
	};
	expect(await ordinary.workspace.stageDispatch(rename)).toMatchObject({
		receipt: {
			disposition: "rejected",
			error: { code: "EXCLUSIVE_NOT_ALONE" },
		},
	});
	await abandonChangeSet({
		changeSetId: ordinary.changeSet.id,
		actorUserId: actor,
		runId,
		chatRunHolder: f.host.chatRunHolder,
	});
	const exclusive = await f.open();
	expect(await exclusive.workspace.stageDispatch(rename)).toMatchObject({
		receipt: { disposition: "staged" },
	});
	expect(
		await exclusive.workspace.stageDispatch({
			toolName: "updateApp",
			requestId: "title",
			input: { name: "Cannot mix" },
		}),
	).toMatchObject({
		receipt: {
			disposition: "rejected",
			error: { code: "EXCLUSIVE_SET_CLOSED" },
		},
	});
	expect(await loadChangeSetSteps(exclusive.changeSet.id)).toHaveLength(1);
});

it("rejects reuse of a removed private identity before staging and permits a fresh replacement", async () => {
	const f = await fixture();
	const moduleUuid = crypto.randomUUID();
	await f.workspace.stageDispatch({
		...create,
		input: { ...create.input, moduleUuid },
	});
	await f.workspace.stageDispatch({
		toolName: "removeModule",
		requestId: "remove-households",
		input: { moduleUuid },
	});
	const workspace = await ChangeSetMutationWorkspace.open(
		f.host,
		f.changeSet.id,
	);
	const revision = workspace.current().revision;
	const retry = {
		...create,
		requestId: "reuse-households",
		input: { ...create.input, moduleUuid },
	};
	const rejected = await workspace.stageDispatch(retry);
	expect(rejected.receipt?.disposition).toBe("rejected");
	expect(workspace.current().revision).toBe(revision);
	expect(workspace.currentSnapshot().doc.modules[moduleUuid]).toBeUndefined();
	const replay = await workspace.stageDispatch(retry);
	expect(replay.replayed).toBe(true);
	expect(replay.result).toEqual(rejected.result);
	const replacementUuid = crypto.randomUUID();
	await workspace.stageDispatch({
		...create,
		requestId: "replace-households",
		input: { ...create.input, moduleUuid: replacementUuid },
	});
	expect((await f.commit(workspace.current().revision)).kind).toBe("committed");
	const saved = await loadApp(f.app.appId);
	expect(saved?.blueprint.modules[replacementUuid]?.name).toBe("Households");
	expect(saved?.blueprint.modules[moduleUuid]).toBeUndefined();
});
