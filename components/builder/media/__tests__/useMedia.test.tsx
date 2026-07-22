// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asAssetId } from "@/lib/domain/multimedia";
import { BuilderSessionProvider } from "@/lib/session/provider";
import type { MediaAssetView } from "../mediaClient";
import { useMediaLibrary, useMediaUpload } from "../useMedia";

const mocks = vi.hoisted(() => ({
	fetchMediaLibrary: vi.fn(),
	uploadMediaAsset: vi.fn(),
}));

vi.mock("../mediaClient", () => ({
	fetchMediaLibrary: mocks.fetchMediaLibrary,
	uploadMediaAsset: mocks.uploadMediaAsset,
}));

function imageAsset(id: string, name: string): MediaAssetView {
	return {
		id: asAssetId(id),
		contentHash: id.padEnd(64, "0").slice(0, 64),
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 100,
		originalFilename: name,
		status: "ready",
		createdAt: "2026-07-17T00:00:00.000Z",
	};
}

describe("useMediaLibrary", () => {
	beforeEach(() => {
		mocks.fetchMediaLibrary.mockReset();
		mocks.uploadMediaAsset.mockReset();
	});

	it("retries the current request after a load error", async () => {
		mocks.fetchMediaLibrary.mockRejectedValueOnce(
			new Error("Your files aren't available"),
		);
		const { result } = renderHook(() => useMediaLibrary(["image"], "app-1"));

		await waitFor(() =>
			expect(result.current.error).toBe("Your files aren't available"),
		);
		expect(mocks.fetchMediaLibrary).toHaveBeenCalledWith({
			kinds: ["image"],
			cursor: undefined,
			appId: "app-1",
			signal: expect.any(AbortSignal),
		});

		mocks.fetchMediaLibrary.mockResolvedValueOnce({
			assets: [],
			nextCursor: null,
		});
		act(() => result.current.retry());

		await waitFor(() => {
			expect(mocks.fetchMediaLibrary).toHaveBeenCalledTimes(2);
			expect(result.current.error).toBeNull();
			expect(result.current.isLoading).toBe(false);
		});
	});

	it("searches the whole server-side library and keeps that query across matched pages", async () => {
		const newest = imageAsset("newest", "newest.png");
		const olderMatch = imageAsset("older-match", "client-plan.png");
		const oldestMatch = imageAsset("oldest-match", "client-plan-archive.png");
		mocks.fetchMediaLibrary.mockResolvedValueOnce({
			assets: [newest],
			nextCursor: "older-unfiltered",
		});
		const { result, rerender } = renderHook(
			({ query }: { query: string }) =>
				useMediaLibrary(["image"], "app-1", query),
			{ initialProps: { query: "" } },
		);

		await waitFor(() => expect(result.current.assets).toEqual([newest]));

		// The current page has no match, but the server search returns an older
		// matching asset directly instead of making the UI claim there are none.
		mocks.fetchMediaLibrary.mockResolvedValueOnce({
			assets: [olderMatch],
			nextCursor: "more-matches",
		});
		rerender({ query: " client-plan " });
		await waitFor(() => expect(result.current.assets).toEqual([olderMatch]));
		expect(mocks.fetchMediaLibrary).toHaveBeenLastCalledWith({
			kinds: ["image"],
			cursor: undefined,
			query: "client-plan",
			appId: "app-1",
			signal: expect.any(AbortSignal),
		});

		mocks.fetchMediaLibrary.mockResolvedValueOnce({
			assets: [oldestMatch],
			nextCursor: null,
		});
		act(() => result.current.loadMore());
		await waitFor(() =>
			expect(result.current.assets).toEqual([olderMatch, oldestMatch]),
		);
		expect(mocks.fetchMediaLibrary).toHaveBeenLastCalledWith({
			kinds: ["image"],
			cursor: "more-matches",
			query: "client-plan",
			appId: "app-1",
			signal: expect.any(AbortSignal),
		});
	});
});

describe("useMediaUpload", () => {
	it("does not start an upload when the live Project capability is view-only", async () => {
		function wrapper({ children }: { children: ReactNode }) {
			return (
				<BuilderSessionProvider
					init={{ projectId: "project-1", role: "viewer", canEdit: false }}
				>
					{children}
				</BuilderSessionProvider>
			);
		}
		const { result } = renderHook(() => useMediaUpload("app-1"), { wrapper });
		const file = new File(["image"], "photo.png", { type: "image/png" });

		let uploaded: MediaAssetView | null = null;
		await act(async () => {
			uploaded = await result.current.upload(file);
		});

		expect(uploaded).toBeNull();
		expect(mocks.uploadMediaAsset).not.toHaveBeenCalled();
	});
});
