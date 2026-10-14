import { type ClientRequest, createServer, request } from "node:http";

/** Forward a browser's native HTTP to the real application with its docs Host. */
export async function docsHostPeer(baseURL: string) {
	const target = new URL(baseURL);
	if (
		target.protocol !== "http:" ||
		!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
	)
		throw new Error("Docs peer needs a local HTTP app");
	const pending = new Map<ClientRequest, Promise<void>>();
	const errors: Error[] = [];
	let unreadableIndex = true;
	const server = createServer((incoming, outgoing) => {
		if (incoming.url === "/api/search" && unreadableIndex) {
			unreadableIndex = false;
			outgoing.writeHead(200, { "content-type": "application/json" });
			outgoing.end("null");
			return;
		}
		let cancelled = false;
		const path = new URL(incoming.url ?? "/", "http://docs-peer.invalid");
		const upstream = request(
			{
				hostname: target.hostname === "[::1]" ? "::1" : target.hostname,
				port: target.port,
				path: `${path.pathname}${path.search}`,
				method: incoming.method,
				headers: { ...incoming.headers, host: "docs.commcare.app" },
				agent: false,
			},
			(response) => {
				outgoing.writeHead(response.statusCode ?? 502, response.headers);
				response.on("error", (error) => {
					if (!cancelled) errors.push(error);
					outgoing.destroy();
				});
				response.pipe(outgoing);
				outgoing.once("close", () => response.destroy());
			},
		);
		const closed = new Promise<void>((resolve) =>
			upstream.once("close", resolve),
		);
		pending.set(upstream, closed);
		upstream.once("close", () => pending.delete(upstream));
		upstream.on("error", (error) => {
			if (!cancelled) errors.push(error);
			if (!outgoing.headersSent) outgoing.writeHead(502);
			outgoing.end();
		});
		outgoing.once("close", () => {
			cancelled = true;
			upstream.destroy();
		});
		incoming.pipe(upstream);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing docs peer port");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		async close() {
			server.closeAllConnections();
			const remaining = [...pending];
			for (const [client] of remaining) client.destroy();
			await Promise.all(remaining.map(([, closed]) => closed));
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			if (errors.length)
				throw new AggregateError(errors, "Docs forwarding failed");
		},
	};
}
