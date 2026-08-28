"use client";

import type { XPathWorkerPort } from "./workerClient";
import { XPATH_WORKER_BUILD_ID } from "./workerProtocol";

/** Keep the Worker constructor behind a dynamic client boundary so merely
 * opening the Builder does not instantiate or load the Preview runtime. */
export function createBrowserXPathWorker(): XPathWorkerPort {
	/* The worker is built as a public module asset by build-xpath-worker.mjs.
	 * Keeping source-relative Worker construction out of the Builder graph matters:
	 * Turbopack otherwise registers every worker chunk as an eager route script,
	 * downloading and parsing OpenJDK Pattern before Preview needs it. */
	return new Worker(
		`/xpath-worker/xpath-worker.js?build=${encodeURIComponent(XPATH_WORKER_BUILD_ID)}`,
		{ type: "module" },
	);
}
