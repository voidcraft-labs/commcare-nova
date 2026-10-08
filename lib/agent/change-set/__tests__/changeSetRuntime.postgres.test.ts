/** Private edits and canonical checkpoints over real Postgres.
 * Shared tools provide the authored writes; concurrent canonical changes exercise
 * the commit kernel's stale-base and failure paths. No model responses are involved. */
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
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import { collectTranslationUnits } from "@/lib/domain";
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
	input: { name: "Households" },
};
async function stageHousehold(
	workspace: ChangeSetMutationWorkspace,
	call: {
		toolName: string;
		requestId: string;
		input: { name: string; moduleUuid?: string };
	} = create,
) {
	const first = await workspace.stageDispatch(call);
	const module = Object.values(workspace.currentSnapshot().doc.modules).find(
		(m) => m.name === call.input.name,
	);
	if (!module) throw new Error("Missing staged module");
	const form = await workspace.stageDispatch({
		toolName: "createForm",
		requestId: `${call.requestId}-form`,
		input: {
			moduleUuid: module.uuid,
			name: "Household survey",
			type: "survey",
		},
	});
	expect(form.receipt?.disposition).toBe("staged");
	const formUuid = workspace.currentSnapshot().doc.formOrder[module.uuid]?.[0];
	if (!formUuid) throw new Error("Missing staged form");
	const fields = await workspace.stageDispatch({
		toolName: "addFields",
		requestId: `${call.requestId}-fields`,
		input: {
			moduleUuid: module.uuid,
			formUuid,
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
	});
	expect(fields.receipt?.disposition).toBe("staged");
	return first;
}
function statusField(workspace: ChangeSetMutationWorkspace) {
	const field = Object.values(workspace.currentSnapshot().doc.fields).find(
		(field) => field.id === "status",
	);
	if (field?.kind !== "single_select" || field.optionsSource.kind !== "inline")
		throw new Error("Missing status choices");
	return field;
}

it("returns concrete navigation from private create, update and read while qualifying an unfinished neighboring registration", async () => {
	const f = await fixture();
	await f.workspace.stageDispatch({
		toolName: "createModule",
		requestId: "loans",
		input: { name: "Loans", case_type: "loan" },
	});
	const module = Object.values(f.workspace.currentSnapshot().doc.modules).find(
		(item) => item.name === "Loans",
	);
	if (!module) throw new Error("Missing loan menu");
	const created = await f.workspace.stageDispatch({
		toolName: "createForm",
		requestId: "review",
		input: { moduleUuid: module.uuid, name: "Review", type: "followup" },
	});
	expect(created.receipt?.disposition).toBe("staged");
	expect(created.result).toMatchObject({
		kind: "mutate",
		result: {
			navigation: {
				afterSubmit: { fallback: { screen: "menu", moduleUuid: module.uuid } },
			},
		},
	});
	const review = Object.values(f.workspace.currentSnapshot().doc.forms).find(
		(item) => item.name === "Review",
	);
	if (!review) throw new Error("Missing review form");
	await f.workspace.stageDispatch({
		toolName: "addFields",
		requestId: "review-fields",
		input: {
			moduleUuid: module.uuid,
			formUuid: review.uuid,
			fields: [{ kind: "text", id: "notes", label: "Notes" }],
		},
	});
	const note = Object.values(f.workspace.currentSnapshot().doc.fields).find(
		(item) => item.id === "notes",
	);
	if (!note) throw new Error("Missing note field");
	await f.workspace.stageDispatch({
		toolName: "editField",
		requestId: "unrelated-writer",
		input: {
			fieldUuid: note.uuid,
			updates: { caseWrite: { caseType: "member", property: "case_name" } },
		},
	});
	const finding = {
		code: "CASE_WRITE_NOT_DIRECT_CHILD",
		moduleUuid: module.uuid,
		formUuid: review.uuid,
		fieldUuid: note.uuid,
	};
	const unavailable = {
		afterSubmit: { fallback: { screen: "unavailable", findings: [finding] } },
	};
	const invalidRead = await f.workspace.stageDispatch({
		toolName: "getForm",
		requestId: "read-invalid-writer",
		input: { moduleUuid: module.uuid, formUuid: review.uuid },
	});
	expect(invalidRead.result).toMatchObject({
		kind: "read",
		data: {
			form: { name: "Review" },
			navigation: unavailable,
		},
	});
	const invalidUpdate = await f.workspace.stageDispatch({
		toolName: "updateForm",
		requestId: "describe-invalid-writer",
		input: {
			moduleUuid: module.uuid,
			formUuid: review.uuid,
			purpose: "Review a loan",
		},
	});
	expect(invalidUpdate.receipt?.disposition).toBe("staged");
	expect(invalidUpdate.result).toMatchObject({
		kind: "mutate",
		result: { ok: true, navigation: unavailable },
	});
	const sibling = await f.workspace.stageDispatch({
		toolName: "createForm",
		requestId: "sibling",
		input: { moduleUuid: module.uuid, name: "Second review", type: "followup" },
	});
	expect(sibling.receipt?.disposition).toBe("staged");
	expect(sibling.result).toMatchObject({
		kind: "mutate",
		result: { ok: true, navigation: unavailable },
	});
	await f.workspace.stageDispatch({
		toolName: "addFields",
		requestId: "sibling-fields",
		input: {
			moduleUuid: module.uuid,
			formUuid: "Second review",
			fields: [{ kind: "text", id: "comment", label: "Comment" }],
		},
	});
	expect((await f.commit()).kind).toBe("gate-rejected");
	await f.workspace.stageDispatch({
		toolName: "editField",
		requestId: "repair-writer",
		input: { fieldUuid: note.uuid, updates: { caseWrite: null } },
	});
	const repaired = await f.workspace.stageDispatch({
		toolName: "getForm",
		requestId: "read-repaired-writer",
		input: { moduleUuid: module.uuid, formUuid: review.uuid },
	});
	expect(repaired.result).toMatchObject({
		kind: "read",
		data: { navigation: { afterSubmit: { fallback: { screen: "menu" } } } },
	});
	await f.workspace.stageDispatch({
		toolName: "createForm",
		requestId: "register",
		input: { moduleUuid: module.uuid, name: "Register", type: "registration" },
	});
	const register = Object.values(f.workspace.currentSnapshot().doc.forms).find(
		(item) => item.name === "Register",
	);
	if (!register) throw new Error("Missing registration form");
	const unfinished = await f.workspace.stageDispatch({
		toolName: "getForm",
		requestId: "read-unfinished",
		input: { moduleUuid: module.uuid, formUuid: review.uuid },
	});
	expect(unfinished.result).toMatchObject({
		kind: "read",
		data: {
			navigation: {
				afterSubmit: {
					fallback: {
						screen: "unavailable",
						findings: [
							{ code: "CASE_CREATE_NAME_MISSING", formUuid: register.uuid },
						],
					},
				},
			},
		},
	});
	await f.workspace.stageDispatch({
		toolName: "addFields",
		requestId: "register-fields",
		input: {
			moduleUuid: module.uuid,
			formUuid: register.uuid,
			fields: [{ kind: "text", id: "name", label: "Name" }],
		},
	});
	await f.workspace.stageDispatch({
		toolName: "updateForm",
		requestId: "register-name",
		input: {
			moduleUuid: module.uuid,
			formUuid: register.uuid,
			recordName: "#form/name",
		},
	});
	const destination = {
		screen: "record-selection",
		moduleUuid: module.uuid,
		formUuid: review.uuid,
		selectingModuleUuids: [module.uuid],
	};
	const updated = await f.workspace.stageDispatch({
		toolName: "updateForm",
		requestId: "review-return",
		input: {
			moduleUuid: module.uuid,
			formUuid: review.uuid,
			post_submit: "previous",
		},
	});
	expect(updated.result).toMatchObject({
		kind: "mutate",
		result: { navigation: { afterSubmit: { fallback: destination } } },
	});
	const read = await f.workspace.stageDispatch({
		toolName: "getForm",
		requestId: "read-complete",
		input: { moduleUuid: module.uuid, formUuid: review.uuid },
	});
	expect(read.result).toMatchObject({
		kind: "read",
		data: { navigation: { afterSubmit: { fallback: destination } } },
	});
	expect((await f.commit()).kind).toBe("committed");
});

it("keeps private edits invisible, retains choice identities, and replays the exact semantic result after reopening", async () => {
	const f = await fixture();
	const before = await visible(f.app.appId);
	const first = await stageHousehold(f.workspace);
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
	const replay = await stageHousehold(reopened);
	expect(replay.replayed).toBe(true);
	expect(replay.result).toEqual(first.result);
	expect(replay.receipt).toEqual(first.receipt);
	expect(reopened.currentSnapshot()).toEqual(f.workspace.currentSnapshot());
	expect(await loadChangeSetSteps(f.changeSet.id)).toHaveLength(4);
});

it("resynchronizes a stale continuation before replay, and refuses reuse of a call id with different input", async () => {
	const f = await fixture();
	const winner = await ChangeSetMutationWorkspace.open(f.host, f.changeSet.id);
	const first = await stageHousehold(winner);
	const replay = await stageHousehold(f.workspace);
	expect(replay.result).toEqual(first.result);
	expect(f.workspace.currentSnapshot()).toEqual(winner.currentSnapshot());
	const hostile = JSON.parse('{"__proto__":{"changed":true}}');
	await expect(
		f.workspace.stageDispatch({
			...create,
			input: { ...create.input, ...hostile },
		}),
	).rejects.toBeInstanceOf(ChangeSetRequestIdCollisionError);
	expect(await loadChangeSetSteps(f.changeSet.id)).toHaveLength(3);
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
	await stageHousehold(f.workspace);
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
	await expect(
		f.commit(f.workspace.current().revision - 1),
	).rejects.toMatchObject({ code: "WORKSPACE_REVISION_STALE" });
	expect(await visible(f.app.appId)).toEqual(after);
});

it.each(["replacement-holder", "revoked-membership"] as const)(
	"rechecks authority on a committed replay after %s",
	async (reason) => {
		const f = await fixture();
		await stageHousehold(f.workspace);
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

it("refuses an unrelated newer canonical revision and preserves the candidate", async () => {
	const f = await fixture();
	await stageHousehold(f.workspace);
	await f.concurrent([{ kind: "setAppName", name: "Concurrent title" }]);
	const outcome = await f.commit();
	expect(outcome.kind).toBe("stale-base");
	const app = await loadApp(f.app.appId);
	expect(app?.blueprint.appName).toBe("Concurrent title");
	expect(
		Object.values(app?.blueprint.modules ?? {}).some(
			(module) => module.name === "Households",
		),
	).toBe(false);
	expect((await loadChangeSet(f.changeSet.id))?.status).toBe("open");
	expect(await loadChangeSetSteps(f.changeSet.id)).toHaveLength(3);
});

it("reports a removed target and preserves private work for repair", async () => {
	const f = await fixture();
	await stageHousehold(f.workspace);
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
		kind: "stale-base",
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
	await stageHousehold(f.workspace);
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
	await stageHousehold(workspace, {
		...create,
		requestId: "replace-households",
		input: { ...create.input, moduleUuid: replacementUuid },
	});
	expect((await f.commit(workspace.current().revision)).kind).toBe("committed");
	const saved = await loadApp(f.app.appId);
	expect(saved?.blueprint.modules[replacementUuid]?.name).toBe("Households");
	expect(saved?.blueprint.modules[moduleUuid]).toBeUndefined();
});

it("keeps translated content identical across private edits, reopening and checkpoint commit", async () => {
	const f = await fixture();
	await stageHousehold(f.workspace);
	const field = statusField(f.workspace);
	const editHint = (requestId: string, hint: string | null) => ({
		toolName: "editField",
		requestId,
		input: { fieldUuid: field.uuid, updates: { hint } },
	});
	await f.workspace.stageDispatch(
		editHint("initial-hint", "Choose the current status"),
	);
	await f.workspace.stageDispatch({
		toolName: "addLanguage",
		requestId: "spanish",
		input: { language: { language: "spa" } },
	});
	expect((await f.commit()).kind).toBe("committed");
	const pending = await f.open();
	const unit = collectTranslationUnits(
		pending.workspace.currentSnapshot().doc,
	).find((unit) => unit.role === "field-hint");
	if (!unit) throw new Error("Missing translated hint");
	const original =
		pending.workspace.currentSnapshot().doc.localization?.translations.spa?.[
			unit.id
		];
	expect(original).toBeDefined();
	await pending.workspace.stageDispatch(editHint("remove-hint", null));
	await pending.workspace.stageDispatch(
		editHint("restore-hint", "Choose the current status"),
	);
	const staged = toPersistableDoc(pending.workspace.currentSnapshot().doc);
	expect(staged.localization?.translations.spa?.[unit.id]).toEqual(original);
	const reopened = await ChangeSetMutationWorkspace.open(
		f.host,
		pending.changeSet.id,
	);
	expect(toPersistableDoc(reopened.currentSnapshot().doc)).toEqual(staged);
	const outcome = await commitDesignChangeSet({
		changeSetId: pending.changeSet.id,
		actorUserId: actor,
		runId,
		chatRunHolder: f.host.chatRunHolder,
		kind: "chat",
		expectedRevision: reopened.current().revision,
	});
	expect(outcome.kind).toBe("committed");
	expect((await loadApp(f.app.appId))?.blueprint).toEqual(staged);
});

it("lets only one candidate revision win across concurrent durable continuations", async () => {
	const f = await fixture();
	const other = await ChangeSetMutationWorkspace.open(f.host, f.changeSet.id);
	const before = await visible(f.app.appId);
	const outcomes = await Promise.allSettled([
		f.workspace.stageDispatch({
			toolName: "updateApp",
			requestId: "first",
			input: { name: "First candidate" },
		}),
		other.stageDispatch({
			toolName: "updateApp",
			requestId: "second",
			input: { name: "Second candidate" },
		}),
	]);
	expect(
		outcomes.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	const failure = outcomes.find((result) => result.status === "rejected");
	expect(failure?.status === "rejected" && failure.reason).toMatchObject({
		code: "WORKSPACE_REVISION_STALE",
	});
	expect(await loadChangeSetSteps(f.changeSet.id)).toHaveLength(1);
	expect((await loadChangeSet(f.changeSet.id))?.revision).toBe(1);
	expect(await visible(f.app.appId)).toEqual(before);
});

it("reauthorizes an accepted private receipt before replaying its result", async () => {
	const f = await fixture();
	await f.workspace.stageDispatch(create);
	const steps = await loadChangeSetSteps(f.changeSet.id);
	await h
		.pool()
		.query(
			'DELETE FROM auth_member WHERE "userId"=$1 AND "organizationId"=$2',
			[actor, project],
		);
	await expect(f.workspace.stageDispatch(create)).rejects.toThrow();
	expect(await loadChangeSetSteps(f.changeSet.id)).toEqual(steps);
});
