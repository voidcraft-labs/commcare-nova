// @vitest-environment happy-dom

import * as Sentry from "@sentry/nextjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLIENT_ERROR_LIMITS,
	clientErrorUtf8Bytes,
	normalizeClientErrorPayload,
} from "@/lib/clientErrorContract";
import { reportClientError } from "@/lib/clientErrorReporter";

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("client error reporting", () => {
	it("preserves the original Error and adds bounded structured Sentry context", () => {
		const sendBeacon = vi.fn(() => true);
		vi.stubGlobal("navigator", { sendBeacon });
		const original = new Error("native failure");

		reportClientError(
			{
				message: "reporter-original-error",
				stack: "diagnostic stack must not replace the original",
				source: "manual",
				url: "https://app.example/build/app-1",
				diagnostics: {
					component: "reconciler",
					operation: "reload-get",
					failureKind: "network",
					appId: "app-1",
					baseSeq: 13,
				},
			},
			original,
		);

		expect(Sentry.captureException).toHaveBeenCalledWith(
			original,
			expect.objectContaining({
				tags: expect.objectContaining({
					component: "reconciler",
					operation: "reload-get",
					failureKind: "network",
					appId: "app-1",
				}),
				contexts: {
					client_error: expect.objectContaining({
						clientBuildId: "local",
						baseSeq: 13,
					}),
				},
			}),
		);
		expect(original.stack).toContain("native failure");
		expect(sendBeacon).toHaveBeenCalledOnce();
	});

	it("keeps a protocol cause while applying its stable event fingerprint", () => {
		vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
		const cause = new Error("parser cause");

		reportClientError(
			{
				message: "reporter-synthetic-protocol-event",
				source: "manual",
				url: "https://app.example/build/app-2",
				diagnostics: {
					component: "reconciler",
					operation: "mutation-frame",
					failureKind: "mutation-admission",
					appId: "app-2",
				},
			},
			cause,
		);

		expect(Sentry.captureException).toHaveBeenCalledWith(
			cause,
			expect.objectContaining({
				fingerprint: ["reconciler", "mutation-frame", "mutation-admission"],
			}),
		);
	});

	it("preserves a supplied stack when a manual report has no thrown cause", () => {
		vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
		const suppliedStack =
			"Error: current-frame reset failed\n    at resetCurrentFrame (runtime.ts:42:3)";

		reportClientError({
			message: "reporter-stack-only-manual-event",
			stack: suppliedStack,
			source: "manual",
			url: "https://app.example/build/app-stack",
		});

		const captured = vi.mocked(Sentry.captureException).mock.lastCall?.[0];
		expect(captured).toBeInstanceOf(Error);
		expect((captured as Error).stack).toBe(suppliedStack);
	});

	it("falls back to keepalive fetch when sendBeacon declines the report", () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
		vi.stubGlobal("fetch", fetchMock);

		reportClientError({
			message: "reporter-beacon-fallback",
			source: "manual",
			url: "https://app.example/build/app-3",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/log/error",
			expect.objectContaining({ method: "POST", keepalive: true }),
		);
	});

	it("deduplicates varying details by stable category and app", () => {
		const sendBeacon = vi.fn(() => true);
		vi.stubGlobal("navigator", { sendBeacon });
		const common = {
			message: "reporter-stable-dedup",
			source: "manual" as const,
			url: "https://app.example/build/app-4",
		};

		expect(
			reportClientError({
				...common,
				diagnostics: {
					component: "reconciler",
					operation: "reload-get",
					failureKind: "http",
					appId: "app-4",
					httpStatus: 502,
				},
			}),
		).toBe(true);
		expect(
			reportClientError({
				...common,
				diagnostics: {
					component: "reconciler",
					operation: "reload-get",
					failureKind: "http",
					appId: "app-4",
					httpStatus: 503,
				},
			}),
		).toBe(false);
		expect(sendBeacon).toHaveBeenCalledOnce();
	});

	it("normalizes oversized fields to the public relay contract", () => {
		const huge = "é".repeat(20_000);
		const normalized = normalizeClientErrorPayload({
			message: huge,
			stack: huge,
			componentStack: huge,
			source: "manual",
			url: `https://app.example/${huge}`,
			diagnostics: {
				pointer: huge,
				issues: Array.from({ length: 8 }, (_, index) => `${index}:${huge}`),
			},
		});

		expect(clientErrorUtf8Bytes(normalized.message)).toBe(
			CLIENT_ERROR_LIMITS.message,
		);
		expect(clientErrorUtf8Bytes(normalized.stack ?? "")).toBe(
			CLIENT_ERROR_LIMITS.stack,
		);
		expect(clientErrorUtf8Bytes(normalized.componentStack ?? "")).toBe(
			CLIENT_ERROR_LIMITS.stack,
		);
		expect(clientErrorUtf8Bytes(normalized.url)).toBe(CLIENT_ERROR_LIMITS.url);
		expect(clientErrorUtf8Bytes(normalized.diagnostics.pointer ?? "")).toBe(
			CLIENT_ERROR_LIMITS.diagnosticString,
		);
		expect(normalized.diagnostics.issues).toHaveLength(
			CLIENT_ERROR_LIMITS.issues,
		);
		expect(normalized.diagnostics.truncation).toMatchObject({
			messageBytes: 40_000,
			stackBytes: 40_000,
			componentStackBytes: 40_000,
			diagnosticFields: expect.arrayContaining(["issues", "pointer"]),
		});
		expect(
			clientErrorUtf8Bytes(JSON.stringify(normalized)),
		).toBeLessThanOrEqual(32 * 1024);
	});

	it("keeps real frames when a parser message consumes the stack budget", () => {
		const normalized = normalizeClientErrorPayload({
			message: "parser failed",
			stack: `ZodError: ${"diagnostic".repeat(2_000)}\n    at usefulCallsite (client.ts:42:3)\n    at caller (app.ts:7:1)`,
			source: "manual",
			url: "https://app.example/build/app-5",
		});

		expect(normalized.stack).toContain("[stack message truncated]");
		expect(normalized.stack).toContain("at usefulCallsite (client.ts:42:3)");
		expect(normalized.diagnostics.truncation?.stackBytes).toBeGreaterThan(
			CLIENT_ERROR_LIMITS.stack,
		);
	});
});
