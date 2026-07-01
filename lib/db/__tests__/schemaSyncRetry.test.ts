// The shared transient-retry primitive for the two additive schema-sync sites
// (`materializeCaseStoreSchemas` + `applyBlueprintChange`'s sweep). Pure unit
// coverage — no container: the classification of transient vs deterministic
// and the retry/rethrow behavior are the contract both callers depend on.

import { describe, expect, it, vi } from "vitest";
import { isTransientDbError, withTransientRetry } from "../schemaSyncRetry";

describe("isTransientDbError", () => {
	it("recognizes a Node socket errno on `.code`", () => {
		expect(
			isTransientDbError(Object.assign(new Error("x"), { code: "ECONNRESET" })),
		).toBe(true);
	});

	it("recognizes a SQLSTATE class-08 connection code on `.code`", () => {
		expect(
			isTransientDbError(Object.assign(new Error("x"), { code: "08006" })),
		).toBe(true);
	});

	it("recognizes a transient fault wrapped one level deep on `.cause.code`", () => {
		// The Cloud SQL connector / pg driver can WRAP a transient blip so the
		// SQLSTATE / errno sits on `error.cause.code` rather than `error.code`.
		// `isTransientDbError` unwraps a single level so the retry still fires.
		const wrapped = Object.assign(new Error("wrapped connection failure"), {
			cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
		});
		expect(isTransientDbError(wrapped)).toBe(true);
	});

	it("does NOT recognize a plain Error with no code as transient (deterministic)", () => {
		expect(
			isTransientDbError(new Error("deterministic identifier collision")),
		).toBe(false);
	});

	it("does NOT recognize an unknown code as transient", () => {
		expect(
			isTransientDbError(Object.assign(new Error("x"), { code: "23505" })),
		).toBe(false);
	});
});

describe("withTransientRetry", () => {
	it("resolves on the first attempt when the call succeeds", async () => {
		const attempt = vi.fn().mockResolvedValue(undefined);
		await expect(withTransientRetry(attempt)).resolves.toBeUndefined();
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("retries a TRANSIENT fault and lands on the second attempt", async () => {
		const attempt = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("blip"), { code: "ECONNRESET" }),
			)
			.mockResolvedValueOnce(undefined);
		await expect(withTransientRetry(attempt)).resolves.toBeUndefined();
		expect(attempt).toHaveBeenCalledTimes(2);
	});

	it("retries a transient fault wrapped on `.cause.code` too", async () => {
		const attempt = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("wrapped"), {
					cause: Object.assign(new Error("socket hang up"), {
						code: "ETIMEDOUT",
					}),
				}),
			)
			.mockResolvedValueOnce(undefined);
		await expect(withTransientRetry(attempt)).resolves.toBeUndefined();
		expect(attempt).toHaveBeenCalledTimes(2);
	});

	it("rethrows a DETERMINISTIC fault on the FIRST attempt (no wasted backoff)", async () => {
		const deterministic = new Error("deterministic fault");
		const attempt = vi.fn().mockRejectedValue(deterministic);
		await expect(withTransientRetry(attempt)).rejects.toBe(deterministic);
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("gives up after the attempt budget on a sustained transient fault", async () => {
		const attempt = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("outage"), { code: "ECONNRESET" }),
			);
		await expect(withTransientRetry(attempt)).rejects.toThrow("outage");
		// PER_TYPE_SYNC_ATTEMPTS = 3.
		expect(attempt).toHaveBeenCalledTimes(3);
	});
});
