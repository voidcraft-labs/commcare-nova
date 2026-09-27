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
	for (const [toolName, input] of [
		["createModule", { name: "Visits" }],
		["createForm", { moduleUuid: "Visits", name: "Visit", type: "survey" }],
		[
			"addFields",
			{
				formUuid: "Visit",
				fields: [{ kind: "text", id: "notes", label: "Visit notes" }],
			},
		],
	] as const) {
		const result = await session.shared(
			{ toolName, toolCallId: `fixture-${toolName}`, input },
			"architect",
		);
		if (typeof result === "object" && result !== null && "error" in result)
			throw new Error(String(result.error));
	}
	const { revision } = await session.getWork();
	if (!revision) throw new Error("Fixture did not produce a candidate");
	await session.saveWork("fixture-save", revision);
	if (!receipt) throw new Error("Fixture did not materialize an app");
	return receipt;
}
