/**
 * Tests for the public `/api/log/error` relay.
 *
 * Aggregate request-rate flood control lives at the EDGE (Cloud Armor on the
 * load balancer), not in this route: see `scripts/infra/setup-cloud-armor-lb.sh`.
 * The route keeps the per-request body-size cap + schema validation; these
 * cover the happy path and a schema-invalid body. The logger is mocked so the
 * test never touches Cloud Logging.
 */

import { describe, expect, it, vi } from "vitest";
import { normalizeClientErrorPayload } from "@/lib/clientErrorContract";

const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ log: { error: logError } }));

import { POST } from "../route";

function req(body: unknown): Request {
	return new Request("https://host/api/log/error", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/log/error", () => {
	it("accepts the legacy client report shape without diagnostics (204)", async () => {
		const res = await POST(
			req({
				message: "boom",
				source: "manual",
				url: "https://app/x",
			}),
		);
		expect(res.status).toBe(204);
	});

	it("accepts a producer-normalized oversized parser failure", async () => {
		const report = normalizeClientErrorPayload({
			message: "Reconciler recovery snapshot rejected",
			stack: "z".repeat(22_000),
			source: "manual",
			url: "https://app/x",
			diagnostics: {
				component: "reconciler",
				operation: "reload-get",
				failureKind: "snapshot-schema",
				appId: "app-1",
				baseSeq: 13,
				eventId: "14",
				httpStatus: 200,
				recoveryTrigger: "malformed-mutation-frame",
				issues: ["invalid_type:/blueprint/fields/field-1/kind"],
			},
		});
		const res = await POST(req(report));

		expect(res.status).toBe(204);
		expect(logError).toHaveBeenLastCalledWith(
			"[client] Reconciler recovery snapshot rejected",
			expect.any(Error),
			expect.objectContaining({
				origin: "client",
				component: "reconciler",
				operation: "reload-get",
				failureKind: "snapshot-schema",
				appId: "app-1",
				baseSeq: 13,
				eventId: "14",
				httpStatus: 200,
				recoveryTrigger: "malformed-mutation-frame",
				truncation: expect.objectContaining({ stackBytes: 22_000 }),
			}),
			{ sentry: false },
		);
	});

	it("salvages and truncates an oversized legacy parser stack", async () => {
		const legacyStack = `ZodError: [${"diagnostic".repeat(2_000)}\n    at usefulCallsite (client.ts:42:3)`;
		const res = await POST(
			req({
				message: "legacy parser failure",
				stack: legacyStack,
				source: "manual",
				url: "https://app/x",
			}),
		);

		expect(res.status).toBe(204);
		const [, loggedError, context] = logError.mock.lastCall ?? [];
		expect(loggedError).toBeInstanceOf(Error);
		expect((loggedError as Error).stack).toContain(
			"at usefulCallsite (client.ts:42:3)",
		);
		expect(context).toEqual(
			expect.objectContaining({
				origin: "client",
				truncation: expect.objectContaining({
					stackBytes: new TextEncoder().encode(legacyStack).byteLength,
				}),
			}),
		);
	});

	it("rejects a schema-invalid body (400)", async () => {
		// Missing the required `source` + `url`.
		const res = await POST(req({ message: "boom" }));
		expect(res.status).toBe(400);
	});

	it("rejects unbounded diagnostics from a direct caller", async () => {
		const res = await POST(
			req({
				message: "boom",
				source: "manual",
				url: "https://app/x",
				diagnostics: { pointer: "x".repeat(513) },
			}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects an actually oversized multibyte body without a declared length", async () => {
		const res = await POST(
			req({
				message: "é".repeat(2_000),
				stack: "é".repeat(8_000),
				componentStack: "é".repeat(8_000),
				source: "manual",
				url: `https://app/x/${"é".repeat(1_900)}`,
				diagnostics: { clientBuildId: "build-1" },
			}),
		);
		expect(res.status).toBe(413);
	});
});
