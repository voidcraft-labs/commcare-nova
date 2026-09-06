import {
	Agent,
	getGlobalDispatcher,
	MockAgent,
	setGlobalDispatcher,
} from "undici";

/** Bytes emitted by native fetch, including its streaming request bodies. */
export async function readHttpRequestBody(request: {
	body?: unknown;
}): Promise<Buffer<ArrayBuffer>> {
	const body = request.body;
	const chunks: Uint8Array[] = [];
	if (typeof body === "string") chunks.push(Buffer.from(body));
	else if (body instanceof Uint8Array) chunks.push(body);
	else if (body !== undefined && body !== null) {
		for await (const chunk of body as AsyncIterable<Uint8Array>)
			chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/** Consume the actual request bytes at the remote peer, then use the platform
 * multipart parser. This checks serialization as well as FormData assembly. */
export async function readMultipartRequest(request: {
	headers?: unknown;
	body?: unknown;
}): Promise<FormData> {
	const headers = new Headers(request.headers as Record<string, string>);
	return new Response(await readHttpRequestBody(request), {
		headers,
	}).formData();
}

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
