/**
 * `GET /api/media/library` — query acceptance tests for both modes.
 *
 * List mode: the library backs both the carrier pickers (media kinds) and the
 * chat file manager (document kinds), so the repeated `kind` query param must
 * accept any `AssetKind` — including `pdf`/`text`/`docx`/`xlsx` — and collect
 * SEVERAL into a kind set (`?kind=image&kind=pdf`) for a picker's "All" view.
 * This pins that the kinds reach the Project-scoped query as a set, that no
 * `kind` param means "every kind" (an empty set, never an `in []`), and that a
 * kind outside the accepted set is rejected as a 400 client error rather than
 * collapsing to a 500.
 *
 * Resolve mode: repeated `?id=` routes to the Project-filtered id lookup
 * (backing the browser attach budget check) and never touches the lister.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	listReadyAssetsForProject,
	loadAssetsByIds,
} from "@/lib/db/mediaAssets";
import { GET } from "../route";

const {
	requireSessionMock,
	resolveActiveProjectIdMock,
	resolveAppAccessMock,
	listReadyAssetsForProjectMock,
	loadAssetsByIdsMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	resolveActiveProjectIdMock: vi.fn(),
	resolveAppAccessMock: vi.fn(),
	listReadyAssetsForProjectMock: vi.fn(),
	loadAssetsByIdsMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
	resolveActiveProjectId: resolveActiveProjectIdMock,
}));
vi.mock("@/lib/db/appAccess", () => ({
	resolveAppAccess: resolveAppAccessMock,
}));
vi.mock("@/lib/db/mediaAssets", () => ({
	listReadyAssetsForProject: listReadyAssetsForProjectMock,
	loadAssetsByIds: loadAssetsByIdsMock,
	// The route catches this specific class and maps it to a 400; a plain
	// stand-in is enough for the happy/invalid paths exercised here.
	MalformedCursorError: class extends Error {},
	toWireMediaAsset: vi.fn((asset: unknown) => asset),
}));

/** A NextRequest stand-in carrying just the `url` the route reads. */
function reqWith(query: string) {
	return {
		url: `http://localhost/api/media/library${query}`,
	} as Parameters<typeof GET>[0];
}

/** Drain a handler response's body. An unread `NextResponse.json` body leaves a
 *  pending promise the async-leak gate flags, so status-only assertions still
 *  consume it. */
const drainBody = (res: Response): Promise<string> => res.text();

beforeEach(() => {
	vi.clearAllMocks();
	requireSessionMock.mockResolvedValue({ user: { id: "user-1" } });
	resolveActiveProjectIdMock.mockResolvedValue("project-1");
	listReadyAssetsForProjectMock.mockResolvedValue({
		assets: [],
		nextCursor: null,
	});
});

describe("GET /api/media/library kind filter", () => {
	it("accepts a single document kind and passes it as a one-element set", async () => {
		const res = await GET(reqWith("?kind=pdf"));
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(listReadyAssetsForProject).toHaveBeenCalledWith("project-1", {
			kinds: ["pdf"],
			cursor: undefined,
		});
		await drainBody(res);
	});

	it("accepts every document kind", async () => {
		for (const kind of ["text", "docx", "xlsx"] as const) {
			vi.clearAllMocks();
			requireSessionMock.mockResolvedValue({ user: { id: "user-1" } });
			resolveActiveProjectIdMock.mockResolvedValue("project-1");
			listReadyAssetsForProjectMock.mockResolvedValue({
				assets: [],
				nextCursor: null,
			});
			const res = await GET(reqWith(`?kind=${kind}`));
			expect(res.status).toBe(200);
			expect(listReadyAssetsForProject).toHaveBeenCalledWith("project-1", {
				kinds: [kind],
				cursor: undefined,
			});
			await drainBody(res);
		}
	});

	it("collects several repeated kinds into a set (the picker's 'All' view)", async () => {
		const res = await GET(reqWith("?kind=image&kind=pdf&kind=docx"));
		expect(res.status).toBe(200);
		expect(listReadyAssetsForProject).toHaveBeenCalledWith("project-1", {
			kinds: ["image", "pdf", "docx"],
			cursor: undefined,
		});
		await drainBody(res);
	});

	it("passes an empty set (every kind) when no kind param is present", async () => {
		// No `?kind=` → `getAll` returns `[]` → must reach the DB as "no filter",
		// never as `in []` (which Postgres rejects).
		const res = await GET(reqWith(""));
		expect(res.status).toBe(200);
		expect(listReadyAssetsForProject).toHaveBeenCalledWith("project-1", {
			kinds: [],
			cursor: undefined,
		});
		await drainBody(res);
	});

	it("passes a trimmed name search to the Project-scoped query", async () => {
		const res = await GET(reqWith("?q=%20Client%20plan%20"));
		expect(res.status).toBe(200);
		expect(listReadyAssetsForProject).toHaveBeenCalledWith("project-1", {
			kinds: [],
			cursor: undefined,
			query: "Client plan",
		});
		await drainBody(res);
	});

	it("rejects a search longer than the UI and database contract", async () => {
		const res = await GET(reqWith(`?q=${"a".repeat(201)}`));
		expect(res.status).toBe(400);
		expect(listReadyAssetsForProject).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("rejects a kind outside the accepted set as a 400", async () => {
		const res = await GET(reqWith("?kind=exe"));
		expect(res.status).toBe(400);
		expect(listReadyAssetsForProject).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("rejects when ANY repeated kind is invalid", async () => {
		const res = await GET(reqWith("?kind=image&kind=exe"));
		expect(res.status).toBe(400);
		expect(listReadyAssetsForProject).not.toHaveBeenCalled();
		await drainBody(res);
	});
});

describe("GET /api/media/library resolve mode", () => {
	it("routes repeated ?id= to the Project-filtered id lookup, never the lister", async () => {
		loadAssetsByIdsMock.mockResolvedValue([{ id: "a" }, { id: "b" }]);
		const res = await GET(reqWith("?id=a&id=b"));
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(loadAssetsByIds).toHaveBeenCalledWith(["a", "b"], "project-1");
		expect(listReadyAssetsForProject).not.toHaveBeenCalled();
		const body = JSON.parse(await drainBody(res));
		expect(body.assets).toHaveLength(2);
		expect(body.nextCursor).toBeNull();
	});

	it("rejects an empty id value as a 400", async () => {
		const res = await GET(reqWith("?id="));
		expect(res.status).toBe(400);
		expect(loadAssetsByIds).not.toHaveBeenCalled();
		await drainBody(res);
	});
});
