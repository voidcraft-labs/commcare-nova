// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { ICON_CATALOG } from "@/lib/domain/builtinIcons";
import { asAssetId } from "@/lib/domain/multimedia";
import { MediaPickerDialog } from "../MediaPickerDialog";
import type { MediaAssetView } from "../mediaClient";

const mocks = vi.hoisted(() => ({
	retry: vi.fn(),
	assets: [] as MediaAssetView[],
	useMediaLibrary: vi.fn(),
}));

vi.mock("../useMedia", () => ({
	useMediaLibrary: mocks.useMediaLibrary,
	useMediaUpload: () => ({
		upload: vi.fn(),
		status: { state: "idle" as const },
	}),
}));

describe("MediaPickerDialog", () => {
	beforeEach(() => {
		mocks.retry.mockReset();
		mocks.assets.length = 0;
		mocks.useMediaLibrary.mockReset();
		mocks.useMediaLibrary.mockImplementation(() => ({
			assets: mocks.assets,
			isLoading: false,
			error: null,
			hasMore: false,
			loadMore: vi.fn(),
			retry: mocks.retry,
			addUploaded: vi.fn(),
			removeAsset: vi.fn(),
			updateAsset: vi.fn(),
		}));
	});

	it("uses the standard tab flow and gives an empty library a direct next step", async () => {
		render(
			<TooltipProvider>
				<MediaPickerDialog
					open
					onOpenChange={vi.fn()}
					kinds={["image"]}
					onPick={vi.fn()}
				/>
			</TooltipProvider>,
		);

		expect(screen.getByRole("heading", { name: "Attach image" })).toBeTruthy();
		expect(screen.getByText("Choose file")).toBeTruthy();
		expect(screen.getByText("Supported file type")).toBeTruthy();

		fireEvent.click(screen.getByRole("tab", { name: "Library" }));
		expect(screen.getByLabelText("Search files")).toBeTruthy();
		expect(screen.getByText("No files yet")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
		await waitFor(() => expect(screen.getByText("Choose file")).toBeTruthy());
	});

	it("keeps preview and delete visible and clickable when hover isn't available", async () => {
		mocks.assets.push({
			id: asAssetId("asset-1"),
			contentHash: "hash-1",
			mimeType: "image/png",
			kind: "image",
			extension: ".png",
			sizeBytes: 1200,
			originalFilename: "client-photo.png",
			status: "ready",
			createdAt: "2026-07-17T00:00:00.000Z",
		});
		render(
			<TooltipProvider>
				<MediaPickerDialog
					open
					onOpenChange={vi.fn()}
					kinds={["image"]}
					onPick={vi.fn()}
				/>
			</TooltipProvider>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Library" }));
		const preview = screen.getByRole("button", {
			name: "Preview client-photo.png",
		});
		const deleteButton = screen.getByRole("button", {
			name: "Delete client-photo.png",
		});
		for (const action of [preview, deleteButton]) {
			expect(action.className).toContain(
				"[@media(hover:none)]:pointer-events-auto",
			);
			expect(action.className).toContain("[@media(hover:none)]:opacity-100");
		}

		fireEvent.click(deleteButton);
		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "This file will be deleted" }),
			).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "This file will be deleted" }),
			).toBeNull(),
		);
	});

	it("discloses compact library captions from the existing thumbnail action", () => {
		const filename =
			"community-maternal-and-child-health-referral-plan-for-every-district.docx";
		const documentTitle =
			"Community maternal and child health referral plan for every district";
		mocks.assets.push({
			id: asAssetId("asset-long-name"),
			contentHash: "hash-long-name",
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			kind: "docx",
			extension: ".docx",
			sizeBytes: 1200,
			originalFilename: filename,
			status: "ready",
			createdAt: "2026-07-17T00:00:00.000Z",
			extract: {
				status: "ready",
				version: 1,
				truncated: false,
				charCount: 300,
				title: documentTitle,
			},
		});
		render(
			<TooltipProvider>
				<MediaPickerDialog
					open
					onOpenChange={vi.fn()}
					kinds={["docx"]}
					onPick={vi.fn()}
				/>
			</TooltipProvider>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Library" }));
		const choose = screen.getByRole("button", {
			name: `Choose ${documentTitle}, file ${filename}`,
		});
		expect(choose.getAttribute("data-slot")).toBe("tooltip-trigger");
		expect(choose.getAttribute("title")).toBeNull();
		expect(screen.getByText(filename).className).toContain("truncate");
		expect(screen.getByText(documentTitle).className).toContain("truncate");
	});

	it("wraps built-in icon names instead of hiding them", () => {
		const entry = ICON_CATALOG[0];
		render(
			<TooltipProvider>
				<MediaPickerDialog
					open
					onOpenChange={vi.fn()}
					kinds={["image"]}
					onPick={vi.fn()}
					iconLibrary="module"
				/>
			</TooltipProvider>,
		);

		const label = screen.getByText(entry.label);
		expect(label.className).not.toContain("truncate");
		expect(label.className).toContain("[overflow-wrap:anywhere]");
		expect(label.getAttribute("title")).toBeNull();
	});

	it("sends name search to the authoritative paginated library request", async () => {
		const olderMatch: MediaAssetView = {
			id: asAssetId("older-match"),
			contentHash: "hash-older",
			mimeType: "image/png",
			kind: "image",
			extension: ".png",
			sizeBytes: 1200,
			originalFilename: "client-plan.png",
			status: "ready",
			createdAt: "2026-07-16T00:00:00.000Z",
		};
		mocks.useMediaLibrary.mockImplementation(
			(_kinds, _appId, query: string | undefined) => ({
				assets: query ? [olderMatch] : [],
				isLoading: false,
				error: null,
				hasMore: false,
				loadMore: vi.fn(),
				retry: mocks.retry,
				addUploaded: vi.fn(),
				removeAsset: vi.fn(),
				updateAsset: vi.fn(),
			}),
		);
		const view = render(
			<TooltipProvider>
				<MediaPickerDialog
					open
					onOpenChange={vi.fn()}
					kinds={["image"]}
					onPick={vi.fn()}
				/>
			</TooltipProvider>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Library" }));
		fireEvent.change(screen.getByLabelText("Search files"), {
			target: { value: "client plan" },
		});
		await waitFor(() =>
			expect(mocks.useMediaLibrary).toHaveBeenLastCalledWith(
				["image"],
				undefined,
				"client plan",
			),
		);
		expect(
			screen.getByRole("button", { name: "Choose client-plan.png" }),
		).toBeTruthy();
		// This controlled dialog remains open by design. Let Base UI finish the
		// dialog's initial-focus task before unmounting, then drain its zero-delay
		// scroll-lock release before the leak gate samples cleanup.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		view.unmount();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});
});
