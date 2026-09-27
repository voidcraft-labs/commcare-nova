import type { ToolExecutionPolicy } from "../sharedToolRegistry";

/** The shared boundary between private app edits and immediate external work.
 * Hosts provide authority and state; transport never changes an operation's effect. */
export function authoringExecutionPolicy(
	policy: ToolExecutionPolicy,
	state: { hasApp: boolean; hasPendingChanges: boolean },
):
	| { kind: "read" | "stage" | "canonical"; clearEmptyCandidate: boolean }
	| { kind: "refused"; error: string } {
	if (policy.effect === "read-blueprint")
		return { kind: "read", clearEmptyCandidate: false };
	if (policy.staging !== "forbidden")
		return { kind: "stage", clearEmptyCandidate: false };
	const lookupWrite = policy.capabilities.includes("lookup-write");
	if (!state.hasApp && !lookupWrite)
		return {
			kind: "refused",
			error:
				"Save the first complete workflow before using this operation. Its places, records and attachments need a saved app.",
		};
	if (state.hasPendingChanges && !lookupWrite)
		return {
			kind: "refused",
			error:
				policy.effect === "exercise-app"
					? "Save the current app changes before testing its worker journey."
					: "Save the current app changes before changing these records.",
		};
	return {
		kind: "canonical",
		clearEmptyCandidate: !lookupWrite && policy.effect !== "exercise-app",
	};
}
