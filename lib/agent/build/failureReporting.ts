export type BuildFailureOperationalClass =
	| "expected-prerequisite"
	| "unexpected-failure";

/** Keep user-facing resumability separate from incident-reporting severity. */
export function designBuildFailureLogLevel(
	operationalClass: BuildFailureOperationalClass,
): "warn" | "error" {
	return operationalClass === "expected-prerequisite" ? "warn" : "error";
}
