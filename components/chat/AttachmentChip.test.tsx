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
	it("keeps preview and removal as compact chip-local controls", () => {
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

		// Chip controls are plain buttons clipped to the chip, not the 44px
		// shadcn Button: the standard height would extend hover bounds past the
		// visible pill (the sanctioned exception in components/CLAUDE.md).
		expect(preview.getAttribute("data-slot")).toBeNull();
		expect(preview.className).toContain("nova-focusable-inset");
		expect(preview.className).toContain("h-full");
		expect(remove.getAttribute("data-slot")).toBeNull();
		expect(remove.className).toContain("nova-focusable-inset");
		expect(remove.className).toContain("h-full");

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
				reading
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

	it("offers retry only for a failed extract", () => {
		const onRetry = vi.fn();
		const { rerender } = render(
			<AttachmentChip kind="pdf" filename="intake.pdf" />,
		);
		expect(
			screen.queryByRole("button", {
				name: "Nova couldn't read intake.pdf. Try again",
			}),
		).toBeNull();

		rerender(
			<AttachmentChip kind="pdf" filename="intake.pdf" onRetry={onRetry} />,
		);
		const retry = screen.getByRole("button", {
			name: "Nova couldn't read intake.pdf. Try again",
		});
		fireEvent.click(retry);
		expect(onRetry).toHaveBeenCalledOnce();
	});
});
