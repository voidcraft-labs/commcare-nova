import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	compareFrozenStorageOccurrences,
	dispatchFrozenStorageOccurrences,
	type FrozenStorageSnapshot,
	frozenAuditAttachmentIsExact,
	frozenChatAttachmentIsExact,
	frozenCurrentNonMutationEventIsExact,
	frozenExactDigest,
	frozenThreadAttachmentInventory,
	parseFrozenExactJson,
} from "../20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher";
import {
	FROZEN_OCCURRENCE_TABLES,
	FROZEN_STORAGE_OCCURRENCES,
} from "../20260728000000_canonical_identity_foundation/frozenOccurrenceManifest";

const DISPATCHER_SOURCE = join(
	process.cwd(),
	"lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher.ts",
);

function snapshot(
	rows: Readonly<Record<string, readonly unknown[]>> = {},
	options: { readonly ddlExists?: boolean } = {},
): FrozenStorageSnapshot {
	return Object.fromEntries(
		FROZEN_OCCURRENCE_TABLES.map((table) => [
			table,
			{
				exists:
					table === "app_change_fold_baselines"
						? (options.ddlExists ?? true)
						: true,
				rows: rows[table] ?? [],
			},
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
		const before = snapshot(
			{
				app_changes: [oldMutation],
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
			},
			{ ddlExists: false },
		);
		const after = snapshot({
			app_changes: [
				oldMutation,
				{
					app_id: "app-1",
					seq: "2",
					kind: "fold-baseline",
					mutations: [],
					from_project_id: null,
					to_project_id: null,
				},
			],
			app_change_fold_baselines: [
				{
					app_id: "app-1",
					seq: "2",
					project_id: "project-1",
					snapshot: { appId: "app-1" },
					snapshot_digest: "digest",
					created_at: "2026-07-28T00:00:00.000Z",
				},
			],
			events: [
				{
					kind: "archived-mutation",
					event: {
						kind: "archived-mutation",
						runId: "run-1",
						ts: 0,
						seq: 1,
						source: "chat",
						archived: auditEvent,
					},
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

		expect(byId.get("app_changes.before-new-horizon")?.sourceDigest).toBe(
			byId.get("app_changes.before-new-horizon")?.resultDigest,
		);
		expect(byId.get("app_changes.new-horizon-and-suffix")?.sourceRows).toBe(0);
		expect(byId.get("app_changes.new-horizon-and-suffix")?.resultRows).toBe(1);
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

	it("blocks every current non-mutation event that misses the exact frozen schema", () => {
		const exactConversation = {
			kind: "conversation",
			event: {
				kind: "conversation",
				runId: "run-1",
				ts: 0,
				seq: 0,
				source: "chat",
				payload: {
					type: "user-message",
					text: "hello",
					attachments: [
						{
							assetId: "01988430-1234-7000-8000-000000000001",
							kind: "image",
							filename: "photo.jpg",
							mimeType: "image/jpeg",
						},
					],
				},
			},
		};
		const exact = dispatchFrozenStorageOccurrences(
			snapshot({ events: [exactConversation] }),
		).find((entry) => entry.id === "events.current-nonmutation");
		expect(exact?.rowCount).toBe(0);

		const invalid = dispatchFrozenStorageOccurrences(
			snapshot({
				events: [
					{
						...exactConversation,
						event: {
							...exactConversation.event,
							payload: {
								...exactConversation.event.payload,
								attachments: [
									{
										...exactConversation.event.payload.attachments[0],
										kind: "unknown",
									},
								],
							},
						},
					},
				],
			}),
		).find((entry) => entry.id === "events.current-nonmutation");
		expect(invalid?.rowCount).toBe(1);
		expect(() =>
			compareFrozenStorageOccurrences(
				snapshot({ events: [exactConversation] }),
				snapshot({
					events: [
						{
							...exactConversation,
							event: { ...exactConversation.event, extra: true },
						},
					],
				}),
			),
		).toThrow(/events\.current-nonmutation has block-current rows/);
	});

	it("blocks alternate standard-property bytes in live case rows and parked values", () => {
		const bad = snapshot({
			cases: [{ properties: { name: "Patient" } }],
			parked_case_values: [{ property: "date-opened" }],
		});
		const byId = new Map(
			dispatchFrozenStorageOccurrences(bad).map((entry) => [entry.id, entry]),
		);
		expect(byId.get("cases.standard-properties")?.rowCount).toBe(1);
		expect(byId.get("parked_case_values.standard-properties")?.rowCount).toBe(
			1,
		);
		expect(() => compareFrozenStorageOccurrences(bad, snapshot())).toThrow(
			/cases\.standard-properties has block-current rows/,
		);
	});

	it("preserves unsafe integers, decimal lexemes, and prototype-shaped keys exactly", () => {
		const first = parseFrozenExactJson(
			'{"__proto__":1,"constructor":2,"prototype":3,"huge":9007199254740993,"decimal":1.2300,"nested":{"z":1e+30,"a":null}}',
		) as Record<string, unknown>;
		const second = parseFrozenExactJson(
			'{"__proto__":1,"constructor":2,"prototype":3,"huge":9007199254740992,"decimal":1.2300,"nested":{"z":1e+30,"a":null}}',
		) as Record<string, unknown>;

		expect(Object.getPrototypeOf(first)).toBeNull();
		expect(Object.keys(first).sort()).toEqual(
			[
				"__proto__",
				"constructor",
				"decimal",
				"huge",
				"nested",
				"prototype",
			].sort(),
		);
		expect(frozenExactDigest(first)).not.toBe(frozenExactDigest(second));
		expect(frozenExactDigest(parseFrozenExactJson('{"value":null}'))).not.toBe(
			frozenExactDigest(parseFrozenExactJson("{}")),
		);
	});

	it("classifies exact numeric captures without JavaScript-number coercion", () => {
		const exactEvent = parseFrozenExactJson(
			'{"kind":"conversation","event":{"kind":"conversation","runId":"run-1","ts":1,"seq":2,"source":"chat","payload":{"type":"validation-attempt","attempt":3,"errors":[]}}}',
		);
		expect(frozenCurrentNonMutationEventIsExact(exactEvent)).toBe(true);

		const unsafeBoundary = snapshot({
			app_changes: [
				parseFrozenExactJson(
					'{"app_id":"app-1","seq":9007199254740992,"mutations":[{"kind":"setAppName","name":"before"}]}',
				),
				parseFrozenExactJson(
					'{"app_id":"app-1","seq":9007199254740993,"mutations":[]}',
				),
			],
			app_change_fold_baselines: [
				parseFrozenExactJson(
					'{"app_id":"app-1","seq":9007199254740993,"project_id":"project-1","snapshot":{},"snapshot_digest":"digest","created_at":"2026-07-28T00:00:00.000Z"}',
				),
			],
		});
		const byId = new Map(
			dispatchFrozenStorageOccurrences(unsafeBoundary).map((entry) => [
				entry.id,
				entry,
			]),
		);
		expect(byId.get("app_changes.before-new-horizon")?.rowCount).toBe(1);
		expect(byId.get("app_changes.new-horizon-and-suffix")?.rowCount).toBe(1);
	});

	it("partitions app-change rows once at the greatest immutable baseline", () => {
		const appChanges = [1, 2, 3, 4, 5].map((seq) =>
			seq < 4
				? {
						app_id: "app-1",
						seq: String(seq),
						mutations: [{ seq }],
					}
				: {
						app_id: "app-1",
						seq: String(seq),
						batch_id: `fixture:${seq}`,
						run_id: null,
						actor_id: "fixture-user",
						kind: seq === 4 ? "fold-baseline" : "autosave",
						mutations: seq === 4 ? [] : [{ seq }],
						from_project_id: null,
						to_project_id: null,
					},
		);
		const baselines = [
			{
				app_id: "app-1",
				seq: "4",
				project_id: "project-1",
				snapshot: { appId: "app-1", generation: 2 },
				snapshot_digest: "new-digest",
				created_at: "2026-07-29T00:00:00.000Z",
			},
			{
				app_id: "app-1",
				seq: "2",
				project_id: "project-1",
				snapshot: { appId: "app-1", generation: 1 },
				snapshot_digest: "old-digest",
				created_at: "2026-07-28T00:00:00.000Z",
			},
		];
		const projections = dispatchFrozenStorageOccurrences(
			snapshot({
				app_changes: appChanges,
				app_change_fold_baselines: baselines,
			}),
		);
		const byId = new Map(projections.map((entry) => [entry.id, entry]));
		const expectedBefore = dispatchFrozenStorageOccurrences(
			snapshot({
				app_changes: appChanges.slice(0, 3),
				app_change_fold_baselines: baselines,
			}),
		).find((entry) => entry.id === "app_changes.before-new-horizon");
		const expectedSuffix = dispatchFrozenStorageOccurrences(
			snapshot({
				app_changes: appChanges.slice(3),
				app_change_fold_baselines: baselines,
			}),
		).find((entry) => entry.id === "app_changes.new-horizon-and-suffix");
		const preHorizon = byId.get("app_changes.before-new-horizon");
		const horizonAndSuffix = byId.get("app_changes.new-horizon-and-suffix");

		expect(preHorizon).toMatchObject({
			rowCount: 3,
			digest: expectedBefore?.digest,
		});
		expect(horizonAndSuffix).toMatchObject({
			rowCount: 2,
			digest: expectedSuffix?.digest,
		});
		expect(
			(preHorizon?.rowCount ?? 0) + (horizonAndSuffix?.rowCount ?? 0),
		).toBe(appChanges.length);

		const baselineProjection = byId.get(
			"app_change_fold_baselines.snapshot-and-ddl",
		);
		const latestOnlyBaselineProjection = dispatchFrozenStorageOccurrences(
			snapshot({ app_change_fold_baselines: baselines.slice(0, 1) }),
		).find(
			(entry) => entry.id === "app_change_fold_baselines.snapshot-and-ddl",
		);
		expect(baselineProjection?.rowCount).toBe(2);
		expect(baselineProjection?.digest).not.toBe(
			latestOnlyBaselineProjection?.digest,
		);
	});

	it("uses one greatest-baseline SQL authority for exact raw payload capture", () => {
		const source = readFileSync(DISPATCHER_SOURCE, "utf8");

		expect(source.match(/SELECT app_id, MAX\(seq\) AS seq/g)).toHaveLength(1);
		expect(source.match(/WITH greatest_baseline AS/g)).toHaveLength(2);
		expect(source).toContain("change_row.seq < baseline.seq");
		expect(source).toContain("change_row.seq >= baseline.seq");
		expect(source).not.toMatch(
			/(?:LEFT )?JOIN public\.app_change_fold_baselines AS baseline/,
		);
	});

	it("freezes chat-only attachment kinds and carries the exact declared kind", () => {
		const base = {
			assetId: "10000000-0000-4000-8000-000000000001",
			filename: "file.bin",
			mimeType: "application/octet-stream",
		};
		for (const kind of ["image", "pdf", "text", "docx", "xlsx"]) {
			expect(frozenChatAttachmentIsExact({ ...base, kind })).toBe(true);
			expect(frozenAuditAttachmentIsExact({ ...base, kind })).toBe(true);
		}
		for (const kind of ["audio", "video"]) {
			expect(frozenChatAttachmentIsExact({ ...base, kind })).toBe(false);
			expect(frozenAuditAttachmentIsExact({ ...base, kind })).toBe(true);
		}
		expect(frozenAuditAttachmentIsExact({ ...base, kind: "unknown" })).toBe(
			false,
		);
		expect(
			frozenThreadAttachmentInventory([
				{ metadata: { attachments: [{ ...base, kind: "image" }] } },
			]).occurrences[0],
		).toMatchObject({
			assetId: base.assetId,
			kind: "image",
			exact: true,
		});
	});

	it("admits broad immutable audit receipts without widening thread attachments", () => {
		const attachment = {
			assetId: "10000000-0000-4000-8000-000000000001",
			kind: "audio",
			filename: "prompt.mp3",
			mimeType: "audio/mpeg",
		};
		expect(
			frozenCurrentNonMutationEventIsExact({
				kind: "conversation",
				event: {
					kind: "conversation",
					runId: "run-1",
					ts: 1,
					seq: 2,
					source: "chat",
					payload: {
						type: "user-message",
						text: "historical audit receipt",
						attachments: [attachment],
					},
				},
			}),
		).toBe(true);
		expect(
			frozenThreadAttachmentInventory([
				{ metadata: { attachments: [attachment] } },
			]).shapeExact,
		).toBe(false);
	});
});
