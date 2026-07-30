import { describe, expect, it } from "vitest";
import {
	compareFrozenStorageOccurrences,
	dispatchFrozenStorageOccurrences,
	type FrozenStorageSnapshot,
} from "../20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher";
import {
	FROZEN_OCCURRENCE_TABLES,
	FROZEN_STORAGE_OCCURRENCES,
} from "../20260728000000_canonical_identity_foundation/frozenOccurrenceManifest";

function snapshot(
	rows: Readonly<Record<string, readonly unknown[]>> = {},
): FrozenStorageSnapshot {
	return Object.fromEntries(
		FROZEN_OCCURRENCE_TABLES.map((table) => [
			table,
			{ exists: true, rows: rows[table] ?? [] },
		]),
	);
}

describe("frozen canonical-identity occurrence dispatcher", () => {
	it("dispatches every frozen storage occurrence exactly once", () => {
		const projections = dispatchFrozenStorageOccurrences(snapshot());

		expect(projections.map((entry) => entry.id)).toEqual(
			FROZEN_STORAGE_OCCURRENCES.map((entry) => entry.id),
		);
		expect(new Set(projections.map((entry) => entry.id))).toHaveLength(
			FROZEN_STORAGE_OCCURRENCES.length,
		);
	});

	it("proves archive, pre-horizon, new-horizon, and operational dispositions together", () => {
		const oldMutation = {
			app_id: "app-1",
			seq: "1",
			kind: "autosave",
			mutations: [{ legacy: "exact bytes" }],
		};
		const auditEvent = {
			runId: "run-1",
			ts: "2026-07-28T00:00:00.000Z",
			seq: 1,
			source: "server",
			kind: "mutation",
			payload: { exact: true },
		};
		const before = snapshot({
			accepted_mutations: [oldMutation],
			events: [{ kind: "mutation", event: auditEvent }],
			threads: [
				{
					active_stream_id: "stream-1",
					active_holder_nonce: "nonce-1",
					messages: [],
				},
			],
			chat_stream_chunks: [{ stream_id: "stream-1", terminal: false }],
			presence: [{ app_id: "app-1", user_id: "user-1" }],
		});
		const after = snapshot({
			accepted_mutations: [
				oldMutation,
				{
					app_id: "app-1",
					seq: "2",
					kind: "migration",
					mutations: [],
				},
			],
			mutation_fold_baselines: [
				{
					app_id: "app-1",
					seq: "2",
					snapshot: { appId: "app-1" },
					snapshot_digest: "digest",
					created_at: "2026-07-28T00:00:00.000Z",
				},
			],
			events: [
				{
					kind: "archived-mutation",
					event: { archived: auditEvent },
				},
			],
			threads: [
				{
					active_stream_id: null,
					active_holder_nonce: null,
					messages: [],
				},
			],
		});

		const plan = compareFrozenStorageOccurrences(before, after);
		const byId = new Map(plan.entries.map((entry) => [entry.id, entry]));

		expect(
			byId.get("accepted_mutations.before-new-horizon")?.sourceDigest,
		).toBe(byId.get("accepted_mutations.before-new-horizon")?.resultDigest);
		expect(
			byId.get("accepted_mutations.new-horizon-and-suffix")?.sourceRows,
		).toBe(0);
		expect(
			byId.get("accepted_mutations.new-horizon-and-suffix")?.resultRows,
		).toBe(1);
		expect(byId.get("events.mutation")?.sourceDigest).toBe(
			byId.get("events.mutation")?.resultDigest,
		);
		expect(byId.get("threads.active_stream")?.resultRows).toBe(0);
		expect(byId.get("chat_stream_chunks.all")?.resultRows).toBe(0);
		expect(byId.get("presence.all")?.resultRows).toBe(0);
	});

	it("rejects drift in exact carriers and surviving operational state", () => {
		expect(() =>
			compareFrozenStorageOccurrences(
				snapshot({
					lookup_tables: [{ project_id: "project-1", id: "table-1" }],
				}),
				snapshot({
					lookup_tables: [{ project_id: "project-1", id: "table-2" }],
				}),
			),
		).toThrow(/lookup_tables\.identity did not preserve exact content/);

		expect(() =>
			compareFrozenStorageOccurrences(
				snapshot(),
				snapshot({
					presence: [{ app_id: "app-1", user_id: "user-1" }],
				}),
			),
		).toThrow(/presence\.all was not deleted\/reset/);
	});
});
