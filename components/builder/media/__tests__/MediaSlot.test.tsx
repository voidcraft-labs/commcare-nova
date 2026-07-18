// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { StagedUploadChip } from "../MediaSlot";

describe("StagedUploadChip", () => {
	it("keeps the complete failed-upload guidance visible inline and dismissible", () => {
		const dismiss = vi.fn();
		const message =
			"This file is too large. Choose an image smaller than 5 MB, then try again.";
		render(
			<TooltipProvider>
				<StagedUploadChip
					upload={{
						filename: "client-photo.png",
						kind: "image",
						status: { state: "error", message },
					}}
					onCancel={vi.fn()}
					onDismiss={dismiss}
				/>
			</TooltipProvider>,
		);

		const alert = screen.getByRole("alert");
		const filename = within(alert).getByText("client-photo.png");
		expect(filename.className).not.toContain("truncate");
		expect(filename.className).toContain("[overflow-wrap:anywhere]");
		expect(filename.getAttribute("title")).toBeNull();
		const guidance = within(alert).getByText(message);
		expect(guidance.className).not.toContain("truncate");
		const dismissButton = within(alert).getByRole("button", {
			name: "Dismiss failed upload of client-photo.png",
		});
		expect(dismissButton.className).toContain("size-11");
		fireEvent.click(dismissButton);
		expect(dismiss).toHaveBeenCalledOnce();
	});
});
