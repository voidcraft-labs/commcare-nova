// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { ExtractionStatusBadgeView } from "../ExtractionStatusBadge";

describe("ExtractionStatusBadgeView", () => {
	it("offers a concise retry action when reading fails", () => {
		const retry = vi.fn();
		render(
			<TooltipProvider>
				<ExtractionStatusBadgeView status="failed" retry={retry} />
			</TooltipProvider>,
		);

		const button = screen.getByRole("button", { name: "Retry" });
		expect(button.className).toContain("h-11");
		fireEvent.click(button);
		expect(retry).toHaveBeenCalledOnce();
	});

	it("uses outcome copy and keeps the explanation on a full-size target", () => {
		render(
			<TooltipProvider>
				<ExtractionStatusBadgeView status="ready" retry={vi.fn()} />
			</TooltipProvider>,
		);

		const info = screen.getByRole("button", {
			name: "What does Nova read from a document?",
		});
		expect(info.className).toContain("size-11");
		expect(screen.getByText("Ready")).toBeTruthy();
		expect(screen.queryByText("Extracted")).toBeNull();
	});
});
