/**
 * `updateApp`'s `runs_only_on` pre-checks through the production path a model
 * reaches: the private change set (`ChangeSetMutationWorkspace.stageDispatch`)
 * over real Postgres, where a batch with findings would otherwise stage and
 * its pure gate sees no media rows.
 *
 * Contract: a change that adds a platform the app's content or files can't
 * run on is refused at the call, in the gate's or the commit kernel's own
 * words, and the change set gains no step; a change nothing stands in the way
 * of stages.
 */

import { expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	beginPlanReview,
	finishPlanReview,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createAndClaimDesignSessionRun } from "@/lib/db/designSessions";
import type { MediaAssetId } from "@/lib/domain";
import { walkAuthoredAssetRefs } from "@/lib/domain/mediaRefs";
import { describeUnplayableReferences } from "@/lib/media/platformPlayback";
import { emptyGenesisBase } from "../../change-set/baseLoader";
import {
	beginGenesisChangeSet,
	loadChangeSetSteps,
} from "../../change-set/store";
import { ChangeSetMutationWorkspace } from "../../change-set/workspace";

const h = setupAppStateTestDb("update_app_platforms_", {
	authSchema: "migrated",
	poolMax: 3,
});
const ACTOR = "architect";
const PROJECT = "platforms-project";
const RUN = "build-run";
const AMR = testMediaAssetId("update-app-amr");
const MP3 = testMediaAssetId("update-app-mp3");

/** A private genesis change set with a reviewed plan, and its workspace. */
async function openWorkspace() {
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
			markdown:
				"Where workers use it: Android only, as the user said. Record each visit.",
		},
	});
	const review = await beginPlanReview(authority, "review");
	await finishPlanReview(authority, review.reviewId);
	const holder = {
		source: "chat" as const,
		mode: "build" as const,
		runId: RUN,
		nonce: claimed.holderNonce,
	};
	const changeSet = await beginGenesisChangeSet({
		lineage: { designSessionId: claimed.designSessionId, planRevision: 1 },
		ownerUserId: ACTOR,
		ownerRunId: RUN,
		holderNonce: claimed.holderNonce,
		proposedAppId: claimed.proposedAppId,
		projectId: PROJECT,
		baseSnapshotDigest: emptyGenesisBase(claimed.proposedAppId).digest,
	});
	const workspace = await ChangeSetMutationWorkspace.open(
		{
			actorUserId: ACTOR,
			runId: RUN,
			chatRunHolder: holder,
			conversionImpact: async () => {
				throw new Error("This test does not convert fields");
			},
		},
		changeSet.id,
	);
	return { workspace, changeSetId: changeSet.id };
}

/** An Android-only visit form holding a note, staged through the tools. */
async function stageAndroidVisit(workspace: ChangeSetMutationWorkspace) {
	const steps = [
		{
			toolName: "updateApp",
			requestId: "android",
			input: { name: "Visits", runs_only_on: "android" },
		},
		{
			toolName: "createModule",
			requestId: "module",
			input: { name: "Visits" },
		},
		{
			toolName: "createForm",
			requestId: "form",
			input: { moduleUuid: "Visits", name: "Visit", type: "survey" },
		},
		{
			toolName: "addFields",
			requestId: "note",
			input: {
				formUuid: "Visit",
				fields: [{ kind: "text", id: "note", label: "Note" }],
			},
		},
	];
	for (const step of steps) {
		const staged = await workspace.stageDispatch(step);
		expect(staged.receipt?.disposition, step.requestId).toBe("staged");
	}
	expect(workspace.currentSnapshot().doc.appSettings.runsOnlyOn).toBe(
		"android",
	);
}

async function seedAudio(
	id: MediaAssetId,
	format: { mime: string; extension: string; mediaFormat: string },
): Promise<void> {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: PROJECT,
			owner: ACTOR,
			content_hash: id.padEnd(64, "a").slice(0, 64),
			mime_type: format.mime,
			extension: format.extension,
			size_bytes: 1024,
			kind: "audio",
			gcs_object_key: `projects/${PROJECT}/${id}`,
			original_filename: `${id}${format.extension}`,
			status: "ready",
			media_format: format.mediaFormat,
		})
		.execute();
}

