import { expect, it } from "vitest";
import { getAuthDb } from "@/lib/auth/db";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { PlanConflictError } from "../plan";
import {
	beginPlanReview,
	finishPlanReview,
	type PlanningAuthority,
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
	const review = await beginPlanReview(auth, "review-call");
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
