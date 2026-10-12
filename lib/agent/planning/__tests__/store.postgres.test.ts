import { expect, it } from "vitest";
import { openDesignModelContext } from "@/lib/agent/build/modelContextStore";
import { getAuthDb } from "@/lib/auth/db";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { PlanConflictError } from "../plan";
import {
	beginPlanReview,
	finishPlanReview,
	latestPlanReview,
	type PlanningAuthority,
	pausePlanReview,
	readAppPlan,
	writeAppPlan,
} from "../store";

const h = setupAppStateTestDb("markdown_plan_", { authSchema: "migrated" });

async function authority(): Promise<PlanningAuthority> {
	const actorUserId = "architect";
	const projectId = "planning-project";
	const runId = "planning-run";
	const holderNonce = "00000000-0000-4000-8000-000000000887";
	const sessionId = await h.seedDesignSession({
		owner_user_id: actorUserId,
		project_id: projectId,
		run_id: runId,
		run_holder_nonce: holderNonce,
		run_actor_user_id: actorUserId,
		run_lease_expires_at: new Date(Date.now() + 60_000),
		reservation: {
			period: "2026-09",
			reserved: 1,
			settled: false,
			userId: actorUserId,
			runId,
		},
	});
	return { sessionId, actorUserId, projectId, runId, holderNonce };
}

it("preserves one editable plan across peer review, exact retries and a replaced process", async () => {
	const auth = await authority();
	const initial = {
		authority: auth,
		writer: { editor: "architect" as const },
		requestId: "first-plan",
		expectedRevision: 0,
		change: {
			markdown: "# Lending\n\nRecord each loan. A return closes that loan.",
		},
	};
	const first = await writeAppPlan(initial);
	const review = await beginPlanReview(auth, "review-call", {
		sourceDigest: "source",
		appSeq: null,
		focus: "Recheck the corrected return task",
	});
	expect((await beginPlanReview(auth, "review-call")).review.focus).toBe(
		"Recheck the corrected return task",
	);
	expect(review.complete).toBe(false);
	await expect(
		writeAppPlan({
			...initial,
			requestId: "racing-lead",
			expectedRevision: 1,
			change: { markdown: "A different plan" },
		}),
	).rejects.toBeInstanceOf(PlanConflictError);
	const edit = {
		authority: auth,
		writer: { editor: "peer" as const, reviewId: review.reviewId },
		requestId: "peer-edit",
		expectedRevision: 1,
		change: {
			oldText: "Record each loan.",
			newText:
				"Record each loan separately, even when one borrower takes several tools.",
		},
	};
	const improved = await writeAppPlan(edit);
	expect(improved.markdown).toContain(
		"even when one borrower takes several tools",
	);
	expect(improved.revision).toBe(2);
	expect(await writeAppPlan(edit)).toEqual(improved);
	expect((await beginPlanReview(auth, "review-call")).reviewId).toBe(
		review.reviewId,
	);
	const reviewed = await finishPlanReview(auth, review.reviewId);
	expect(reviewed.reviewedRevision).toBe(2);
	expect((await beginPlanReview(auth, "review-call")).complete).toBe(true);
	const read = await readAppPlan(auth);
	expect(read).toEqual(reviewed);
	expect((await writeAppPlan(initial)).markdown).toBe(first.markdown);
	await expect(
		writeAppPlan({ ...edit, change: { markdown: "Different content" } }),
	).rejects.toBeInstanceOf(PlanConflictError);
	const revised = await writeAppPlan({
		...initial,
		requestId: "lead-revision",
		expectedRevision: 2,
		change: {
			oldText: "A return closes that loan.",
			newText: "A return records condition and closes only the selected loan.",
		},
	});
	expect(revised.revision).toBe(3);
	expect(revised.reviewedRevision).toBe(2);
	// Replaying the old completion cannot certify the new content.
	expect((await finishPlanReview(auth, review.reviewId)).reviewedRevision).toBe(
		2,
	);
	await expect(
		writeAppPlan({ ...edit, requestId: "late-peer", expectedRevision: 3 }),
	).rejects.toBeInstanceOf(PlanConflictError);
	expect(
		await h.db().selectFrom("authoring_plan_revisions").selectAll().execute(),
	).toHaveLength(3);
});

