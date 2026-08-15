/**
 * ArtifactResult — the closed outcome of one structured design call
 * (plan §7.1). A model response never advances pipeline state unless it
 * parsed; a non-produced result names WHY (truncation, invalid structured
 * output, cancellation) so the orchestrator's retry/terminal policy is a
 * switch, not string matching. Provider/network failures are NOT results —
 * they throw, and the caller classifies them as retriable operational
 * errors.
 */

import type { LanguageModelUsage } from "ai";
import type { SubGenerationObjectResult } from "@/lib/agent/subGeneration";

export type ArtifactResult<T> =
	| {
			kind: "produced";
			artifact: T;
			usage: LanguageModelUsage | undefined;
			finishReason: string | undefined;
			/** The call's display-safe reasoning summary, when one streamed;
			 *  persisted by the caller to the run event log beside the
			 *  artifact it explains, never into a design table. */
			reasoningText?: string;
	  }
	| {
			kind: "not-produced";
			reason: "length" | "invalid-structured-output" | "cancelled";
			usage?: LanguageModelUsage;
	  };

/** Map one structured-generation result into the closed artifact outcome.
 *  Call AFTER the run resolved; an abort that surfaced as a throw is the
 *  caller's catch (`signal.aborted` distinguishes it from a provider
 *  fault). */
export function toArtifactResult<T>(
	result: SubGenerationObjectResult<T>,
	signal: AbortSignal,
): ArtifactResult<T> {
	if (result.object !== null) {
		return {
			kind: "produced",
			artifact: result.object,
			usage: result.usage,
			finishReason: result.finishReason,
			...(result.reasoningText !== undefined && {
				reasoningText: result.reasoningText,
			}),
		};
	}
	if (signal.aborted) {
		return { kind: "not-produced", reason: "cancelled", usage: result.usage };
	}
	if (result.finishReason === "length") {
		return { kind: "not-produced", reason: "length", usage: result.usage };
	}
	return {
		kind: "not-produced",
		reason: "invalid-structured-output",
		usage: result.usage,
	};
}
