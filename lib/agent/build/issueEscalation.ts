/**
 * Design-issue escalation (the plan's §13.12) — the ONE thing a slice executor
 * may do when the accepted design cannot be implemented as written.
 *
 * Raising an issue ENDS the slice attempt's model loop. The executor states
 * what it hit and, at most, what it would consider; it cannot edit the Design
 * Contract, disposition a reviewer finding, or pick a new architecture. The
 * orchestrator decides what happens next — answer from accepted evidence,
 * revise and re-review the contract, ask the user, record a deferred
 * requirement, or fail the build as unsupported.
 *
 * This schema is the `raiseDesignExecutionIssue` tool's input contract; the
 * loop parses against it, and an invalid escalation comes back as a
 * self-correctable `{ error }` rather than a silent architecture change.
 */

import { z } from "zod";
import { sourceRefSchema } from "@/lib/agent/design/evidence";
import { designIdSchema } from "@/lib/agent/design/ids";
import { implementationCoordinateSchema } from "@/lib/agent/design/projection/coordinates";

export const designExecutionIssueSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: designIdSchema,
		category: z.enum([
			"missing-information",
			"contract-contradiction",
			"platform-gap",
			"stale-external-dependency",
			"implementation-impossibility",
		]),
		affectedIntentIds: z.array(designIdSchema).min(1),
		explanation: z.string().min(1),
		evidenceRefs: z.array(sourceRefSchema),
		implementationCoordinates: z.array(implementationCoordinateSchema),
		structuralImpact: z.enum(["local", "architecture"]),
		proposedOptions: z.array(z.string().min(1)).max(3),
	})
	.strict();

export type DesignExecutionIssue = z.infer<typeof designExecutionIssueSchema>;

/** Executor diagnostics belong in the run log, not in the conversation. The
 * missing-information arm is separately rendered as a question; every other
 * issue gets a short category-level explanation here. */
export function designIssueUserMessage(
	category: Exclude<DesignExecutionIssue["category"], "missing-information">,
): string {
	switch (category) {
		case "contract-contradiction":
			return "I found two design requirements that can’t both be applied safely. Nothing invalid was saved. Send a message and I’ll help resolve the conflict.";
		case "platform-gap":
			return "Part of this workflow isn’t supported by Nova’s current building tools. Nothing invalid was saved. Send a message and I’ll help adjust the design.";
		case "stale-external-dependency":
			return "Something this workflow relies on is missing or has changed. Nothing invalid was saved. Fix that setup, then try again.";
		case "implementation-impossibility":
			return "I couldn’t build this workflow safely as designed. Nothing invalid was saved. Send a message and I’ll help adjust it.";
	}
}
