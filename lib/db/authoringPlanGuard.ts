import type { Transaction } from "kysely";
import { PlanConflictError } from "@/lib/agent/planning/plan";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import type { AppDatabase } from "./pg";

/** Called after the session/app authority lock, before construction writes. */
export async function lockPlanForBuild(
	tx: Transaction<AppDatabase>,
	sessionId: string,
	expectedRevision?: number,
): Promise<number> {
	const head = await tx
		.selectFrom("authoring_plans")
		.selectAll()
		.where("session_id", "=", sessionId)
		.forUpdate()
		.executeTakeFirst();
	if (
		!head ||
		head.reviewed_revision === null ||
		(head.review_id !== null && !head.review_complete)
	)
		throw new PlanConflictError(
			"The plan needs peer review before building can continue.",
		);
	const revision = safePersistedSequence(head.revision, "plan revision");
	if (expectedRevision !== undefined && revision !== expectedRevision)
		throw new PlanConflictError(
			"The plan changed before this work could commit. Reload the workspace.",
		);
	return revision;
}