/** Puts the file on the note's label, through the media tool. */
async function attachToNote(
	workspace: ChangeSetMutationWorkspace,
	assetId: MediaAssetId,
) {
	const note = Object.values(workspace.currentSnapshot().doc.fields).find(
		(field) => field.id === "note",
	);
	if (!note) throw new Error("The note question is missing.");
	const staged = await workspace.stageDispatch({
		toolName: "attachFieldMedia",
		requestId: `attach-${assetId}`,
		input: {
			attachments: [
				{
					moduleUuid: "Visits",
					formUuid: "Visit",
					fieldUuid: note.uuid,
					slot: "label",
					media: { audio: assetId },
				},
			],
		},
	});
	expect(staged.receipt?.disposition).toBe("staged");
}

async function widen(workspace: ChangeSetMutationWorkspace) {
	return workspace.stageDispatch({
		toolName: "updateApp",
		requestId: "both",
		input: { runs_only_on: null },
	});
}

it("refuses to add Web Apps while a date-and-time question stands in the way, and stages nothing", async () => {
	const { workspace, changeSetId } = await openWorkspace();
	await stageAndroidVisit(workspace);
	expect(
		(
			await workspace.stageDispatch({
				toolName: "addFields",
				requestId: "visit-time",
				input: {
					formUuid: "Visit",
					fields: [{ kind: "datetime", id: "visit_time", label: "Visit time" }],
				},
			})
		).receipt?.disposition,
	).toBe("staged");
	const before = await loadChangeSetSteps(changeSetId);

	const refused = await widen(workspace);

	expect(refused.result).toMatchObject({
		kind: "mutate",
		mutations: [],
		result: {
			error: expect.stringContaining(
				'Question "visit_time" in form "Visit" is a date-and-time question',
			),
		},
	});
	expect(await loadChangeSetSteps(changeSetId)).toHaveLength(before.length);
	expect(workspace.currentSnapshot().doc.appSettings.runsOnlyOn).toBe(
		"android",
	);
});

it("refuses to add Web Apps while a file only Android plays stands in the way, in the kernel's words", async () => {
	await seedAudio(AMR, {
		mime: "audio/amr",
		extension: ".amr",
		mediaFormat: "amr",
	});
	const { workspace, changeSetId } = await openWorkspace();
	await stageAndroidVisit(workspace);
	await attachToNote(workspace, AMR);
	const [ref] = [...walkAuthoredAssetRefs(workspace.currentSnapshot().doc)];
	if (ref === undefined) throw new Error("The app references no file.");
	const before = await loadChangeSetSteps(changeSetId);

	const refused = await widen(workspace);

	expect(refused.result).toEqual({
		kind: "mutate",
		mutations: [],
		result: {
			error: describeUnplayableReferences([
				{ ref, mediaFormat: "amr", label: "AMR", missing: ["web-apps"] },
			]),
		},
	});
	expect(await loadChangeSetSteps(changeSetId)).toHaveLength(before.length);
	expect(workspace.currentSnapshot().doc.appSettings.runsOnlyOn).toBe(
		"android",
	);
});

it("adds Web Apps when every file plays there too", async () => {
	await seedAudio(MP3, {
		mime: "audio/mpeg",
		extension: ".mp3",
		mediaFormat: "mp3",
	});
	const { workspace, changeSetId } = await openWorkspace();
	await stageAndroidVisit(workspace);
	await attachToNote(workspace, MP3);
	const before = await loadChangeSetSteps(changeSetId);

	const staged = await widen(workspace);

	expect(staged.receipt?.disposition).toBe("staged");
	expect(await loadChangeSetSteps(changeSetId)).toHaveLength(before.length + 1);
	expect(
		workspace.currentSnapshot().doc.appSettings.runsOnlyOn,
	).toBeUndefined();
});
