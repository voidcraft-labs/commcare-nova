import { NextRequest } from "next/server";
import { AppAccessError } from "@/lib/db/appAccess";
/**
 * `GET /api/media/library`: query acceptance tests for both modes.
 *
 * List mode: the library backs both the carrier pickers (media kinds) and the
 * chat file manager (document kinds), so the repeated `kind` query param must
 * accept any `AssetKind`, including `pdf`/`text`/`docx`/`xlsx`, and collect
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
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	listReadyAssetsForProject,
	loadAssetsByIds,
	MalformedCursorError,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
import { GET } from "../route";

const {
	requireSessionMock,
	resolveActiveProjectIdMock,
	resolveAppScopeMock,
	listReadyAssetsForProjectMock,
	loadAssetsByIdsMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	resolveActiveProjectIdMock: vi.fn(),
	resolveAppScopeMock: vi.fn(),
	listReadyAssetsForProjectMock: vi.fn(),
	loadAssetsByIdsMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
	resolveActiveProjectId: resolveActiveProjectIdMock,
}));
vi.mock("@/lib/db/appAccess", async (original) => ({
	...(await original<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: resolveAppScopeMock,
}));
vi.mock("@/lib/db/mediaAssets", async (original) => ({
	...(await original<typeof import("@/lib/db/mediaAssets")>()),
	listReadyAssetsForProject: listReadyAssetsForProjectMock,
	loadAssetsByIds: loadAssetsByIdsMock,
}));

function reqWith(query: string) {
	return new NextRequest(`http://localhost/api/media/library${query}`);
}

function asset(
	id: MediaAssetRecord["id"],
	status: MediaAssetRecord["status"] = "ready",
): MediaAssetRecord {
	return {
		id,
		owner: "user-1",
		project_id: "project-1",
		contentHash: "a".repeat(64),
		mimeType: "application/pdf",
		kind: "pdf",
		extension: ".pdf",
		sizeBytes: 100,
		gcsObjectKey: "private-object-key",
		originalFilename: "document.pdf",
		status,
		created_at: new Date(0),
	};
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
		const first = testMediaAssetId("library-first");
		const second = testMediaAssetId("library-second");
		loadAssetsByIdsMock.mockResolvedValue([
			asset(first),
			asset(second, "pending"),
		]);
		const res = await GET(reqWith(`?id=${first}&id=${second}`));
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(loadAssetsByIds).toHaveBeenCalledWith([first, second], "project-1");
		expect(listReadyAssetsForProject).not.toHaveBeenCalled();
		const body = JSON.parse(await drainBody(res));
		expect(
			body.assets.map((value: { id: string; status: string }) => ({
				id: value.id,
				status: value.status,
			})),
		).toEqual([
			{ id: first, status: "ready" },
			{ id: second, status: "pending" },
		]);
		expect(body.assets[0]).not.toHaveProperty("gcsObjectKey");
		expect(body.assets[0]).not.toHaveProperty("owner");
		expect(body.assets[0].createdAt).toBe("1970-01-01T00:00:00.000Z");
		expect(body.nextCursor).toBeNull();
	});

	it("rejects an empty id value as a 400", async () => {
		const res = await GET(reqWith("?id="));
		expect(res.status).toBe(400);
		expect(loadAssetsByIds).not.toHaveBeenCalled();
		await drainBody(res);
	});
});

it("resolves the app's Project instead of the active Project", async () => {
	resolveAppScopeMock.mockResolvedValue({ projectId: "app-project" });
	const response = await GET(reqWith("?appId=app-2&kind=image"));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ assets: [], nextCursor: null });
	expect(resolveAppScopeMock).toHaveBeenCalledWith("app-2", "user-1", "view");
	expect(resolveActiveProjectIdMock).not.toHaveBeenCalled();
	expect(listReadyAssetsForProjectMock).toHaveBeenCalledWith("app-project", {
		kinds: ["image"],
		cursor: undefined,
	});
});
it("refuses an inaccessible app before listing or resolving media", async () => {
	resolveAppScopeMock.mockRejectedValue(new AppAccessError("not_member"));
	const response = await GET(reqWith("?appId=app-2"));
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: "App not found" });
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(listReadyAssetsForProjectMock).not.toHaveBeenCalled();
	expect(loadAssetsByIdsMock).not.toHaveBeenCalled();
});
it("projects the real cursor decoder's refusal as a private client error", async () => {
	listReadyAssetsForProjectMock.mockRejectedValue(new MalformedCursorError());
	const response = await GET(reqWith("?cursor=broken"));
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({
		error: expect.stringContaining("opaque token"),
	});
	expect(response.headers.get("cache-control")).toBe("private, no-store");
});
