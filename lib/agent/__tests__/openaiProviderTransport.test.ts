/**
 * Transport pin for the one OpenAI provider constructor.
 *
 * Three facts hold or long model calls die on the transport:
 *
 * 1. `modelCallFetch` places the long-timeout dispatcher on every request's
 *    init — the provider-level guarantee.
 * 2. THIS Node's fetch honors an `init.dispatcher` built from the npm
 *    `undici` package through its v1 compatibility wrapper — the platform
 *    guarantee. Node's fetch is its own bundled undici, so a missing adapter
 *    would reject the package Agent before a request; the local-server probe
 *    fails loudly instead.
 * 3. No serving code constructs a provider around the factory — a bare
 *    `createOpenAI` gets default timeouts, which is exactly the observed
 *    failure, so the source scan keeps the constructor unique.
 */

import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Agent, Dispatcher1Wrapper } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MODEL_CALL_TIMEOUT_MS,
	modelCallDispatcher,
	modelCallFetch,
} from "@/lib/agent/openaiProvider";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("modelCallFetch", () => {
	it("rides every request with the long-timeout dispatcher on init", async () => {
		let captured: RequestInit | undefined;
		vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
			captured = init;
			return new Response("ok");
		});
		const res = await modelCallFetch("https://api.example.test/v1/responses", {
			method: "POST",
		});
		await res.text();
		expect((captured as { dispatcher?: unknown } | undefined)?.dispatcher).toBe(
			modelCallDispatcher,
		);
		// The ceiling exists to beat undici's 300s default; a value at or
		// below it would reintroduce the observed death.
		expect(MODEL_CALL_TIMEOUT_MS).toBeGreaterThan(300_000);
	});
});

describe("node fetch + undici dispatcher", () => {
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
		const probe = new Dispatcher1Wrapper(
			new Agent({ headersTimeout: 300, bodyTimeout: 300 }),
		);
		try {
			await expect(
				globalThis.fetch(`http://127.0.0.1:${port}/`, {
					dispatcher: probe,
				} as RequestInit),
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
		const probe = new Dispatcher1Wrapper(
			new Agent({ headersTimeout: 10_000, bodyTimeout: 10_000 }),
		);
		try {
			const res = await globalThis.fetch(`http://127.0.0.1:${port}/`, {
				dispatcher: probe,
			} as RequestInit);
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
