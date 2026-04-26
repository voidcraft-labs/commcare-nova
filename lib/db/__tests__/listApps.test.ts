/**
 * `listApps` query-shape regression tests.
 *
 * The contract these tests pin: soft-deleted rows must be filtered at
 * the Firestore query layer via `where("deleted_at", "==", null)`, not
 * stripped in JS after `.limit(N)`. JS-stripping lets a deleted-heavy
 * page return short with `next_cursor` still set — the regression to
 * keep out.
 *
 * The Firestore module is mocked at the file boundary. The chain is
 * a single object that returns itself from every chained call, so the
 * test can inspect every call argument without juggling
 * separately-spied stages.
 */

import { Timestamp } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectMock, getMock, queryMock, getDbMock } = vi.hoisted(() => {
	/* The mock query is a fluent chain — every method but `get` returns
	 * the same object so the call site can stack `.where().select().
	 * orderBy().limit()` etc. without per-stage wiring. The shape only
	 * needs the methods `listApps` actually invokes. */
	const select = vi.fn();
	const get = vi.fn();
	const query: Record<string, unknown> = {};
	query.where = vi.fn().mockReturnValue(query);
	query.orderBy = vi.fn().mockReturnValue(query);
	query.limit = vi.fn().mockReturnValue(query);
	query.startAfter = vi.fn().mockReturnValue(query);
	query.select = select.mockReturnValue(query);
	query.get = get;
	const db = { collection: vi.fn().mockReturnValue(query) };
	return {
		selectMock: select,
		getMock: get,
		queryMock: query,
		getDbMock: vi.fn().mockReturnValue(db),
	};
});

vi.mock("../firestore", () => ({
	getDb: getDbMock,
	docs: { app: vi.fn() },
	collections: { apps: vi.fn() },
}));

/* `Timestamp.fromDate` is real — the helper imports `Timestamp` for
 * the `select()` projection coercion, so the test fixtures use the
 * same constructor. */
function makeDoc(
	id: string,
	data: Record<string, unknown>,
): { id: string; data: () => Record<string, unknown> } {
	return { id, data: () => data };
}

const baseLiveDoc = (id: string) =>
	makeDoc(id, {
		app_name: `App ${id}`,
		connect_type: null,
		module_count: 1,
		form_count: 1,
		status: "complete",
		error_type: null,
		created_at: Timestamp.fromDate(new Date("2026-04-01T00:00:00Z")),
		updated_at: Timestamp.fromDate(new Date("2026-04-15T00:00:00Z")),
	});

