import {
	Agent,
	getGlobalDispatcher,
	MockAgent,
	setGlobalDispatcher,
} from "undici";

/** Real fetch request construction and response parsing, with only the remote
 * HTTP peer controlled. Unexpected destinations cannot reach the network.
 * Inspect call history as well as pending replies: a client may catch a refused
 * unexpected request and turn it into an ordinary failure result. */
export async function withHttpPeer<T>(
	run: (peer: MockAgent) => Promise<T>,
): Promise<T> {
	const previous = getGlobalDispatcher();
	// Undici's legacy Node-fetch wrapper routes with allowH2:false, whose
	// cache key differs from MockAgent.get(origin). Supply the documented Agent
	// factory so every key resolves to a mock transport, never a network Pool.
	// https://github.com/nodejs/undici/issues/5036
	const peer: MockAgent = new MockAgent({
		agent: new Agent({ factory: (origin) => peer.get(String(origin)) }),
		enableCallHistory: true,
	});
	peer.disableNetConnect();
	setGlobalDispatcher(peer);
	try {
		const result = await run(peer);
		peer.assertNoPendingInterceptors();
		return result;
	} finally {
		setGlobalDispatcher(previous);
		await peer.close();
	}
}
