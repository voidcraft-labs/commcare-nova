"use client";

import {
	XPathRuntime,
	type XPathRuntimeOptions,
	type XPathWorkerMessageEvent,
	type XPathWorkerPort,
} from "./workerClient";
import type { XPathWorkerRequest } from "./workerProtocol";

type WorkerLoader = () => Promise<XPathWorkerPort>;

/**
 * Keep the synchronous worker-port contract while loading its implementation
 * only after the first evaluation request. In production this dynamic boundary
 * is what keeps the small Worker host out of a Builder session that never
 * needs asynchronous XPath evaluation. The evaluator itself is a separately
 * built public Worker asset and never enters the main-realm module graph.
 */
function createDeferredXPathWorker(load: WorkerLoader): XPathWorkerPort {
	let delegate: XPathWorkerPort | undefined;
	let terminated = false;
	const queuedMessages: XPathWorkerRequest[] = [];
	const messageListeners = new Set<(event: XPathWorkerMessageEvent) => void>();
	const errorListeners = new Set<() => void>();
	const forwardMessage = (event: XPathWorkerMessageEvent) => {
		for (const listener of messageListeners) listener(event);
	};
	const forwardError = () => {
		for (const listener of errorListeners) listener();
	};

	void load()
		.then((loaded) => {
			if (terminated) {
				loaded.terminate();
				return;
			}
			delegate = loaded;
			delegate.addEventListener("message", forwardMessage);
			delegate.addEventListener("error", forwardError);
			for (const message of queuedMessages) delegate.postMessage(message);
			queuedMessages.length = 0;
		})
		.catch(() => {
			if (!terminated) forwardError();
		});

	return {
		postMessage(message) {
			if (terminated) return;
			if (delegate === undefined) queuedMessages.push(message);
			else delegate.postMessage(message);
		},
		addEventListener(type, listener) {
			if (type === "message") {
				messageListeners.add(
					listener as (event: XPathWorkerMessageEvent) => void,
				);
			} else {
				errorListeners.add(listener as () => void);
			}
		},
		removeEventListener(type, listener) {
			if (type === "message") {
				messageListeners.delete(
					listener as (event: XPathWorkerMessageEvent) => void,
				);
			} else {
				errorListeners.delete(listener as () => void);
			}
		},
		terminate() {
			if (terminated) return;
			terminated = true;
			queuedMessages.length = 0;
			if (delegate !== undefined) {
				delegate.removeEventListener("message", forwardMessage);
				delegate.removeEventListener("error", forwardError);
				delegate.terminate();
			}
			messageListeners.clear();
			errorListeners.clear();
		},
	};
}

function createLazyXPathWorker(): XPathWorkerPort {
	return createDeferredXPathWorker(async () => {
		/* Component tests run the real engine in jsdom, which deliberately has no
		 * Worker implementation. Keep their exact evaluator adapter behind the
		 * compile-time test branch; production builds erase this import, so the
		 * worker runtime cannot become a main-realm route chunk. */
		if (process.env.NODE_ENV === "test") {
			const { createInProcessXPathWorkerFactory } = await import(
				"./inProcessWorkerClient"
			);
			return createInProcessXPathWorkerFactory()();
		}
		const { createBrowserXPathWorker } = await import("./browserWorkerClient");
		return createBrowserXPathWorker();
	});
}

export function createBrowserXPathRuntime(
	options: Omit<XPathRuntimeOptions, "workerFactory"> = {},
): XPathRuntime {
	return new XPathRuntime({
		...options,
		onBuildMismatch:
			options.onBuildMismatch ??
			(() => {
				if (typeof window !== "undefined") window.location.reload();
			}),
		workerFactory: createLazyXPathWorker,
	});
}
