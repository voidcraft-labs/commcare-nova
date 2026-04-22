/**
 * SA tool: `validateApp` — run the CommCare validation + autofix loop.
 *
 * The shared layer owns only the validation + fix mechanics — drive
 * `validateAndFix`, serialize the errors, return the final working
 * doc + HQ JSON. Both the SA chat factory and the MCP adapter call
 * this through the shared `ToolExecutionContext` interface.
 *
 * Surface-specific side effects stay out of this module:
 *
 *   - The SA chat wrapper emits `data-done` with the persistable doc +
 *     HQ JSON on success, then fires `completeApp` to flip the app
 *     record to its final state. `data-done` is an SSE data part that
 *     only the chat surface emits; `completeApp` reads from
 *     `ctx.usage.runId`, which only exists on `GenerationContext`.
 *   - The MCP adapter would instead surface the errors / doc via
 *     whatever its response shape is — no SSE, no run-id.
 *
 * `validateAndFix` itself persists every mutation batch it emits
 * internally (connect-defaults, fix:attempt-N) via `ctx.recordMutations`,
 * so this tool has no outer mutations array for the SA wrapper to apply.
 * That's why the return type is the flat `ValidateAppResult` rather
 * than `MutatingToolResult<ValidateAppResult>` — the wrapper should
 * unconditionally `doc = result.doc` regardless of success, to pick up
 * any partial fixes the loop managed before giving up.
 */

import { z } from "zod";
import type { HqApplication } from "@/lib/commcare";
import { errorToString } from "@/lib/commcare/validator/errors";
import type { BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { validateAndFix } from "../validationLoop";

export const validateAppInputSchema = z.object({});

export type ValidateAppInput = z.infer<typeof validateAppInputSchema>;

/**
 * Shape the shared tool returns on every call.
 *
 * - `success` — `true` only when the fix loop reached zero errors AND
 *   post-expansion validation passed.
 * - `doc` — always present. The final working doc after all fix-registry
 *   mutations (and connect-defaults) land. On failure it still reflects
 *   the partial progress the loop made before stopping.
 * - `hqJson` — present whenever the loop reached the expansion step,
 *   even on failure. Downstream consumers can still render the XForm
 *   output for inspection.
 * - `errors` — the `errorToString`-formatted list of remaining issues;
 *   empty/absent on success.
 */
export interface ValidateAppResult {
	success: boolean;
	doc: BlueprintDoc;
	hqJson?: HqApplication;
	errors?: string[];
}

export const validateAppTool = {
	name: "validateApp" as const,
	description:
		"Validate the app against CommCare platform rules and fix any issues. Call this when you are done building or editing. If validation fails with remaining errors, use your mutation tools (removeField, editField, etc.) to fix them, then call validateApp again.",
	inputSchema: validateAppInputSchema,
	async execute(
		_input: ValidateAppInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<ValidateAppResult> {
		const result = await validateAndFix(ctx, doc);
		if (result.success) {
			return {
				success: true,
				doc: result.doc,
				...(result.hqJson !== undefined && { hqJson: result.hqJson }),
			};
		}
		return {
			success: false,
			doc: result.doc,
			...(result.hqJson !== undefined && { hqJson: result.hqJson }),
			errors: (result.errors ?? []).map(errorToString),
		};
	},
};
