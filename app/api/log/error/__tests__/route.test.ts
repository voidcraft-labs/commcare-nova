/**
 * Tests for the public `/api/log/error` relay.
 *
 * Aggregate request-rate flood control lives at the EDGE (Cloud Armor on the
 * load balancer), not in this route — see `scripts/infra/setup-cloud-armor-lb.sh`.
 * The route keeps the per-request body-size cap + schema validation; these
 * cover the happy path and a schema-invalid body. The logger is mocked so the
 * test never touches Cloud Logging.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ log: { error: vi.fn() } }));

import { POST } from "../route";

function req(body: unknown): Request {
	return new Request("https://host/api/log/error", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/log/error", () => {
	it("accepts a valid client error report (204)", async () => {
		const res = await POST(
			req({ message: "boom", source: "manual", url: "https://app/x" }),
		);
		expect(res.status).toBe(204);
	});

	it("rejects a schema-invalid body (400)", async () => {
		// Missing the required `source` + `url`.
		const res = await POST(req({ message: "boom" }));
		expect(res.status).toBe(400);
	});
});
