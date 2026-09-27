import { AuthoringSession } from "@/lib/agent/build/authoringSession";
import {
	beginPlanReview,
	finishPlanReview,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import type { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createAndClaimDesignSessionRun } from "@/lib/db/designSessions";

/** Real durable private construction. The caller owns the migrated database
 * fixture and its teardown; no test-only staging or validation implementation. */
export async function makeDurableAuthoringHarness(
	db: ReturnType<typeof setupAppStateTestDb>,
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
