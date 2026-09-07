import { createBrowserXPathWorker } from "../../lib/preview/xpath/browserWorkerClient";
import { XPathRuntime } from "../../lib/preview/xpath/workerClient";
import type {
	XPathRuntimeRequest,
	XPathRuntimeResult,
} from "../../lib/preview/xpath/workerProtocol";

const runtime = new XPathRuntime({
	workerFactory: createBrowserXPathWorker,
	requestTimeoutMilliseconds: 2000,
});
let cancellation: AbortController | undefined;
let pending: Promise<XPathRuntimeResult> | undefined;
const request = (source: string): XPathRuntimeRequest => ({
	entryKey: "native-browser",
	revision: 1,
	profile: "form",
	source,
	instances: { contextPath: "/data/value" },
});
const api = {
	run: (source: string, timeoutMilliseconds = 2000) =>
		runtime.request(request(source), { timeoutMilliseconds }),
	startSleep() {
		cancellation = new AbortController();
		pending = runtime.request(request("sleep(60000, 'late')"), {
			signal: cancellation.signal,
		});
	},
	async cancelSleep() {
		cancellation?.abort();
		return await pending;
	},
	async dispose() {
		runtime.dispose();
		await pending;
	},
};
declare global {
	interface Window {
		previewXPathAudit: typeof api;
	}
}
window.previewXPathAudit = api;
