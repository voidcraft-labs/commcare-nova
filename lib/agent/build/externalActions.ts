import { z } from "zod";
import type { BuildPlan, BuildSlice } from "@/lib/agent/design/buildPlan";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { getAppDb } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Closed, non-prose evidence carried by a durable external-action receipt. */
export const externalActionEvidenceSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("nova-operation"),
			operationId: z.string().uuid(),
			resultDigest: sha256Schema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("user-confirmation"),
			confirmationId: z.string().uuid(),
			confirmedByUserId: z.string().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal("external-system"),
			referenceDigest: sha256Schema,
			resultDigest: sha256Schema,
		})
		.strict(),
]);
export type ExternalActionEvidence = z.infer<
	typeof externalActionEvidenceSchema
>;

export class ExternalActionRequiredError extends Error {
	readonly name = "ExternalActionRequiredError";
}

/** Require exact durable completion evidence before opening a dependent set. */
export async function assertRequiredExternalActionsSatisfied(args: {
	readonly designSessionId: string;
	readonly projectId: string;
	readonly appId: string | null;
	readonly plan: BuildPlan;
	readonly slice: BuildSlice;
}): Promise<void> {
	const actionById = new Map(
		args.plan.externalActions.map((action) => [action.id, action]),
	);
	const required = args.slice.externalActionIds
		.map((id) => actionById.get(id))
		.filter((action) => {
			if (action === undefined || action.requiredFor === "optional")
				return false;
			return (
				action.timing === "before-materialization" ||
				action.timing === "before-slice"
			);
		});
	if (required.length === 0) return;
	const db = await getAppDb();
	for (const action of required) {
		if (action === undefined) continue;
		let query = db
			.selectFrom("design_external_action_receipts")
			.select(["id", "action_digest", "outcome"])
			.select((eb) =>
				eb.cast<string>(eb.ref("evidence"), "text").as("evidence_text"),
			)
			.where("design_session_id", "=", args.designSessionId)
			.where("build_plan_id", "=", args.plan.id)
			.where("external_action_id", "=", action.id)
			.where("project_id", "=", args.projectId);
		/* A before-materialization receipt is permanently scoped to the pre-app
		 * session even if a later defensive check re-encounters it. A before-slice
		 * receipt follows the canonical target when one exists. */
		query =
			action.timing === "before-materialization" || args.appId === null
				? query.where("app_id", "is", null)
				: query.where("app_id", "=", args.appId);
		const receipt = await query.executeTakeFirst();
		if (
			receipt === undefined ||
			receipt.action_digest !== canonicalJsonDigest(action)
		) {
			throw new ExternalActionRequiredError(
				`Required external action ${action.id} has no current durable completion receipt.`,
			);
		}
		const evidence = externalActionEvidenceSchema.parse(
			parsePersistedJsonText(
				receipt.evidence_text,
				`design_external_action_receipts.evidence for ${receipt.id}`,
			),
		);
		const evidenceMatches =
			receipt.outcome === "manual-confirmed"
				? action.kind === "user-prerequisite" &&
					evidence.kind === "user-confirmation"
				: receipt.outcome === "completed" &&
					(evidence.kind === "nova-operation" ||
						evidence.kind === "external-system");
		if (!evidenceMatches) {
			throw new ExternalActionRequiredError(
				`Required external action ${action.id} has no current durable completion receipt.`,
			);
		}
	}
}
