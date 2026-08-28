"use client";

export function createBrowserCaseWriteVerdictWorker(): Worker {
	return new Worker(new URL("./case-write-verdict.worker.ts", import.meta.url));
}
