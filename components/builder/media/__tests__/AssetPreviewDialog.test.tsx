// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { AssetPreviewDialog } from "../AssetPreviewDialog";

const mocks = vi.hoisted(() => ({
	fetchAssetExtract: vi.fn(),
	fetchAssetExtractMeta: vi.fn(),
}));

vi.mock("../mediaClient", async (importOriginal) => ({
	...(await importOriginal<typeof import("../mediaClient")>()),
	fetchAssetExtract: mocks.fetchAssetExtract,
	fetchAssetExtractMeta: mocks.fetchAssetExtractMeta,
}));

describe("AssetPreviewDialog", () => {
	beforeEach(() => {
		mocks.fetchAssetExtract.mockReset();
		mocks.fetchAssetExtract.mockResolvedValue("Document summary");
		mocks.fetchAssetExtractMeta.mockReset();
		mocks.fetchAssetExtractMeta.mockResolvedValue(null);
	});

	it("uses full-size standard actions for close, info, and download", async () => {
		render(
			<TooltipProvider>
				<AssetPreviewDialog
					target={{
						id: "asset-1",
						kind: "docx",
						filename: "client-plan.docx",
						title: "Client plan",
					}}
					onOpenChange={vi.fn()}
				/>
			</TooltipProvider>,
		);

		const close = screen.getByRole("button", { name: "Close" });
		const info = screen.getByRole("button", {
			name: "What does Nova read from a document?",
		});
		expect(close.className).toContain("h-11");
		expect(info.className).toContain("size-11");

		fireEvent.click(screen.getByRole("tab", { name: "Document" }));
		const download = screen.getByRole("button", { name: "Download original" });
		expect(download.tagName).toBe("A");
		expect(download.className).toContain("h-11");
		expect(download.getAttribute("download")).toBe("client-plan.docx");
		await waitFor(() =>
			expect(screen.getByText("Download original")).toBeTruthy(),
		);
	});

	it("wraps the complete document title and filename in the dialog header", async () => {
		const title =
			"Community maternal and child health referral plan for every district";
		const filename =
			"community-maternal-and-child-health-referral-plan-for-every-district.docx";
		render(
			<TooltipProvider>
				<AssetPreviewDialog
					target={{
						id: "asset-long-name",
						kind: "docx",
						filename,
						title,
					}}
					onOpenChange={vi.fn()}
				/>
			</TooltipProvider>,
		);

		const titleText = screen.getByText(title);
		const filenameText = screen.getByText(filename);
		for (const text of [titleText, filenameText]) {
			expect(text.className).not.toContain("truncate");
			expect(text.className).toContain("[overflow-wrap:anywhere]");
			expect(text.getAttribute("title")).toBeNull();
		}
		await waitFor(() =>
			expect(screen.getByText("Document summary")).toBeTruthy(),
		);
	});

	it("lets the user retry when what Nova reads fails to load", async () => {
		mocks.fetchAssetExtract
			.mockRejectedValueOnce(new Error("What Nova reads isn't available"))
			.mockResolvedValueOnce("Recovered information");
		render(
			<TooltipProvider>
				<AssetPreviewDialog
					target={{
						id: "asset-2",
						kind: "pdf",
						filename: "referral.pdf",
						title: "Referral",
					}}
					onOpenChange={vi.fn()}
				/>
			</TooltipProvider>,
		);

		await waitFor(() =>
			expect(
				screen.getByText("What Nova reads couldn't be loaded"),
			).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		await waitFor(() => {
			expect(screen.getByText("Recovered information")).toBeTruthy();
			expect(mocks.fetchAssetExtract).toHaveBeenCalledTimes(2);
		});
	});
});
