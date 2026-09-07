import { createServer } from "node:http";
import { build } from "esbuild";
import { expect, test } from "../lib/fixtures";

test("native upload progress, cancellation, HTTP refusal and setup failure release the transfer", async ({
	page,
}) => {
	const bundle = await build({
		entryPoints: ["components/builder/media/mediaClient.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		write: false,
	});
	const received: {
		name: string;
		contentType: string | undefined;
		cap: string | undefined;
		bytes: number;
	}[] = [];
	const confirms: string[] = [];
	let origin = "";
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", origin);
		if (url.pathname === "/client.js") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(bundle.outputFiles[0].text);
			return;
		}
		if (url.pathname === "/api/media/upload") {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				const { filename } = JSON.parse(body) as { filename: string };
				response.setHeader("Content-Type", "application/json");
				response.end(
					JSON.stringify({
						assetId: filename,
						deduplicated: false,
						uploadUrl:
							filename === "invalid.png"
								? "http://["
								: `${origin}/bytes/${filename}`,
						uploadContentType: "image/png",
						uploadHeaders: { "x-goog-content-length-range": "0,4194304" },
					}),
				);
			});
			return;
		}
		if (url.pathname.startsWith("/bytes/")) {
			let bytes = 0;
			request.on("data", (chunk) => {
				bytes += chunk.length;
			});
			request.on("end", () => {
				const name = url.pathname.slice("/bytes/".length);
				received.push({
					name,
					contentType: request.headers["content-type"],
					cap: String(request.headers["x-goog-content-length-range"]),
					bytes,
				});
				response.statusCode = name === "refused.png" ? 403 : 200;
				response.end();
			});
			return;
		}
		if (url.pathname.endsWith("/confirm")) {
			const filename = url.pathname.split("/")[4];
			confirms.push(filename);
			response.setHeader("Content-Type", "application/json");
			response.end(
				JSON.stringify({ ok: true, asset: { id: filename, status: "ready" } }),
			);
			return;
		}
		response.setHeader("Content-Type", "text/html");
		response.end("<!doctype html><title>Native upload transport</title>");
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing transport server port");
	origin = `http://127.0.0.1:${address.port}`;
	try {
		await page.goto(origin);
		const outcomes = await page.evaluate(async () => {
			const { uploadMediaAsset } = (await import(
				`${location.origin}/client.js`
			)) as typeof import("../../components/builder/media/mediaClient");
			const results = [];
			for (const filename of [
				"success.png",
				"refused.png",
				"cancel.png",
				"invalid.png",
			]) {
				const controller = new AbortController();
				const subscriptions = new Set<EventListenerOrEventListenerObject>();
				const add = controller.signal.addEventListener.bind(controller.signal);
				const remove = controller.signal.removeEventListener.bind(
					controller.signal,
				);
				controller.signal.addEventListener = (
					type: string,
					callback: EventListenerOrEventListenerObject,
					options?: boolean | AddEventListenerOptions,
				) => {
					if (type === "abort") subscriptions.add(callback);
					add(type, callback, options);
				};
				controller.signal.removeEventListener = (
					type: string,
					callback: EventListenerOrEventListenerObject,
					options?: boolean | EventListenerOptions,
				) => {
					subscriptions.delete(callback);
					remove(type, callback, options);
				};
				const progress: number[] = [];
				let errorName: string | undefined,
					errorMessage: string | undefined,
					assetId: string | undefined;
				try {
					const asset = await uploadMediaAsset(
						new File([new Uint8Array(2 * 1024 * 1024)], filename, {
							type: "image/png",
						}),
						{
							signal: controller.signal,
							onProgress: (fraction) => {
								progress.push(fraction);
								if (filename === "cancel.png") controller.abort();
							},
						},
					);
					assetId = asset.id;
				} catch (error) {
					if (!(error instanceof Error)) throw error;
					errorName = error.name;
					errorMessage = error.message;
				}
				results.push({
					filename,
					progress,
					errorName,
					errorMessage,
					assetId,
					subscriptions: subscriptions.size,
				});
				controller.signal.addEventListener = add;
				controller.signal.removeEventListener = remove;
				controller.abort();
			}
			return results;
		});
		expect(outcomes[0].assetId).toBe("success.png");
		expect(outcomes[0].progress.at(-1)).toBe(1);
		expect(outcomes[0].progress.every((value) => value > 0 && value <= 1)).toBe(
			true,
		);
		expect(outcomes[1].errorMessage).toContain("upload didn't finish");
		expect(outcomes[2].errorName).toBe("AbortError");
		expect(outcomes[2].progress.length).toBeGreaterThan(0);
		expect(outcomes[3].errorName).toBe("SyntaxError");
		expect(outcomes.map((result) => result.subscriptions)).toEqual([
			0, 0, 0, 0,
		]);
		expect(confirms).toEqual(["success.png"]);
		expect(received.find((row) => row.name === "success.png")).toEqual({
			name: "success.png",
			contentType: "image/png",
			cap: "0,4194304",
			bytes: 2 * 1024 * 1024,
		});
	} finally {
		await page.goto("about:blank");
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
