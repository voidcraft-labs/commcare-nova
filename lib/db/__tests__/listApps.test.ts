/**
 * `listApps` projection-and-filter regression tests.
 *
 * These tests pin a single contract that the existing per-helper
 * mocks couldn't catch: `listApps` must include `deleted_at` in its
 * Firestore `.select()` projection, AND it must drop rows where that
 * field is non-null at the projection step.
 *
 * The bug they protect against: an earlier draft listed only the
 * fields exposed on `AppSummary`, omitting `deleted_at`. Because
 * `select()` filters the document data on the wire, the in-memory
 * filter `data.deleted_at != null` then evaluated `undefined != null`
 * (false under loose equality) and silently passed every soft-
 * deleted row straight through into the active list — and into the
 * MCP `list_apps` / `search_apps` tools that compose on top of it.
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
		deleted_at: null,
	});

const baseDeletedDoc = (id: string) =>
	makeDoc(id, {
		app_name: `Deleted ${id}`,
		connect_type: null,
		module_count: 1,
		form_count: 1,
		/* `status` is intentionally `complete` — the new soft-delete
		 * path leaves lifecycle status alone, and the filter must work
		 * regardless of status (catching legacy `status: "deleted"`
		 * rows is a side effect of the same `deleted_at != null`
		 * check). */
		status: "complete",
		error_type: null,
		created_at: Timestamp.fromDate(new Date("2026-04-01T00:00:00Z")),
		updated_at: Timestamp.fromDate(new Date("2026-04-15T00:00:00Z")),
		deleted_at: "2026-04-20T00:00:00.000Z",
	});

describe("listApps", () => {
	beforeEach(() => {
		selectMock.mockClear();
		selectMock.mockReturnValue(queryMock);
		getMock.mockReset();
		(queryMock.where as ReturnType<typeof vi.fn>).mockClear();
		(queryMock.orderBy as ReturnType<typeof vi.fn>).mockClear();
		(queryMock.limit as ReturnType<typeof vi.fn>).mockClear();
	});

	it("includes deleted_at in the projection — without it, the in-memory filter silently leaks soft-deleted rows", async () => {
		/* Direct contract assertion: the `select()` call must include
		 * `deleted_at`. Loose equality on an `undefined` projected
		 * value is what produced the original leak. */
		getMock.mockResolvedValueOnce({ docs: [], size: 0 });

		const { listApps } = await import("../apps");
		await listApps("user-1", { limit: 50, sort: "updated_desc" });

		expect(selectMock).toHaveBeenCalledTimes(1);
		const projectedFields = selectMock.mock.calls[0];
		expect(projectedFields).toContain("deleted_at");
	});

	it("strips rows where deleted_at is non-null at the projection step", async () => {
		/* Behavioral assertion: a mixed page returns only the live
		 * row. Without the projection fix above the filter would never
		 * fire, so this test fails for the same regression — two
		 * checks of the same invariant from different angles. */
		getMock.mockResolvedValueOnce({
			docs: [baseLiveDoc("a"), baseDeletedDoc("b"), baseLiveDoc("c")],
			size: 3,
		});

		const { listApps } = await import("../apps");
		const { apps } = await listApps("user-1", {
			limit: 50,
			sort: "updated_desc",
		});

		expect(apps.map((a) => a.id)).toEqual(["a", "c"]);
	});
});
