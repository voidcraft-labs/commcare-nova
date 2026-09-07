// Cross-target generation admission against real Postgres.
import { describe, expect, it } from "vitest";
import { scanActorGenerationTargets } from "../actorGenerationGate";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("actor_gate_");

describe("scanActorGenerationTargets", () => {
	const ACTOR = "scan-actor";
	const NONCE = "00000000-0000-4000-8000-00000000aa01";

	it("counts a live design-session build against the actor and skips other actors'", async () => {
		const ownSessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			run_id: "run-live",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: "2026-08",
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-live",
			},
		});
		await h.seedDesignSession({
			owner_user_id: "someone-else",
			run_id: "run-other",
			run_holder_nonce: NONCE,
			run_actor_user_id: "someone-else",
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: "2026-08",
				reserved: 100,
				settled: false,
				userId: "someone-else",
				runId: "run-other",
			},
		});
		const scan = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR),
		);
		expect(scan.live).toBe(true);
		expect(scan.reapable).toEqual([]);
		const onlyForeignRemains = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR, { designSessionId: ownSessionId }),
		);
		expect(onlyForeignRemains).toEqual({ live: false, reapable: [] });
	});

	it("classifies a lapsed design-session lease as reapable, not live", async () => {
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			run_id: "run-stale",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() - 60_000),
			reservation: {
				period: "2026-08",
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-stale",
			},
		});
		const scan = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR),
		);
		expect(scan.live).toBe(false);
		expect(scan.reapable).toEqual([
			{
				kind: "design-session",
				designSessionId: sessionId,
				identity: { mode: "build", runId: "run-stale", nonce: NONCE },
			},
		]);
	});

	it("excludes the named session and still sees live APP builds (the union)", async () => {
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			run_id: "run-mine",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: "2026-08",
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-mine",
			},
		});
		const excluded = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR, { designSessionId: sessionId }),
		);
		expect(excluded.live).toBe(false);

		await h.seedApp({
			id: "app-live-build",
			owner: ACTOR,
			status: "generating",
			run_id: "run-app",
			run_holder_nonce: NONCE,
		});
		const withApp = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR, { designSessionId: sessionId }),
		);
		expect(withApp.live).toBe(true);
	});

	it("a paused design-session run does not read live (paused is not busy for admission)", async () => {
		await h.seedDesignSession({
			owner_user_id: ACTOR,
			awaiting_input: true,
			run_id: "run-paused",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: "2026-08",
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-paused",
			},
		});
		const scan = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR),
		);
		expect(scan.live).toBe(false);
		expect(scan.reapable).toEqual([]);
	});
});
