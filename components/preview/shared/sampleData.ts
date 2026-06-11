// components/preview/shared/sampleData.ts
//
// Shared status shape + error wording for the sample-data actions
// (Generate / Reset). Both actions return the same
// `PopulateSampleCasesResult` from the case store, so every surface
// that offers one — the case-list canvas's empty state, the running
// preview's empty state, the list-panel inspector — drives the same
// three-state machine and renders the same error sentences.

import type { PopulateSampleCasesResult } from "@/lib/preview/engine/caseDataBindingTypes";

/**
 * Lifecycle status shared by the Generate and Reset sample-data
 * affordances: `idle` (no action in flight), `running` (action
 * awaiting, button shows a spinner + disables), and `error` (a non-ok
 * arm or a wire-level throw, message rendered inline below the
 * affordance).
 */
export type SampleDataStatus =
	| { kind: "idle" }
	| { kind: "running" }
	| { kind: "error"; message: string };

/**
 * Shape `PopulateSampleCasesResult`'s typed non-ok arms into the
 * user-facing inline error string. Both Generate and Reset map through
 * the same arms because both actions return the same result type from
 * the case-store; the only divergence is the leading verb in the
 * `validation-failure` / "Sign in to ..." sentences.
 */
export function describePopulateError(
	result: Exclude<PopulateSampleCasesResult, { kind: "ok" }>,
	verb: "Generate" | "Reset",
): string {
	const verbLower = verb.toLowerCase();
	switch (result.kind) {
		case "unauthenticated":
			return `Sign in to ${verbLower} sample data.`;
		case "missing-case-type":
			return `Case type '${result.caseType}' is no longer in the blueprint. Refresh the page and try again.`;
		case "schema-not-synced":
			return `Case type '${result.caseType}' isn't ready yet. Try again in a moment.`;
		case "validation-failure": {
			/* AJV's `path` is the JSONB pointer (`/age`, or `""` for
			 * the document root); strip the leading slash for
			 * readability and substitute `<root>` for the empty path. */
			const lines = result.failures.map((f) => {
				const field = f.path === "" ? "<root>" : f.path.replace(/^\//, "");
				return `${field}: ${f.message}`;
			});
			const header =
				verb === "Generate"
					? `Generated sample data for case type '${result.caseType}' didn't match its schema:`
					: `Regenerated sample data for case type '${result.caseType}' didn't match its schema:`;
			return `${header}\n${lines.join("\n")}`;
		}
		case "error":
			return result.message;
	}
}
