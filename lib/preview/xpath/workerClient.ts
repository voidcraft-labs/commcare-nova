import {
	XPATH_WORKER_PROTOCOL_VERSION,
	type XPathRuntimeError,
	type XPathRuntimeErrorCode,
	type XPathRuntimeRequest,
	type XPathRuntimeResult,
	type XPathWorkerEvaluateRequest,
	type XPathWorkerRequest,
	type XPathWorkerResponse,
} from "./workerProtocol";

export interface XPathWorkerMessageEvent {
	readonly data: XPathWorkerResponse;
}

export interface XPathWorkerPort {
	postMessage(message: XPathWorkerRequest): void;
	addEventListener(
		type: "message",
		listener: (event: XPathWorkerMessageEvent) => void,
	): void;
	addEventListener(type: "error", listener: () => void): void;
	removeEventListener(
		type: "message",
		listener: (event: XPathWorkerMessageEvent) => void,
	): void;
	removeEventListener(type: "error", listener: () => void): void;
	terminate(): void;
}

export type XPathWorkerFactory = () => XPathWorkerPort;

export interface XPathRuntimeOptions {
	readonly workerFactory: XPathWorkerFactory;
	readonly requestTimeoutMilliseconds?: number;
}

export interface XPathRequestOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMilliseconds?: number;
}

interface ActiveWorker {
	readonly port: XPathWorkerPort;
	readonly generation: number;
	readonly entryKey: string;
	revision: number;
	readonly profile: XPathRuntimeRequest["profile"];
}

interface PendingRequest {
	readonly request: XPathWorkerEvaluateRequest;
	readonly generation: number;
	readonly resolve: (result: XPathRuntimeResult) => void;
	readonly abortSignal?: AbortSignal;
	readonly onAbort?: () => void;
	readonly timeoutMilliseconds?: number;
	timeout?: ReturnType<typeof setTimeout>;
}

function failure(
	request: Pick<XPathRuntimeRequest, "entryKey" | "revision" | "profile">,
	code: XPathRuntimeErrorCode,
): XPathRuntimeResult {
	const error: XPathRuntimeError = {
		code,
		operation: "evaluate",
		entryKey: request.entryKey,
		revision: request.revision,
		profile: request.profile,
	};
	return { ok: false, error };
}

function sameScope(
	active: ActiveWorker,
	request: XPathRuntimeRequest,
): boolean {
	return (
		active.entryKey === request.entryKey && active.profile === request.profile
	);
}

/** Revision- and entry-fenced host for one reusable browser worker. */
export class XPathRuntime {
	private readonly factory: XPathWorkerFactory;
	private readonly defaultTimeout: number | undefined;
	private active: ActiveWorker | undefined;
	private generation = 0;
	private nextRequestId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private suspended = false;
	private disposed = false;

	constructor(options: XPathRuntimeOptions) {
		this.factory = options.workerFactory;
		this.defaultTimeout = options.requestTimeoutMilliseconds;
	}

	request(
		input: XPathRuntimeRequest,
		options: XPathRequestOptions = {},
	): Promise<XPathRuntimeResult> {
		if (this.disposed || this.suspended) {
			return Promise.resolve(failure(input, "retired"));
		}
		if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
			return Promise.resolve(failure(input, "invalid-request"));
		}
		if (options.signal?.aborted) {
			return Promise.resolve(failure(input, "cancelled"));
		}
		const timeoutMilliseconds =
			options.timeoutMilliseconds ?? this.defaultTimeout;
		if (
			timeoutMilliseconds !== undefined &&
			(!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 0)
		) {
			return Promise.resolve(failure(input, "invalid-request"));
		}
		if (this.active !== undefined) {
			if (!sameScope(this.active, input)) {
				this.retireActive("stale");
			} else if (this.active.revision !== input.revision) {
				/* A settled form entry keeps its already-loaded worker across
				 * revisions. If older work is still in flight, termination remains the
				 * only reliable cancellation for synchronous Java Pattern evaluation. */
				const hasPendingRevision = [...this.pending.values()].some(
					(pending) => pending.generation === this.active?.generation,
				);
				if (hasPendingRevision) this.retireActive("stale");
				else this.active.revision = input.revision;
			}
		}
		let active = this.active;
		if (active === undefined) {
			try {
				active = this.startWorker(input);
			} catch {
				return Promise.resolve(failure(input, "worker-failed"));
			}
		}
		const request: XPathWorkerEvaluateRequest = {
			...input,
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "evaluate",
			requestId: this.nextRequestId++,
		};

