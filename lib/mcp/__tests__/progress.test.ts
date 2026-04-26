/**
 * createProgressEmitter unit tests.
 *
 * Three behaviors that together prove the emitter is spec-compliant:
 *   - No-op path: when the client didn't pass a `progressToken`, no
 *     notification is ever dispatched — adapters can call `notify()`
 *     unconditionally.
 *   - Happy path: successive calls emit `notifications/progress` with a
 *     monotonically increasing `progress` counter starting at 1. The
 *     counter is a required spec field; compliant clients reject
 *     params missing it (see SDK `ProgressSchema.progress` — `z.number()`).
 *   - Numeric token: `progressToken` is typed `string | number` per the
 *     SDK; a numeric token should not short-circuit the emitter.
 *
 * The emitter packs the stage tag + any structured `extra` into the
 * MCP-spec-only `message` string (format: `"[<stage>] <text>[ | k=v...]"`)
 * so consumers can branch on stage without needing any non-standard
 * sidecar fields on the notification params.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { createProgressEmitter } from "../progress";

/**
 * Build a minimal `McpServer` stand-in — `createProgressEmitter` only
 * touches `server.server.notification`, so we cast a plain mock through
 * `unknown` to satisfy the type without instantiating the real SDK.
 */
function mockServer() {
	const notification = vi.fn().mockResolvedValue(undefined);
	const server = { server: { notification } } as unknown as McpServer;
	return { server, notification };
}

describe("createProgressEmitter", () => {
	it("no-ops when progressToken is undefined", () => {
		const { server, notification } = mockServer();
		const emitter = createProgressEmitter(server, undefined);
		emitter.notify("app_created", "ignored");
		expect(notification).not.toHaveBeenCalled();
	});

	it("emits with a monotonically increasing progress counter", () => {
		const { server, notification } = mockServer();
		const emitter = createProgressEmitter(server, "run-42");
		emitter.notify("app_created", "created");
		emitter.notify("schema_generated", "schema");
		emitter.notify("scaffold_generated", "scaffold");
		expect(notification).toHaveBeenCalledTimes(3);
		const calls = notification.mock.calls.map((c) => c[0]);
		expect(calls[0]).toEqual({
			method: "notifications/progress",
			params: {
				progressToken: "run-42",
				progress: 1,
				message: "[app_created] created",
			},
		});
		expect(calls[1]?.params.progress).toBe(2);
		expect(calls[1]?.params.message).toBe("[schema_generated] schema");
		expect(calls[2]?.params.progress).toBe(3);
		expect(calls[2]?.params.message).toBe("[scaffold_generated] scaffold");
	});

	it("accepts a numeric progressToken and appends structured extras inline", () => {
		const { server, notification } = mockServer();
		const emitter = createProgressEmitter(server, 7);
		emitter.notify("module_added", "mod", { app_id: "a1" });
		expect(notification).toHaveBeenCalledTimes(1);
		expect(notification.mock.calls[0]?.[0]).toEqual({
			method: "notifications/progress",
			params: {
				progressToken: 7,
				progress: 1,
				message: "[module_added] mod | app_id=a1",
			},
		});
	});
});
