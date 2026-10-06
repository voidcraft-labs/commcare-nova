import type { EngineEntryState } from "@/lib/preview/engine/engineController";
import type { XPathWorkerPort } from "@/lib/preview/xpath/workerClient";
import {
	XPATH_WORKER_BUILD_ID,
	type XPathWorkerEvaluateRequest,
	type XPathWorkerRequest,
	type XPathWorkerResponse,
} from "@/lib/preview/xpath/workerProtocol";

type EntryObservation = Pick<
	EngineEntryState,
	| "entryKey"
	| "formUuid"
	| "revision"
	| "ready"
	| "rebuilding"
	| "settling"
	| "topologySettling"
>;
type ProtocolIdentity = Pick<
	XPathWorkerRequest,
	"entryKey" | "revision" | "profile" | "buildId"
> & {
	readonly operation:
		| XPathWorkerRequest["operation"]
		| XPathWorkerResponse["operation"];
	readonly requestId?: number;
};
interface WorkerEvent {
	readonly sequence: number;
	readonly kind:
		| "entry"
		| "arm"
		| "create"
		| "hold"
		| "forward"
		| "response"
		| "terminate"
		| "release";
	readonly portId?: number;
	readonly armId?: number;
	readonly afterPortId?: number;
	readonly protocol?: ProtocolIdentity;
	readonly entry?: EntryObservation;
	readonly forwarded?: boolean;
}
const events: WorkerEvent[] = [];
let nextPortId = 0;
let nextArmId = 0;
let entry: EntryObservation | undefined;
let armed:
	| {
			readonly armId: number;
			readonly afterPortId: number;
			readonly entryKey: string;
	  }
	| undefined;
let held:
	| {
			readonly armId: number;
			readonly afterPortId: number;
			readonly portId: number;
			readonly request: XPathWorkerEvaluateRequest;
			live(): boolean;
			release(): void;
	  }
	| undefined;

function record(event: Omit<WorkerEvent, "sequence">) {
	events.push({ sequence: events.length + 1, ...event });
}
function identity(
	message: XPathWorkerRequest | XPathWorkerResponse,
): ProtocolIdentity {
	return {
		operation: message.operation,
		entryKey: message.entryKey,
		revision: message.revision,
		profile: message.profile,
		buildId: message.buildId,
		...("requestId" in message ? { requestId: message.requestId } : {}),
	};
}

/** Observe the actual entry publications in the same ordered timeline as the
 * native port. This observation neither writes nor calls the controller. */
export function observeLanguageWorkerEntry(state: EngineEntryState) {
	entry = {
		entryKey: state.entryKey,
		formUuid: state.formUuid,
		revision: state.revision,
		ready: state.ready,
		rebuilding: state.rebuilding,
		settling: state.settling,
		topologySettling: state.topologySettling,
	};
	record({ kind: "entry", entry });
}

/** Only request timing is controlled. The production runtime and public
 * browser Worker receive the original unmodified protocol and evaluate it. */
export function createBrowserXPathWorker(): XPathWorkerPort {
	const actual = new Worker(
		`/xpath-worker/xpath-worker.js?build=${encodeURIComponent(XPATH_WORKER_BUILD_ID)}`,
		{ type: "module" },
	);
	const portId = ++nextPortId;
	let terminated = false;
	const observeResponse = (event: MessageEvent<XPathWorkerResponse>) => {
		record({ kind: "response", portId, protocol: identity(event.data), entry });
	};
	actual.addEventListener("message", observeResponse);
	record({ kind: "create", portId, entry });
	return {
		postMessage(message) {
			if (
				armed !== undefined &&
				portId > armed.afterPortId &&
				message.operation === "evaluate" &&
				message.profile === "form" &&
				message.entryKey === armed.entryKey &&
				entry?.entryKey === message.entryKey &&
				!entry.ready &&
				entry.rebuilding
			) {
				const scope = armed;
				armed = undefined;
				held = {
					...scope,
					portId,
					request: message,
					live: () => !terminated,
					release() {
						record({
							kind: "release",
							...scope,
							portId,
							protocol: identity(message),
							entry,
							forwarded: !terminated,
						});
						if (!terminated) actual.postMessage(message);
					},
				};
				record({
					kind: "hold",
					...scope,
					portId,
					protocol: identity(message),
					entry,
				});
			} else {
				record({ kind: "forward", portId, protocol: identity(message), entry });
				actual.postMessage(message);
			}
		},
		addEventListener: actual.addEventListener.bind(actual),
		removeEventListener: actual.removeEventListener.bind(actual),
		terminate() {
			record({ kind: "terminate", portId, entry });
			terminated = true;
			actual.removeEventListener("message", observeResponse);
			actual.terminate();
		},
	};
}

export function armLanguageWorker() {
	if (armed !== undefined || held !== undefined)
		throw new Error("A language Worker request is already held");
	if (entry?.entryKey === undefined)
		throw new Error("A language Worker request needs an active entry");
	armed = {
		armId: ++nextArmId,
		afterPortId: nextPortId,
		entryKey: entry.entryKey,
	};
	record({ kind: "arm", ...armed, entry });
}
export function languageWorkerHeld() {
	return held?.live() ?? false;
}
export function releaseLanguageWorker() {
	armed = undefined;
	const pending = held;
	held = undefined;
	pending?.release();
}
export function languageWorkerObservation() {
	return {
		armed,
		held:
			held === undefined
				? undefined
				: {
						armId: held.armId,
						afterPortId: held.afterPortId,
						portId: held.portId,
						protocol: identity(held.request),
						live: held.live(),
					},
		events: events.slice(),
	};
}
