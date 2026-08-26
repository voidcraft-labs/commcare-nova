"use client";

import {
	XPathRuntime,
	type XPathRuntimeOptions,
	type XPathWorkerPort,
} from "./workerClient";

/** Keep the Worker constructor in an explicitly client-owned module so
 * Turbopack recognizes the TypeScript module as a worker entrypoint rather
 * than emitting its source as a generic static asset. */
export function createBrowserXPathWorker(): XPathWorkerPort {
	return new Worker(new URL("./xpath.worker.ts", import.meta.url), {
		type: "module",
	});
}

export function createBrowserXPathRuntime(
	options: Omit<XPathRuntimeOptions, "workerFactory"> = {},
): XPathRuntime {
	return new XPathRuntime({
		...options,
		workerFactory: createBrowserXPathWorker,
	});
}