		return new Promise((resolve) => {
			const onAbort = options.signal
				? () => {
						try {
							active.port.postMessage({
								protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
								operation: "cancel",
								requestId: request.requestId,
								entryKey: request.entryKey,
								revision: request.revision,
								profile: request.profile,
							});
						} catch {
							// The local cancellation result remains authoritative.
						}
						this.settle(request.requestId, failure(request, "cancelled"));
						/* A browser Worker cannot consume the cancel message while a
						 * synchronous Java Pattern evaluation is backtracking. Settling the
						 * Promise would otherwise clear its only CPU watchdog and leave the
						 * generation blocked forever. Termination is the out-of-band
						 * cancellation acknowledgement; sibling requests in this generation
						 * retire and the next request starts a clean worker. */
						if (this.active?.generation === active.generation) {
							this.retireActive("retired");
						}
					}
				: undefined;
			this.pending.set(request.requestId, {
				request,
				generation: active.generation,
				resolve,
				abortSignal: options.signal,
				onAbort,
				timeoutMilliseconds,
			});
			this.armWatchdog(request.requestId);
			options.signal?.addEventListener("abort", onAbort as () => void, {
				once: true,
			});
			try {
				active.port.postMessage(request);
			} catch {
				this.settle(request.requestId, failure(request, "protocol-mismatch"));
				this.retireActive("worker-failed");
			}
		});
	}

	/** Retire an entry on navigation or a controller-owned entry rotation. */
	retire(entryKey?: string): void {
		if (entryKey !== undefined && this.active?.entryKey !== entryKey) return;
		this.retireActive("retired");
	}

	/**
	 * Re-arm the provider-owned runtime after React Strict Mode's development
	 * setup-cleanup-setup replay. A terminally disposed runtime stays closed.
	 */
	resume(): void {
		if (this.disposed) return;
		this.suspended = false;
	}

	/**
	 * Stop every worker and timer without making this owner permanently unusable.
	 * React providers use this for effect cleanup because Strict Mode replays that
	 * cleanup against the same state-created runtime before mounting effects again.
	 */
	suspend(): void {
		if (this.disposed || this.suspended) return;
		this.suspended = true;
		this.retireActive("retired");
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.suspended = true;
		this.retireActive("retired");
	}

	private startWorker(request: XPathRuntimeRequest): ActiveWorker {
		const port = this.factory();
		const active: ActiveWorker = {
			port,
			generation: ++this.generation,
			entryKey: request.entryKey,
			revision: request.revision,
			profile: request.profile,
		};
		port.addEventListener("message", this.handleMessage);
		port.addEventListener("error", this.handleError);
		this.active = active;
		return active;
	}

	private readonly handleMessage = (event: XPathWorkerMessageEvent): void => {
		const response = event.data;
		const pending = this.pending.get(response.requestId);
		const active = this.active;
		if (pending === undefined || active === undefined) return;
		if (
			pending.generation !== active.generation ||
			response.protocolVersion !== XPATH_WORKER_PROTOCOL_VERSION ||
			response.entryKey !== pending.request.entryKey ||
			response.revision !== pending.request.revision ||
			response.profile !== pending.request.profile
		) {
			this.settle(
				response.requestId,
				failure(pending.request, "protocol-mismatch"),
			);
			this.retireActive("worker-failed");
			return;
		}
		if (response.operation === "watchdog") {
			if (response.state === "pause") this.pauseWatchdog(pending);
			else this.armWatchdog(response.requestId);
			return;
		}
		this.settle(
			response.requestId,
			response.ok
				? {
						ok: true,
						entryKey: response.entryKey,
						revision: response.revision,
						profile: response.profile,
						value: response.value,
						...(response.nodesetValues === undefined
							? {}
							: { nodesetValues: response.nodesetValues }),
					}
				: failure(pending.request, response.error.code),
		);
	};

	private readonly handleError = (): void => {
		this.retireActive("worker-failed");
	};

	private settle(requestId: number, result: XPathRuntimeResult): void {
		const pending = this.pending.get(requestId);
		if (pending === undefined) return;
		this.pending.delete(requestId);
		if (pending.timeout !== undefined) clearTimeout(pending.timeout);
		if (pending.onAbort !== undefined) {
			pending.abortSignal?.removeEventListener("abort", pending.onAbort);
		}
		pending.resolve(result);
	}

	private pauseWatchdog(pending: PendingRequest): void {
		if (pending.timeout === undefined) return;
		clearTimeout(pending.timeout);
		pending.timeout = undefined;
	}

	private armWatchdog(requestId: number): void {
		const pending = this.pending.get(requestId);
		if (pending?.timeoutMilliseconds === undefined) return;
		this.pauseWatchdog(pending);
		pending.timeout = setTimeout(() => {
			this.settle(requestId, failure(pending.request, "timeout"));
			this.retireActive("retired");
		}, pending.timeoutMilliseconds);
	}

	private retireActive(code: XPathRuntimeErrorCode): void {
		const active = this.active;
		if (active === undefined) return;
		this.active = undefined;
		try {
			active.port.postMessage({
				protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
				operation: "retire",
				entryKey: active.entryKey,
				revision: active.revision,
				profile: active.profile,
			});
		} catch {
			// Termination below is authoritative; no request data is reported.
		}
		active.port.removeEventListener("message", this.handleMessage);
		active.port.removeEventListener("error", this.handleError);
		try {
			active.port.terminate();
		} catch {
			// Pending requests are still fenced and settled below.
		}
		for (const [requestId, pending] of this.pending) {
			if (pending.generation === active.generation) {
				this.settle(requestId, failure(pending.request, code));
			}
		}
	}
}
