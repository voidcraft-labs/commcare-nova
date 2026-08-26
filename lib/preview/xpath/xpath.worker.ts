import type { XPathWorkerRequest, XPathWorkerResponse } from "./workerProtocol";
import { createXPathWorkerDispatcher } from "./workerRuntime";

interface XPathDedicatedWorkerScope {
	postMessage(message: XPathWorkerResponse): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<XPathWorkerRequest>) => void,
	): void;
}

const workerScope = self as unknown as XPathDedicatedWorkerScope;
const dispatcher = createXPathWorkerDispatcher({
	postMessage: (response) => workerScope.postMessage(response),
});

workerScope.addEventListener("message", (event) => {
	dispatcher.handleMessage(event.data);
});
