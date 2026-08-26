/**
 * Structured-clone-safe protocol for browser XPath evaluation.
 *
 * `source`, instance values, and node paths are deliberately confined to the
 * request. Error results expose only bounded protocol metadata; callers must
 * not add request payloads to diagnostics.
 */

export const XPATH_WORKER_PROTOCOL_VERSION = 5 as const;

/** A finite, non-identifying label for the surface requesting evaluation. */
export type XPathWorkerProfile =
	| "form"
	| "form-link"
	| "lookup"
	| "navigation"
	| "search";

export interface SerializedXPathDate {
	readonly kind: "date";
	readonly days: number;
	readonly timeMilliseconds: number | null;
}

export type SerializedXPathValue =
	| string
	| number
	| boolean
	| SerializedXPathDate;

export interface XPathWorkerNodeSnapshot {
	readonly name: string;
	readonly path: string;
	readonly kind: "element" | "attribute";
	readonly multiplicity: number;
	readonly value: SerializedXPathValue;
	readonly relevant: boolean;
	readonly children: readonly XPathWorkerNodeSnapshot[];
	readonly attributes: readonly XPathWorkerNodeSnapshot[];
	readonly templateChildren?: readonly XPathWorkerNodeSnapshot[];
	readonly templateAttributes?: readonly XPathWorkerNodeSnapshot[];
	readonly childTemplateNames?: readonly string[];
	readonly attributeTemplateNames?: readonly string[];
}

export interface XPathWorkerInstanceSnapshot {
	readonly id: string | null;
	readonly root: XPathWorkerNodeSnapshot;
}

export interface XPathWorkerNodeAddress {
	readonly instanceId: string | null;
	readonly path: string;
}

export interface XPathWorkerPathValue {
	readonly path: string;
	readonly value: SerializedXPathValue;
}

export interface XPathWorkerPathRelevance {
	readonly path: string;
	readonly relevant: boolean;
}

export interface XPathWorkerScalarHashtagValue {
	readonly reference: string;
	readonly kind: "scalar";
	readonly value: SerializedXPathValue;
}

export interface XPathWorkerNodesetHashtagValue {
	readonly reference: string;
	readonly kind: "nodeset";
	readonly candidates: readonly XPathWorkerNodeAddress[];
	readonly validPath: boolean;
}

export type XPathWorkerHashtagValue =
	| XPathWorkerScalarHashtagValue
	| XPathWorkerNodesetHashtagValue;

/**
 * One immutable evaluation-world projection. The host may provide a
 * structural main instance, named secondary instances, scalar path fallbacks,
 * or any combination needed by the selected profile.
 */
export interface XPathWorkerInstances {
	/** One worker-local evaluation world. The first request initializes the
	 * structural instances; later requests in the same revision reuse them and
	 * carry only changed main-instance values plus per-expression context. */
	readonly worldKey?: string;
	readonly initializeWorld?: boolean;
	readonly locale?: string;
	readonly main?: XPathWorkerInstanceSnapshot;
	readonly secondary?: readonly XPathWorkerInstanceSnapshot[];
	readonly pathValues?: readonly XPathWorkerPathValue[];
	/** Effective relevance changes for nodes already cached in `main`.
	 * Ancestor relevance is folded in by the host before crossing the worker
	 * boundary, matching the relevant flags in the initial snapshot. */
	readonly pathRelevance?: readonly XPathWorkerPathRelevance[];
	readonly hashtagValues?: readonly XPathWorkerHashtagValue[];
	readonly contextPath: string;
	readonly position?: number;
	readonly contextNode?: XPathWorkerNodeAddress;
	readonly originalContextNode?: XPathWorkerNodeAddress;
}

export interface XPathRuntimeRequest {
	readonly entryKey: string;
	readonly revision: number;
	readonly profile: XPathWorkerProfile;
	readonly source: string;
	readonly instances: XPathWorkerInstances;
	/** Scalar is the ordinary XPath contract. Query-bound repeats need each
	 * selected node's lexical value so Preview can seed the same per-iteration
	 * `@id` values as JavaRosa without cloning nodes or paths back. */
	readonly resultMode?: "scalar" | "nodeset-values-or-scalar";
}

interface XPathWorkerMessageIdentity {
	readonly protocolVersion: typeof XPATH_WORKER_PROTOCOL_VERSION;
	readonly requestId: number;
	readonly entryKey: string;
	readonly revision: number;
	readonly profile: XPathWorkerProfile;
}

export interface XPathWorkerEvaluateRequest
	extends XPathWorkerMessageIdentity,
		XPathRuntimeRequest {
	readonly operation: "evaluate";
}

export interface XPathWorkerCancelRequest extends XPathWorkerMessageIdentity {
	readonly operation: "cancel";
}

export interface XPathWorkerRetireRequest {
	readonly protocolVersion: typeof XPATH_WORKER_PROTOCOL_VERSION;
	readonly operation: "retire";
	readonly entryKey: string;
	readonly revision: number;
	readonly profile: XPathWorkerProfile;
}

export type XPathWorkerRequest =
	| XPathWorkerEvaluateRequest
	| XPathWorkerCancelRequest
	| XPathWorkerRetireRequest;

export type XPathRuntimeErrorCode =
	| "cancelled"
	| "evaluation-failed"
	| "invalid-request"
	| "protocol-mismatch"
	| "retired"
	| "stale"
	| "timeout"
	| "worker-failed";

/** Safe to surface to internal diagnostics. It never includes evaluation data. */
export interface XPathRuntimeError {
	readonly code: XPathRuntimeErrorCode;
	readonly operation: "evaluate";
	readonly entryKey: string;
	readonly revision: number;
	readonly profile: XPathWorkerProfile;
}

export interface XPathRuntimeSuccess {
	readonly ok: true;
	readonly entryKey: string;
	readonly revision: number;
	readonly profile: XPathWorkerProfile;
	readonly value: SerializedXPathValue;
	readonly nodesetValues?: readonly string[];
}

export interface XPathRuntimeFailure {
	readonly ok: false;
	readonly error: XPathRuntimeError;
}

export type XPathRuntimeResult = XPathRuntimeSuccess | XPathRuntimeFailure;

export interface XPathWorkerEvaluateSuccess extends XPathWorkerMessageIdentity {
	readonly operation: "evaluate";
	readonly ok: true;
	readonly value: SerializedXPathValue;
	readonly nodesetValues?: readonly string[];
}

export interface XPathWorkerEvaluateFailure extends XPathWorkerMessageIdentity {
	readonly operation: "evaluate";
	readonly ok: false;
	readonly error: XPathRuntimeError;
}

/** Pause the host's CPU watchdog only while a JavaRosa function intentionally
 * yields through the worker timer boundary. No authored value or duration
 * crosses back to the host. */
export interface XPathWorkerWatchdogResponse
	extends XPathWorkerMessageIdentity {
	readonly operation: "watchdog";
	readonly state: "pause" | "resume";
}

export type XPathWorkerResponse =
	| XPathWorkerEvaluateSuccess
	| XPathWorkerEvaluateFailure
	| XPathWorkerWatchdogResponse;
