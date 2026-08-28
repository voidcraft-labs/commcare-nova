/**
 * In-process XPath worker adapter for unit tests and non-browser harnesses.
 *
 * Kept outside workerClient.ts so importing the browser host protocol does not
 * also pull the evaluator and Java Pattern runtime into the main Builder
 * bundle. The browser fallback imports this only if a request is made in an
 * environment without Worker.
 */

import type { XPathWorkerFactory, XPathWorkerPort } from "./workerClient";
import type { XPathWorkerResponse } from "./workerProtocol";
import {
	createXPathWorkerDispatcher,
	type XPathWorkerEvaluator,
} from "./workerRuntime";

interface XPathWorkerMessageEvent {
	readonly data: XPathWorkerResponse;
}

export function createInProcessXPathWorkerFactory(
	evaluate?: XPathWorkerEvaluator,
): XPathWorkerFactory {
	return () => {
		let terminated = false;
		const messageListeners = new Set<
			(event: XPathWorkerMessageEvent) => void
		>();
		const errorListeners = new Set<() => void>();
		const dispatcher = createXPathWorkerDispatcher({
			evaluate,
			postMessage: (response) => {
				queueMicrotask(() => {
					if (terminated) return;
					for (const listener of messageListeners) listener({ data: response });
				});
			},
		});
		const port: XPathWorkerPort = {
			postMessage(message) {
				queueMicrotask(() => {
					if (terminated) return;
					try {
						dispatcher.handleMessage(message);
					} catch {
						for (const listener of errorListeners) listener();
					}
				});
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
				dispatcher.retire();
				messageListeners.clear();
				errorListeners.clear();
			},
		};
		return port;
	};
}
