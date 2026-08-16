/**
 * Shared fake `McpServer` factory for MCP tool tests.
 *
 * Every MCP tool test needs to capture the callback the tool registers
 * so the test can drive the handler directly without spinning up a real
 * MCP server + transport. This helper encapsulates that pattern so each
 * test file drops one `makeFakeServer()` call and reads the captured
 * handler back via `capture()`.
 *
 * The fake stubs one SDK surface: `registerTool(name, config, cb)` —
 * the registration entry point every tool module calls. Both callback
 * and config are captured so schema-boundary tests can prove the exact
 * registered contract.
 *
 * Progress is request-scoped: a tool reaches the notification sender
 * through its call context (`ctx.mcpReq.notify`), not through any
 * server-level sink. Tests that thread progress build that context via
 * `callExtra(progressToken?)`, which returns a ready-made handler
 * `extra` carrying `notificationSpy` as the sender; the spy resolves so
 * the emitter's fire-and-forget `.catch(() => {})` has a promise to
 * settle.
 *
 * The handler captured is intentionally loosely typed: every MCP tool
 * handler takes `(args, extra)` (or just `(extra)` for zero-arg tools),
 * and tests mix both shapes. Forcing a narrow type here would either
 * require a type-switch at every test site or mask genuine signature
 * drift. `Record<string, unknown>` + `unknown` mirror the SDK's own
 * open-shape stance on the handler boundary.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { vi } from "vitest";

/**
 * Loose handler type the fake server captures. Covers both the
 * `(args, extra)` shape for schema-bearing tools and the `(extra)`
 * shape for zero-arg tools via the optional positional `extra`
 * parameter. Tests cast the captured handler when they need to invoke
 * it with specific args, but the fake itself stays agnostic.
 */
export type CapturedToolHandler = (
	argsOrExtra: Record<string, unknown>,
	extra?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Return shape of `makeFakeServer`. Consumers destructure `server` into
 * the tool's registration call and pull `capture()` to retrieve the
 * handler for direct invocation. `callExtra()` builds the handler
 * `extra` for tests that thread progress; `notificationSpy` is the
 * sender it carries, exposed so those tests can assert on dispatches.
 */
export interface FakeServer {
	server: McpServer;
	capture(): CapturedToolHandler;
	registeredConfig(): unknown;
	callExtra(progressToken?: string | number): Record<string, unknown>;
	notificationSpy: ReturnType<typeof vi.fn>;
}

/**
 * Build a minimal `McpServer` stand-in that captures the handler the
 * tool registers. Asserts `capture()` is called only after registration
 * by throwing when nothing has been captured yet — prevents a subtle
 * class of test bugs where a refactored tool silently stops registering
 * a handler.
 */
export function makeFakeServer(): FakeServer {
	let captured: CapturedToolHandler | null = null;
	let config: unknown;
	const notificationSpy = vi.fn().mockResolvedValue(undefined);
	const register = (
		_name: string,
		_configOrSchema: unknown,
		cb: CapturedToolHandler,
	): void => {
		config = _configOrSchema;
		captured = cb;
	};
	const server = {
		/* Primary registration entry point every tool module calls. */
		registerTool: register,
	} as unknown as McpServer;
	return {
		server,
		capture: () => {
			if (!captured) throw new Error("handler not captured");
			return captured;
		},
		registeredConfig: () => {
			if (config === undefined) throw new Error("config not captured");
			return config;
		},
		callExtra: (progressToken) => ({
			mcpReq: {
				...(progressToken !== undefined && { _meta: { progressToken } }),
				notify: notificationSpy,
			},
		}),
		notificationSpy,
	};
}
