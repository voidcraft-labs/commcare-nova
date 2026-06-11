/**
 * SA tool: `completeBuild` — finish the build: one deterministic
 * zero-tolerance evaluation, then the completion side effects.
 *
 * The successor to the deleted validate-fix loop, shaped by the
 * valid-by-construction program: every committed mutation already passed
 * the introduced-error gate, so by the time the agent calls this there
 * is nothing to "fix" — only completeness work the building window
 * deferred (an unfilled case list, a registration form still missing its
 * case-name writer). On findings, the tool returns each one
 * person-to-person and the agent finishes the work with its normal
 * mutation tools and calls again. There is no repair loop and no
 * automated rewrite of the user's app.
 *
 * On a clean evaluation, in order:
 *
 *   1. `materializeCaseStoreSchemas` — awaited. UPSERTs the
 *      `case_type_schemas` rows + per-property indexes for every case
 *      type the build produced, BEFORE any completion signal, so a
 *      user-initiated case-store action right after the celebration
 *      (sample-data populate, form submit, live preview) sees a synced
 *      Postgres schema. Runs on BOTH surfaces — on MCP the per-commit
 *      saga usually synced incrementally already (the call re-syncs
 *      idempotently), on chat the fire-and-forget intermediate saves
 *      never did.
 *   2. `completeApp` — awaited. Flips the app's lifecycle status to
 *      `complete` (generating→complete for chat builds, draft→complete
 *      for MCP builds, error→complete for a retried build) and persists
 *      the final blueprint snapshot.
 *
 * Failures in either step PROPAGATE — they are infrastructure faults no
 * doc edit repairs. The chat wrapper catches and routes them through the
 * classified-error path (the SA stops instead of retrying); the MCP
 * adapter's catch returns them as a tool-error envelope.
 *
 * The evaluation is `collectBoundaryViolations` — the same composition
 * every export entry point runs (full validator + resolved media
 * manifest + the aggregate export budget), so "complete" and "exports
 * cleanly" are one bar, not two.
 */

import { z } from "zod";
import { errorToString } from "@/lib/commcare/validator/errors";
import { completeApp } from "@/lib/db/apps";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { collectBoundaryViolations } from "@/lib/media/boundaryValidation";
import type { ToolExecutionContext } from "../toolExecutionContext";

export const completeBuildInputSchema = z.object({}).strict();

export type CompleteBuildInput = z.infer<typeof completeBuildInputSchema>;

/**
 * Shape the shared tool returns on every call. Tagged with
 * `kind: "complete"` so the MCP adapter's result projector dispatches
 * via the same discriminator `switch` the mutate/read shapes use.
 *
 * - `success` — `true` only when the boundary evaluation came back clean
 *   AND the completion side effects (materialize + status flip)
 *   committed.
 * - `errors` — the remaining findings, person-to-person, when the
 *   evaluation refused; absent on success.
 */
export interface CompleteBuildResult {
	kind: "complete";
	success: boolean;
	errors?: string[];
}

export const completeBuildTool = {
	description:
		"Finish the build: run the full app review (every rule, including completeness and attached media) and mark the app complete. Call when the app is fully built or your edits are done. If anything is still unfinished, the findings come back in the response — finish that work with your normal tools, then call completeBuild again.",
	inputSchema: completeBuildInputSchema,
	async execute(
		_input: CompleteBuildInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<CompleteBuildResult> {
		const violations = await collectBoundaryViolations(doc, ctx.userId);
		if (violations.length > 0) {
			return {
				kind: "complete",
				success: false,
				errors: violations.map(errorToString),
			};
		}

		const persistable = toPersistableDoc(doc);
		await materializeCaseStoreSchemas({
			appId: ctx.appId,
			userId: ctx.userId,
			blueprint: persistable,
		});
		await completeApp(ctx.appId, persistable, ctx.runId);
		return { kind: "complete", success: true };
	},
};
