import { XPathNodesetCardinalityError } from "./runtimeValues";
import type { XPathRuntimeError } from "./workerProtocol";

/** Preserve the controller's finite diagnostics across the worker boundary. */
export class PreviewXPathRuntimeError extends Error {
	readonly failureKind: string;

	constructor(readonly failure: XPathRuntimeError) {
		const reason = failure.reason;
		const failureKind = [
			"xpath",
			failure.code,
			...(reason === undefined ? [] : [reason.phase, reason.kind]),
		].join(":");
		super(`The XPath runtime failed (${failureKind}).`);
		this.name = "PreviewXPathRuntimeError";
		this.failureKind = failureKind;
	}
}

export function isNodesetCardinalityFailure(error: unknown): boolean {
	return (
		error instanceof XPathNodesetCardinalityError ||
		(error instanceof PreviewXPathRuntimeError &&
			error.failure.code === "evaluation-failed" &&
			error.failure.reason?.phase === "evaluation" &&
			error.failure.reason.kind === "nodeset-cardinality")
	);
}
