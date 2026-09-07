import { createServer, type RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import {
	createModelCallTransport,
	MODEL_CALL_TIMEOUT_MS,
} from "@/lib/agent/openaiProvider";

// These are socket contracts. Fake time or a mocked fetch cannot prove them.
async function withTransport(
	handler: RequestListener,
	timeout: number,
	run: (fetch: typeof globalThis.fetch, url: string) => Promise<void>,
) {
	const server = createServer(handler);
	const transport = createModelCallTransport(timeout);
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No HTTP port");
		await run(transport.fetch, `http://127.0.0.1:${address.port}/`);
	} finally {
		// Destruction also releases a deliberately stalled request on assertion failure.
		await transport.destroy();
		server.closeAllConnections();
		if (server.listening) {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	}
}

describe("model HTTP transport", () => {
	it("sets the reasoning ceiling above the package's five-minute default", () => {
		expect(MODEL_CALL_TIMEOUT_MS).toBeGreaterThan(300_000);
	});

	it("transmits request method, headers and body and reads the response", async () => {
		let request:
			| { method: string | undefined; token: string | undefined; body: string }
			| undefined;
		await withTransport(
			(req, res) => {
				let body = "";
				req.setEncoding("utf8");
				req.on("data", (chunk) => {
					body += chunk;
				});
				req.on("end", () => {
					request = {
						method: req.method,
						token: req.headers.authorization,
						body,
					};
					res.writeHead(201, { "content-type": "text/plain" });
					res.end("accepted");
				});
			},
			MODEL_CALL_TIMEOUT_MS,
			async (fetch, url) => {
				const response = await fetch(url, {
					method: "POST",
					headers: { authorization: "Bearer synthetic" },
					body: "question",
				});
				expect(response.status).toBe(201);
				expect(await response.text()).toBe("accepted");
				expect(request).toEqual({
					method: "POST",
					token: "Bearer synthetic",
					body: "question",
				});
			},
		);
	});

	it("reports a header timeout after the server receives a request but sends no headers", async () => {
		let received = false;
		await withTransport(
			() => {
				received = true;
			},
			10,
			async (fetch, url) => {
				await expect(fetch(url)).rejects.toMatchObject({
					cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
				});
				expect(received).toBe(true);
			},
		);
	});

	it("reports a body timeout when a response stops between chunks", async () => {
		await withTransport(
			(_req, res) => {
				res.write("first");
			},
			10,
			async (fetch, url) => {
				const response = await fetch(url);
				expect(response.status).toBe(200);
				await expect(response.text()).rejects.toMatchObject({
					cause: { code: "UND_ERR_BODY_TIMEOUT" },
				});
			},
		);
	});

	it.each(["headers", "body"])(
		"caller cancellation interrupts the long ceiling while awaiting %s",
		async (phase) => {
			const received = Promise.withResolvers<void>();
			const disconnected = Promise.withResolvers<void>();
			await withTransport(
				(_req, res) => {
					res.once("close", () => disconnected.resolve());
					if (phase === "body") res.write("first");
					received.resolve();
				},
				MODEL_CALL_TIMEOUT_MS,
				async (fetch, url) => {
					const controller = new AbortController();
					const fetching = fetch(url, { signal: controller.signal });
					// Await actual headers in the body case so cancellation cannot pass by
					// aborting the earlier stage before the response was exposed to callers.
					const pending = phase === "body" ? (await fetching).text() : fetching;
					const rejection = expect(pending).rejects.toMatchObject({
						name: "AbortError",
					});
					await received.promise;
					controller.abort();
					await rejection;
					await disconnected.promise;
				},
			);
		},
	);
});
