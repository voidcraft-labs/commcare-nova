/**
 * `listDeletedApps` projection regression tests.
 *
 * The contract these tests pin: the trash query must PROJECT
 * `deleted_at` alongside `recoverable_until`. Firestore's `.select()`
 * returns ONLY the named fields — a `where`/`orderBy` on `deleted_at`
 * does not widen the projection — so dropping `deleted_at` from the
 * field list leaves `data.deleted_at` undefined, and the trash card's
 * `new Date(undefined)` renders "Deleted Invalid Date".
 *
 * The mock reproduces `.select()` semantics faithfully: `get()`
 * returns each doc filtered to exactly the projected fields (dotted
 * paths like `blueprint.logo` included). So the behavioral test fails
 * on the real projection bug rather than passing off a mock artifact
 * that hands back the full document regardless.
 *
 * Mirror image of the `listApps` projection test, which pins the
 * opposite: the active list must NOT carry `deleted_at` (it filters
 * via the where clause). Same field list, two surfaces, two contracts.
 */

import { Timestamp } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectMock, getMock, queryMock, getDbMock, state } = vi.hoisted(() => {
	/* What the mock query remembers between the chained `.select()` and
	 * the terminal `.get()`: the projected field list and the raw docs
	 * the test armed. `get` applies the projection to the raw docs so
	 * the fixture reads like a real Firestore round-trip. */
	const state: {
		fields: readonly string[];
		rawDocs: Array<{ id: string; data: Record<string, unknown> }>;
	} = { fields: [], rawDocs: [] };

	/* Reproduce `.select(...fields)`: keep only the named fields, honoring
	 * dotted paths (`blueprint.logo` → `{ blueprint: { logo } }`), exactly
	 * as Firestore projects a nested leaf. */
	const project = (
		data: Record<string, unknown>,
		fields: readonly string[],
	): Record<string, unknown> => {
		const out: Record<string, unknown> = {};
		for (const field of fields) {
			const segments = field.split(".");
			let src: unknown = data;
			for (const seg of segments) {
				src =
					src && typeof src === "object"
						? (src as Record<string, unknown>)[seg]
						: undefined;
			}
			if (src === undefined) continue;
			let cursor = out;
			for (let i = 0; i < segments.length - 1; i++) {
				const seg = segments[i] as string;
				cursor[seg] = (cursor[seg] as Record<string, unknown>) ?? {};
				cursor = cursor[seg] as Record<string, unknown>;
			}
			cursor[segments[segments.length - 1] as string] = src;
		}
		return out;
	};

	/* Fluent chain — every stage but `get` returns the same object so the
	 * call site can stack `.where().orderBy().select().limit()`. */
	const select = vi.fn();
	const get = vi.fn();
	const query: Record<string, unknown> = {};
	query.where = vi.fn().mockReturnValue(query);
	query.orderBy = vi.fn().mockReturnValue(query);
	query.limit = vi.fn().mockReturnValue(query);
	query.select = select.mockImplementation((...fields: string[]) => {
		state.fields = fields;
		return query;
	});
	query.get = get.mockImplementation(async () => ({
		docs: state.rawDocs.map((doc) => ({
			id: doc.id,
			data: () => project(doc.data, state.fields),
		})),
	}));
	const db = { collection: vi.fn().mockReturnValue(query) };
	return {
		selectMock: select,
		getMock: get,
		queryMock: query,
		getDbMock: vi.fn().mockReturnValue(db),
		state,
	};
});

vi.mock("../firestore", () => ({
	getDb: getDbMock,
	docs: { app: vi.fn() },
	collections: { apps: vi.fn() },
}));

/* Well past any recovery window so the row survives the in-memory
 * `recoverable_until <= now` filter and reaches the projection loop. */
const RECOVERABLE_UNTIL = new Date("2099-01-01T00:00:00Z").toISOString();
const DELETED_AT = "2026-07-01T12:00:00.000Z";

function deletedRow(id: string): {
	id: string;
	data: Record<string, unknown>;
} {
	return {
		id,
		data: {
			app_name: `App ${id}`,
			connect_type: null,
			module_count: 2,
			form_count: 3,
			status: "complete",
			awaiting_input: false,
			reservation: null,
			run_lock: null,
			error_type: null,
			blueprint: { logo: null },
			created_at: Timestamp.fromDate(new Date("2026-06-01T00:00:00Z")),
			updated_at: Timestamp.fromDate(new Date("2026-06-02T00:00:00Z")),
			deleted_at: DELETED_AT,
			recoverable_until: RECOVERABLE_UNTIL,
		},
	};
}

describe("listDeletedApps", () => {
	beforeEach(() => {
		/* `mockClear()` — not `mockReset()` — on select/get so their
		 * projection-recording / doc-projecting implementations survive. */
		selectMock.mockClear();
		getMock.mockClear();
		(queryMock.where as ReturnType<typeof vi.fn>).mockClear();
		(queryMock.orderBy as ReturnType<typeof vi.fn>).mockClear();
		(queryMock.limit as ReturnType<typeof vi.fn>).mockClear();
		state.fields = [];
		state.rawDocs = [];
	});

	it("projects both soft-delete timestamps — deleted_at AND recoverable_until", async () => {
		/* The core invariant. `deleted_at` lives in neither `SUMMARY_FIELDS`
		 * nor the base projection; the trash query must add it explicitly,
		 * or the "Deleted X ago" line has no timestamp to format. */
		state.rawDocs = [deletedRow("a")];

		const { listDeletedApps } = await import("../apps");
		await listDeletedApps("proj-1", { limit: 50 });

		expect(selectMock).toHaveBeenCalledTimes(1);
		const projectedFields = selectMock.mock.calls[0];
		expect(projectedFields).toContain("deleted_at");
		expect(projectedFields).toContain("recoverable_until");
	});

	it("returns deleted_at as the stored ISO string — the 'Deleted Invalid Date' regression", async () => {
		/* Behavioral proof through the faithful projection mock: an
		 * unprojected `deleted_at` comes back `undefined`, and the trash
		 * card's `new Date(undefined)` is an Invalid Date. Pin that the
		 * value survives the round-trip as a parseable ISO string. */
		state.rawDocs = [deletedRow("a")];

		const { listDeletedApps } = await import("../apps");
		const { apps } = await listDeletedApps("proj-1", { limit: 50 });

		expect(apps).toHaveLength(1);
		expect(apps[0]?.deleted_at).toBe(DELETED_AT);
		expect(Number.isNaN(new Date(apps[0]?.deleted_at ?? "").getTime())).toBe(
			false,
		);
	});

	it("filters rows whose recovery window has already elapsed", async () => {
		/* The trash is a recovery surface, not a permanent archive: a row
		 * past `recoverable_until` is dropped before it reaches the UI. */
		const elapsed = deletedRow("past");
		elapsed.data.recoverable_until = new Date(
			"2000-01-01T00:00:00Z",
		).toISOString();
		state.rawDocs = [elapsed, deletedRow("live")];

		const { listDeletedApps } = await import("../apps");
		const { apps } = await listDeletedApps("proj-1", { limit: 50 });

		expect(apps.map((a) => a.id)).toEqual(["live"]);
	});
});