it("admits one competing revision and refuses stale, ambiguous and revoked edits", async () => {
	const auth = await authority();
	const edit = {
		authority: auth,
		writer: { editor: "architect" as const },
		expectedRevision: 0,
		change: { markdown: "Loan. Loan." },
	};
	const outcomes = await Promise.allSettled([
		writeAppPlan({ ...edit, requestId: "one" }),
		writeAppPlan({ ...edit, requestId: "two" }),
	]);
	expect(
		outcomes.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	await expect(
		writeAppPlan({
			...edit,
			requestId: "ambiguous",
			expectedRevision: 1,
			change: { oldText: "Loan.", newText: "Return." },
		}),
	).rejects.toBeInstanceOf(PlanConflictError);
	expect((await readAppPlan(auth))?.markdown).toBe("Loan. Loan.");
	const db = await getAuthDb();
	await db
		.deleteFrom("auth_member")
		.where("userId", "=", auth.actorUserId)
		.where("organizationId", "=", auth.projectId)
		.execute();
	await expect(
		writeAppPlan({ ...edit, requestId: "revoked", expectedRevision: 1 }),
	).rejects.toThrow();
	await expect(readAppPlan(auth)).rejects.toThrow();
	expect(
		await h.db().selectFrom("authoring_plan_revisions").selectAll().execute(),
	).toHaveLength(1);
});

it("preserves an unfinished review and admits exactly one successor on a new user turn, with an immutable original-call receipt", async () => {
	const auth = await authority();
	await writeAppPlan({
		authority: auth,
		writer: { editor: "architect" },
		requestId: "plan",
		change: { markdown: "Keep each lending visit." },
	});
	const open = (reviewId: string) =>
		openDesignModelContext({
			designSessionId: auth.sessionId,
			kind: "peer",
			contextVersion: reviewId,
			modelId: "offline-peer",
			promptVersion: "v1",
			toolsetDigest: "0".repeat(64),
			authority: {
				actorUserId: auth.actorUserId,
				expectedProjectId: auth.projectId,
				runId: auth.runId,
				holderNonce: auth.holderNonce,
			},
		});
	const original = await beginPlanReview(auth, "original-call", {
		sourceDigest: "source-a",
		appSeq: null,
		issuingTurnId: "user-a",
	});
	const context = await open(original.reviewId);
	await pausePlanReview(auth, original.reviewId, {
		contextId: context.id,
		summary: "Return journey remains untested.",
		summaryAvailable: true,
	});
	expect(await latestPlanReview(auth, "source-a", null)).toBeUndefined();
	await expect(finishPlanReview(auth, original.reviewId)).rejects.toThrow(
		"unfinished checkpoint",
	);
	expect(
		(
			await beginPlanReview(auth, "original-call", {
				sourceDigest: "source-a",
				appSeq: null,
				issuingTurnId: "user-a",
			})
		).reviewId,
	).toBe(original.reviewId);
	const successor = await beginPlanReview(auth, "original-call", {
		sourceDigest: "source-b",
		appSeq: null,
		issuingTurnId: "user-b",
	});
	expect(successor.review).toMatchObject({
		predecessor_review_id: original.reviewId,
		source_digest: "source-b",
		issuing_turn_id: "user-b",
		completed_revision: null,
	});
	expect(
		(
			await beginPlanReview(auth, "original-call", {
				sourceDigest: "source-b",
				appSeq: null,
				issuingTurnId: "user-b",
			})
		).reviewId,
	).toBe(successor.reviewId);
	await expect(
		writeAppPlan({
			authority: auth,
			writer: { editor: "peer", reviewId: original.reviewId },
			requestId: "old-peer",
			change: { markdown: "Old evidence" },
		}),
	).rejects.toBeInstanceOf(PlanConflictError);
	const nextContext = await open(successor.reviewId);
	await writeAppPlan({
		authority: auth,
		writer: { editor: "peer", reviewId: successor.reviewId },
		requestId: "improve",
		change: { markdown: "Keep each lending visit and its separate return." },
	});
	await finishPlanReview(auth, successor.reviewId, {
		contextId: nextContext.id,
		summary: "Exercised the return journey.",
		sourceDigest: "source-b-plus-discovered-document",
	});
	expect(await latestPlanReview(auth, "source-b", null)).toBeUndefined();
	expect(
		await latestPlanReview(auth, "source-b-plus-discovered-document", null),
	).toMatchObject({ id: successor.reviewId });
	const receipt = await beginPlanReview(auth, "original-call");
	expect(receipt).toMatchObject({
		complete: true,
		reviewId: successor.reviewId,
		plan: { revision: 2 },
		review: { summary: "Exercised the return journey." },
	});
	await writeAppPlan({
		authority: auth,
		writer: { editor: "architect" },
		requestId: "later",
		change: { markdown: "Add a lost-tool workflow." },
	});
	expect(await beginPlanReview(auth, "original-call")).toEqual(receipt);
	expect(
		await latestPlanReview(auth, "source-b-plus-discovered-document", null),
	).toBeUndefined();
	expect(
		await h.db().selectFrom("authoring_reviews").selectAll().execute(),
	).toHaveLength(2);
});
