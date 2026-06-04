/**
 * `GET /api/media/library` — kind-filter acceptance tests.
 *
 * The library backs both the carrier pickers (media kinds) and the chat
 * file manager (document kinds), so the `kind` query param must accept any
 * `AssetKind` — including `pdf`/`text`/`docx`/`xlsx`. This pins that the
 * document kinds pass validation and reach the owner-scoped query, and that
 * a kind outside the accepted set is rejected as a 400 client error rather
 * than collapsing to a 500.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listReadyAssetsForOwner } from "@/lib/db/mediaAssets";
import { GET } from "../route";

const { requireSessionMock, listReadyAssetsForOwnerMock } = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	listReadyAssetsForOwnerMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/db/mediaAssets", () => ({
	listReadyAssetsForOwner: listReadyAssetsForOwnerMock,
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
	listReadyAssetsForOwnerMock.mockResolvedValue({
		assets: [],
		nextCursor: null,
	});
});

describe("GET /api/media/library kind filter", () => {
	it("accepts a document kind and passes it to the owner-scoped query", async () => {
		const res = await GET(reqWith("?kind=pdf"));
		expect(res.status).toBe(200);
		expect(listReadyAssetsForOwner).toHaveBeenCalledWith("user-1", {
			kind: "pdf",
			cursor: undefined,
		});
		await drainBody(res);
	});

	it("accepts every document kind", async () => {
		for (const kind of ["text", "docx", "xlsx"] as const) {
			vi.clearAllMocks();
			requireSessionMock.mockResolvedValue({ user: { id: "user-1" } });
			listReadyAssetsForOwnerMock.mockResolvedValue({
				assets: [],
				nextCursor: null,
			});
			const res = await GET(reqWith(`?kind=${kind}`));
			expect(res.status).toBe(200);
			expect(listReadyAssetsForOwner).toHaveBeenCalledWith("user-1", {
				kind,
				cursor: undefined,
			});
			await drainBody(res);
		}
	});

	it("rejects a kind outside the accepted set as a 400", async () => {
		const res = await GET(reqWith("?kind=exe"));
		expect(res.status).toBe(400);
		expect(listReadyAssetsForOwner).not.toHaveBeenCalled();
		await drainBody(res);
	});
});
