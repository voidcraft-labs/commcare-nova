/**
 * Transport pin for the one OpenAI provider constructor.
 *
 * Three facts hold or long model calls die on the transport:
 *
 * 1. `modelCallFetch` uses the npm Undici 8 fetch with the package Agent — the
 *    provider-level guarantee. The local-server probe fails if either side is
 *    replaced by Node's separately bundled dispatcher contract.
 * 2. The package fetch honors the Agent's timeout and succeeds on an ordinary
 *    response — the platform guarantee.
 * 3. No serving code constructs a provider around the factory — a bare
 *    `createOpenAI` gets default timeouts, which is exactly the observed
 *    failure, so the source scan keeps the constructor unique.
 */

import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Agent } from "undici";
import { describe, expect, it } from "vitest";
import {
	createModelCallFetch,
	MODEL_CALL_TIMEOUT_MS,
	modelCallDispatcher,
} from "@/lib/agent/openaiProvider";

describe("modelCallFetch", () => {
	it("owns an Undici 8 Agent with a reasoning-safe ceiling", () => {
		expect(modelCallDispatcher).toBeInstanceOf(Agent);
		// The ceiling exists to beat undici's 300s default; a value at or
		// below it would reintroduce the observed death.
		expect(MODEL_CALL_TIMEOUT_MS).toBeGreaterThan(300_000);
	});
});

describe("Undici 8 fetch + dispatcher", () => {
	it("honors a package-built Agent's headersTimeout passed via init.dispatcher", async () => {
		const pendingTimers: NodeJS.Timeout[] = [];
		const server: Server = createServer((_req, res) => {
			// Withhold headers well past the probe dispatcher's ceiling.
			pendingTimers.push(
				setTimeout(() => {
					res.end("late");
				}, 5_000),
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		const probe = new Agent({ headersTimeout: 300, bodyTimeout: 300 });
		const probeFetch = createModelCallFetch(probe);
		try {
			await expect(
				probeFetch(`http://127.0.0.1:${port}/`, {
					method: "GET",
				}),
			).rejects.toThrow();
		} finally {
			for (const timer of pendingTimers) clearTimeout(timer);
			await probe.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			);
		}
	});

	it("lets a fast response through the same dispatcher shape", async () => {
		const server: Server = createServer((_req, res) => {
			res.end("ok");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		const probe = new Agent({ headersTimeout: 10_000, bodyTimeout: 10_000 });
		const probeFetch = createModelCallFetch(probe);
		try {
			const res = await probeFetch(`http://127.0.0.1:${port}/`);
			expect(await res.text()).toBe("ok");
		} finally {
			await probe.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			);
		}
	});
});

describe("provider constructor uniqueness", () => {
	it("no serving code calls createOpenAI outside the factory", () => {
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "node_modules" || entry.name === "__tests__") {
						continue;
					}
					walk(path);
					continue;
				}
				if (!/\.tsx?$/.test(entry.name)) continue;
				if (path.endsWith(join("lib", "agent", "openaiProvider.ts"))) {
					continue;
				}
				if (/\bcreateOpenAI\s*\(/.test(readFileSync(path, "utf8"))) {
					offenders.push(path);
				}
			}
		};
		walk("lib");
		walk("app");
		walk("components");
		expect(offenders).toEqual([]);
	});
});
