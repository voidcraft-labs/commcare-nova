// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AttachmentChip } from "@/components/chat/AttachmentChip";

vi.mock("@/components/shadcn/tooltip", () => ({
	Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
	TooltipContent: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	TooltipTrigger: ({ render }: { render: ReactElement }) => render,
}));

describe("AttachmentChip", () => {
	it("uses shared full-size controls for preview and removal", () => {
		const onPreview = vi.fn();
		const onRemove = vi.fn();
		render(
			<AttachmentChip
				kind="pdf"
				filename="intake.pdf"
				onPreview={onPreview}
				onRemove={onRemove}
			/>,
		);

		const preview = screen.getByRole("button", { name: "intake.pdf" });
		const remove = screen.getByRole("button", { name: "Remove intake.pdf" });

		expect(preview.getAttribute("data-slot")).toBe("button");
		expect(preview.className).toContain("h-11");
		expect(remove.getAttribute("data-slot")).toBe("button");
		expect(remove.className).toContain("size-11");

		fireEvent.click(preview);
		fireEvent.click(remove);
		expect(onPreview).toHaveBeenCalledOnce();
		expect(onRemove).toHaveBeenCalledOnce();
	});

	it("keeps reading actions explainable without letting them run", () => {
		const onPreview = vi.fn();
		const onRemove = vi.fn();
		render(
			<AttachmentChip
				kind="pdf"
				filename="intake.pdf"
				onPreview={onPreview}
				previewDisabled
				onRemove={onRemove}
				removeDisabled
			/>,
		);

		const preview = screen.getByRole("button", { name: "intake.pdf" });
		const remove = screen.getByRole("button", {
			name: "intake.pdf can't be removed while it's being read",
		});

		expect(preview.getAttribute("aria-disabled")).toBe("true");
		expect(preview.className).toContain("cursor-not-allowed");
		expect(remove.getAttribute("aria-disabled")).toBe("true");
		expect(remove.className).toContain("cursor-not-allowed");

		fireEvent.click(preview);
		fireEvent.click(remove);
		expect(onPreview).not.toHaveBeenCalled();
		expect(onRemove).not.toHaveBeenCalled();
	});
});