describe("listApps", () => {
	beforeEach(() => {
		/* `mockClear()` resets call history but preserves return values
		 * — that's what we want for the fluent-chain mocks. `getMock`
		 * uses `mockReset()` instead because each test arms a different
		 * `mockResolvedValueOnce` and stale resolutions would leak. */
		selectMock.mockClear();
		getMock.mockReset();
		(queryMock.where as ReturnType<typeof vi.fn>).mockClear();
		(queryMock.orderBy as ReturnType<typeof vi.fn>).mockClear();
		(queryMock.limit as ReturnType<typeof vi.fn>).mockClear();
		(queryMock.startAfter as ReturnType<typeof vi.fn>).mockClear();
	});

	it("filters soft-deleted rows server-side via where('deleted_at', '==', null)", async () => {
		/* The core invariant: every active-list query must bind the
		 * soft-delete filter at the Firestore boundary so deleted rows
		 * never enter the page budget. Without it, `.limit(N)` runs
		 * before the strip and a deleted-heavy page returns short. */
		getMock.mockResolvedValueOnce({ docs: [], size: 0 });

		const { listApps } = await import("../apps");
		await listApps("user-1", { limit: 50, sort: "updated_desc" });

		const whereCalls = (queryMock.where as ReturnType<typeof vi.fn>).mock.calls;
		expect(whereCalls).toContainEqual(["deleted_at", "==", null]);
	});

	it("does not include deleted_at in the field projection — the query filter handles it, the projection no longer needs it", async () => {
		/* Defense against drift: once the where-clause filter exists,
		 * carrying `deleted_at` through the projection is purely cost
		 * with no benefit. Catching the regression here keeps the
		 * SUMMARY_FIELDS list lean. */
		getMock.mockResolvedValueOnce({ docs: [], size: 0 });

		const { listApps } = await import("../apps");
		await listApps("user-1", { limit: 50, sort: "updated_desc" });

		expect(selectMock).toHaveBeenCalledTimes(1);
		const projectedFields = selectMock.mock.calls[0];
		expect(projectedFields).not.toContain("deleted_at");
	});

	it("returns every doc Firestore returns 1:1 — soft-delete strip lives in the query, not the projection loop", async () => {
		/* Behavioral assertion: with the where-clause filter, Firestore
		 * already excludes soft-deleted rows. The JS loop must therefore
		 * be a straight pass-through, not a filter step (which would
		 * silently double-strip and could mask bugs). */
		getMock.mockResolvedValueOnce({
			docs: [baseLiveDoc("a"), baseLiveDoc("b"), baseLiveDoc("c")],
			size: 3,
		});

		const { listApps } = await import("../apps");
		const { apps } = await listApps("user-1", {
			limit: 50,
			sort: "updated_desc",
		});

		expect(apps.map((a) => a.id)).toEqual(["a", "b", "c"]);
	});

	it("emits next_cursor when Firestore returns exactly `limit` rows — every returned row is visible, so the signal is accurate", async () => {
		/* Server-side filtering means `apps.length === snap.size`, so
		 * the "maybe more" signal is exact: a present cursor genuinely
		 * means more visible apps may exist. */
		getMock.mockResolvedValueOnce({
			docs: [baseLiveDoc("a"), baseLiveDoc("b")],
			size: 2,
		});

		const { listApps } = await import("../apps");
		const result = await listApps("user-1", {
			limit: 2,
			sort: "updated_desc",
		});

		expect(result.apps).toHaveLength(2);
		expect(result.nextCursor).toBeDefined();
	});

	it("omits next_cursor when Firestore returns fewer than `limit` rows — there is nothing more to scan", async () => {
		getMock.mockResolvedValueOnce({
			docs: [baseLiveDoc("a")],
			size: 1,
		});

		const { listApps } = await import("../apps");
		const result = await listApps("user-1", {
			limit: 10,
			sort: "updated_desc",
		});

		expect(result.apps).toHaveLength(1);
		expect(result.nextCursor).toBeUndefined();
	});

	it("binds the status filter as a Firestore where clause — pinning the (owner, deleted_at, status, sort) index path", async () => {
		/* The status filter is the second equality clause and must
		 * actually reach Firestore — a regression that pushed it into
		 * an in-memory step would silently break the index plan and
		 * pay full-collection scan cost. */
		getMock.mockResolvedValueOnce({ docs: [], size: 0 });

		const { listApps } = await import("../apps");
		await listApps("user-1", {
			limit: 50,
			sort: "updated_desc",
			status: "complete",
		});

		const whereCalls = (queryMock.where as ReturnType<typeof vi.fn>).mock.calls;
		expect(whereCalls).toContainEqual(["status", "==", "complete"]);
	});

	it("rejects a cursor minted under a different sort — silent resumption from the wrong index position would mis-order the page", async () => {
		/* `decodeAppsCursor` validates the discriminant against the
		 * caller's `sort`. Mixing sort orders across pagination calls
		 * is unrecoverable: the underlying Firestore scan position
		 * doesn't translate. The throw is the user-visible signal that
		 * tells the caller to drop the cursor and restart.
		 *
		 * Mint the cursor by running a real call — keeps the test
		 * honest about the encoding format rather than hand-rolling a
		 * base64url payload that could drift from `encodeAppsCursor`. */
		const { listApps } = await import("../apps");

		getMock.mockResolvedValueOnce({
			docs: [baseLiveDoc("a")],
			size: 1,
		});
		const seed = await listApps("user-1", {
			limit: 1,
			sort: "updated_desc",
		});
		expect(seed.nextCursor).toBeDefined();

		await expect(
			listApps("user-1", {
				limit: 1,
				sort: "name_asc",
				cursor: seed.nextCursor,
			}),
		).rejects.toThrow(/Cursor was minted/);
	});
});
