/** Exact-holder failure writes: a stale build may never fail its replacement. */

import { describe, expect, it } from "vitest";
import { failApp } from "../apps";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("fail_app_owner_");
const HOLDER_NONCE = "00000000-0000-4000-8000-000000000001";
const REPLACEMENT_NONCE = "00000000-0000-4000-8000-000000000002";

describe("failApp", () => {
	it("fails the exact just-created build before its reservation exists", async () => {
		const appId = await h.seedApp({
			id: "pre-reservation-build",
			status: "generating",
			run_id: "build-1",
			run_holder_nonce: HOLDER_NONCE,
		});

		expect(await failApp(appId, "build-1", HOLDER_NONCE, "internal")).toBe(
			true,
		);
		expect(await h.readAppRow(appId)).toMatchObject({
			status: "error",
			error_type: "internal",
		});
	});

	it("fails its own settled build marker but not a replacement holder", async () => {
		const ownedApp = await h.seedApp({
			id: "settled-owned-build",
			status: "generating",
			run_id: "build-1",
			run_holder_nonce: HOLDER_NONCE,
			reservation: {
				period: "2026-07",
				reserved: 100,
				settled: true,
				userId: "owner-test",
				runId: "build-1",
			},
		});
		expect(await failApp(ownedApp, "build-1", HOLDER_NONCE, "api_server")).toBe(
			true,
		);

		const replacementApp = await h.seedApp({
			id: "replacement-build",
			status: "generating",
			run_id: "build-2",
			run_holder_nonce: REPLACEMENT_NONCE,
			reservation: {
				period: "2026-07",
				reserved: 100,
				settled: false,
				userId: "owner-test",
				runId: "build-2",
			},
		});
		expect(
			await failApp(replacementApp, "build-1", HOLDER_NONCE, "internal"),
		).toBe(false);
		expect(await h.readAppRow(replacementApp)).toMatchObject({
			status: "generating",
			error_type: null,
			res_run_id: "build-2",
		});
	});

	it("no-ops after a reaper clears the old marker identity", async () => {
		const appId = await h.seedApp({
			id: "reaped-build",
			// The build reaper retires the holder in the same write that clears the
			// marker run id. The nonce remains only as the last-generation tombstone.
			status: "error",
			error_type: "internal",
			run_id: "build-1",
			run_holder_nonce: HOLDER_NONCE,
			reservation: {
				period: "2026-07",
				reserved: 100,
				settled: true,
				userId: "owner-test",
			},
		});

		expect(await failApp(appId, "build-1", HOLDER_NONCE, "internal")).toBe(
			false,
		);
		expect(await h.readAppRow(appId)).toMatchObject({
			status: "error",
			error_type: "internal",
			res_run_id: null,
		});
	});
});
