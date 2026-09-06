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

/** Exercise native HTTP streaming over a real loopback socket. Only the named
 * HQ host can connect; the transport remaps that host to this HTTP peer without
 * TLS. This proves request/body/socket lifetime, not TLS configuration. */
export async function withSocketHttpPeer<T>(
	hostname: string,
	onRequest: RequestListener,
	run: () => Promise<T>,
): Promise<T> {
	const server = createServer(onRequest);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing HTTP peer port");
	const previous = getGlobalDispatcher();
	const dispatcher = new Agent({
		connect(options, callback) {
			if (options.hostname !== hostname) {
				callback(new Error("Unexpected HTTP destination"), null);
				return;
			}
			const socket = createConnection({
				host: "127.0.0.1",
				port: address.port,
			});
			const failed = (error: Error) => callback(error, null);
			socket.once("error", failed);
			socket.once("connect", () => {
				socket.off("error", failed);
				callback(null, socket);
			});
		},
	});
	setGlobalDispatcher(dispatcher);
	try {
		return await run();
	} finally {
		setGlobalDispatcher(previous);
		await dispatcher.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

import { createServer, type RequestListener } from "node:http";
import { createConnection } from "node:net";
