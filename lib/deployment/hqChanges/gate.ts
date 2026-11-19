import type { ValidationError } from "@/lib/commcare/validator/errors";
import { userFacingError } from "@/lib/doc/userFacingErrors";

/**
 * The gate's refusal of a bring-in, from the findings the export boundary or
 * the commit's own gate made: each finding in the builder's voice
 * (`userFacingError`) for the panel and in the validator's own sentence for
 * MCP, every distinct sentence once.
 *
 * Two findings can say one thing to a person: a slug two pieces of worker
 * information hold is one finding per property, and the builder's line names
 * the slug alone. The panel lists that line once. The details keep the
 * validator's sentence of each finding, which names its own property, once
 * each, in the order of the builder line they belong to, so the two lists
 * read in one order.
 */
export function hqChangesGateRefusal(findings: readonly ValidationError[]): {
	readonly kind: "gate";
	readonly findings: readonly string[];
	readonly details: readonly string[];
} {
	const byLine = new Map<string, Set<string>>();
	for (const finding of findings) {
		const line = userFacingError(finding);
		const details = byLine.get(line) ?? new Set<string>();
		details.add(finding.message);
		byLine.set(line, details);
	}
	const details = new Set<string>();
	for (const sentences of byLine.values())
		for (const sentence of sentences) details.add(sentence);
	return {
		kind: "gate",
		findings: [...byLine.keys()],
		details: [...details],
	};
}
