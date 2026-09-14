import { AuthoringSession } from "@/lib/agent/build/authoringSession";
import {
	beginPlanReview,
	finishPlanReview,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import type { AppMaterializationReceipt } from "@/lib/db/appGenesis";

/** Controlled content with production planning, workspace and genesis transactions.
 * The route tests choose model outcomes; this fixture preserves canonical SQL. */
export async function materializeDesignFixture(args: {
	designSessionId: string;
	appId: string;
	runId: string;
	holderNonce: string;
	actorUserId: string;
	projectId: string;
}) {
	const authority = {
		sessionId: args.designSessionId,
		projectId: args.projectId,
		actorUserId: args.actorUserId,
		runId: args.runId,
		holderNonce: args.holderNonce,
	};
	await writeAppPlan({
		authority,
		writer: { editor: "architect" },
		requestId: "fixture-plan",
		expectedRevision: 0,
		change: { markdown: "Record visits in a short survey." },
	});
	const review = await beginPlanReview(authority, "fixture-review");
	await finishPlanReview(authority, review.reviewId);
	let receipt: AppMaterializationReceipt | undefined;
	const session = new AuthoringSession(authority, args.appId, (value) => {
		receipt = value;
	});
	await session.ensureWorkspace();
	const result = await session.shared(
		{
			toolName: "createModule",
			toolCallId: "fixture-module",
			input: {
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ kind: "text", id: "notes", label: "Visit notes" }],
					},
				],
			},
		},
		"architect",
	);
	if (typeof result === "object" && result !== null && "error" in result)
		throw new Error(String(result.error));
	await session.saveWork("fixture-save");
	if (!receipt) throw new Error("Fixture did not materialize an app");
	return receipt;
}
