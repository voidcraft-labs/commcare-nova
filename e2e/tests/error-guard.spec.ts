// Deliberate failures use the base fixture. These tests exercise Chromium and
// a real local HTTP receiver; Playwright routing cannot prove unload delivery.
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { expect, test } from "@playwright/test";
import { attachErrorGuard } from "../lib/errorGuard";

async function startReceiver() {
	const reports: string[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((request, response) => {
		if (request.url === "/api/log/error") {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => {
				body += chunk;
			});
			request.on("end", () => {
				reports.push(body);
				response.writeHead(204).end();
			});
			return;
		}
		response.writeHead(request.url === "/failure" ? 503 : 200, {
			"Content-Type": "text/html",
		});
		response.end("<!doctype html><title>Error guard</title><main>Ready</main>");
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No receiver port");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		reports,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

for (const departure of ["reload", "close"] as const) {
	for (const transport of ["beacon", "fetch"] as const) {
		test(`${transport} report from a departing document fails the guard after ${departure}`, async ({
			page,
		}) => {
			const receiver = await startReceiver();
			try {
				const guard = await attachErrorGuard(page, receiver.origin);
				await page.goto(receiver.origin);
				await guard.assertNoErrors();
				await page.evaluate((transport) => {
					// Native document teardown, with a report the server must receive.
					window.addEventListener("pagehide", () => {
						const body = JSON.stringify({
							message: "Departing read failed",
							source: "manual",
						});
						if (transport === "beacon") {
							navigator.sendBeacon(
								"/api/log/error",
								new Blob([body], { type: "application/json" }),
							);
						} else {
							void fetch("/api/log/error", {
								method: "POST",
								body,
								keepalive: true,
							});
						}
					});
				}, transport);
				if (departure === "reload") await page.reload();
				else await page.close();
				await expect
					.poll(() => receiver.reports)
					.toEqual([
						JSON.stringify({
							message: "Departing read failed",
							source: "manual",
						}),
					]);
				await expect(guard.assertNoErrors()).rejects.toThrow(/client report/);
				// A second page in the same origin/context must not inherit the
				// first page's evidence, even though localStorage is shared.
				const sibling = await page.context().newPage();
				const siblingGuard = await attachErrorGuard(sibling, receiver.origin);
				await sibling.goto(receiver.origin);
				await sibling.close();
				await siblingGuard.assertNoErrors();
			} finally {
				await page.close();
				await receiver.close();
			}
		});
	}
}

test("live exceptions, console errors, reports, and same-origin 5xx fail independently", async ({
	page,
}) => {
	const receiver = await startReceiver();
	const foreign = await startReceiver();
	try {
		const guard = await attachErrorGuard(page, receiver.origin);
		await page.goto(receiver.origin);
		// A third-party response is outside the same-origin HTTP contract.
		await page.goto(`${foreign.origin}/failure`);
		await guard.assertNoErrors();
		await page.goto(receiver.origin);
		await page.evaluate(() => {
			console.error("App console failure");
			setTimeout(() => {
				throw new Error("Native uncaught failure");
			}, 0);
			navigator.sendBeacon("/api/log/error", "Handled operation failed");
		});
		await expect
			.poll(() => receiver.reports)
			.toEqual(["Handled operation failed"]);
		await page.goto(`${receiver.origin}/failure`);
		await expect
			.poll(() => guard.errors)
			.toEqual(
				expect.arrayContaining([
					"console.error: App console failure",
					"pageerror: Native uncaught failure",
					"client report: Handled operation failed",
					"HTTP 503 /failure",
				]),
			);
		await page.close();
		await expect(guard.assertNoErrors()).rejects.toThrow(
			/Unexpected browser errors/,
		);
	} finally {
		await page.close();
		await receiver.close();
		await foreign.close();
	}
});
