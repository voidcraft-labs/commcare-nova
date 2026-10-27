import { AuthoringSession } from "@/lib/agent/build/authoringSession";
import {
	beginPlanReview,
	finishPlanReview,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import { guardedMutate } from "@/lib/agent/tools/common";
import type { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createAndClaimDesignSessionRun } from "@/lib/db/designSessions";
import type { Platform } from "@/lib/domain";

/** Real durable private construction. The caller owns the migrated database
 * fixture and its teardown; no test-only staging or validation implementation.
 * A test that goes on to build something one platform can't run names the
 * platform its app runs on (`runsOnlyOn`), declared as the workspace's first
 * staged write through the gated write path every tool uses, since no shared
 * tool takes the declaration yet. */
export async function makeDurableAuthoringHarness(
	db: ReturnType<typeof setupAppStateTestDb>,
	options: { readonly runsOnlyOn?: Platform } = {},
) {
	const actorUserId = `author-${crypto.randomUUID()}`;
	const projectId = `project-${crypto.randomUUID()}`;
	const runId = crypto.randomUUID();
	await db.seedProjectMember(actorUserId, projectId, "owner");
	const claim = await createAndClaimDesignSessionRun({
		projectId,
		actorUserId,
		runId,
		cost: 1,
	});
	const authority = {
		actorUserId,
		projectId,
		runId,
		holderNonce: claim.holderNonce,
		sessionId: claim.designSessionId,
	};
	await writeAppPlan({
		authority,
		writer: { editor: "architect" },
		requestId: "fixture-plan",
		expectedRevision: 0,
		change: {
			markdown: "Build and verify the workflow described by this test.",
		},
	});
	const review = await beginPlanReview(authority, "fixture-peer");
	await finishPlanReview(authority, review.reviewId);
	const session = new AuthoringSession(
		authority,
		claim.proposedAppId,
		() => {},
	);
	await session.ensureWorkspace();
	const { runsOnlyOn } = options;
	if (runsOnlyOn !== undefined) {
		await session.write(
			{
				toolName: "declarePlatform",
				input: { runsOnlyOn },
				toolCallId: "fixture-platform",
			},
			async (ctx) => {
				const outcome = await guardedMutate(ctx, [
					{ kind: "setAppSettings", settings: { runsOnlyOn } },
				]);
				if (!outcome.ok)
					throw new Error(
						`The platform declaration was refused: ${outcome.error}`,
					);
				return {
					kind: "mutate" as const,
					mutations: outcome.mutations,
					result: { message: `The app runs only on ${runsOnlyOn}.` },
				};
			},
		);
	}
	let ordinal = 0;
	return {
		session,
		authority,
		call: (toolName: string, input: unknown, requestId?: string) =>
			session.shared(
				{ toolName, input, toolCallId: requestId ?? `fixture-${++ordinal}` },
				"architect",
			),
		currentDoc: async () => (await session.snapshot()).doc,
		save: async (requestId = `fixture-save-${++ordinal}`) => {
			const work = await session.getWork();
			if (!work.revision) throw new Error("No private candidate to save.");
			return session.saveWork(requestId, work.revision);
		},
	};
}
