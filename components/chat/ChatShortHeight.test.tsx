// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	PersistentChatComposer,
	ShortChatFallback,
	shouldShowShortChatFallback,
} from "@/components/chat/ChatSidebar";

function DraftAndAttachmentState() {
	const [draft, setDraft] = useState("");
	const [attachments, setAttachments] = useState<string[]>([]);
	return (
		<>
			<label>
				Draft
				<input
					value={draft}
					onChange={(event) => setDraft(event.currentTarget.value)}
				/>
			</label>
			<button
				type="button"
				onClick={() => setAttachments((current) => [...current, "intake.pdf"])}
			>
				Stage file
			</button>
			{attachments.map((name) => (
				<span key={name}>{name}</span>
			))}
		</>
	);
}

describe("short-height chat", () => {
	it("uses the fallback only for an expanded standalone chat", () => {
		expect(
			shouldShowShortChatFallback({
				centered: false,
				docked: false,
				veryShortViewport: true,
			}),
		).toBe(true);
		expect(
			shouldShowShortChatFallback({
				centered: true,
				docked: false,
				veryShortViewport: true,
			}),
		).toBe(false);
		expect(
			shouldShowShortChatFallback({
				centered: false,
				docked: true,
				veryShortViewport: true,
			}),
		).toBe(false);
		expect(
			shouldShowShortChatFallback({
				centered: false,
				docked: false,
				veryShortViewport: false,
			}),
		).toBe(false);
	});

	it("replaces the clipped composer with one explicit full-size action", () => {
		const onCollapse = vi.fn();
		render(<ShortChatFallback onCollapse={onCollapse} />);

		expect(screen.getByText("Chat needs more room")).toBeDefined();
		expect(
			screen.getByText("Make the window taller to continue"),
		).toBeDefined();
		const collapse = screen.getByRole("button", { name: "Collapse chat" });
		expect(collapse.getAttribute("data-slot")).toBe("button");
		expect(collapse.className).toContain("h-11");

		fireEvent.click(collapse);
		expect(onCollapse).toHaveBeenCalledOnce();
	});

	it("preserves unsent text and staged attachments while an inspector uses the short dock", () => {
		const { rerender } = render(
			<PersistentChatComposer hidden={false}>
				<DraftAndAttachmentState />
			</PersistentChatComposer>,
		);

		fireEvent.change(screen.getByLabelText("Draft"), {
			target: { value: "Keep this thought" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Stage file" }));

		rerender(
			<PersistentChatComposer hidden>
				<DraftAndAttachmentState />
			</PersistentChatComposer>,
		);
		const hiddenRegion =
			screen.getByLabelText("Draft").parentElement?.parentElement;
		expect(hiddenRegion?.className).toContain("hidden");
		expect(hiddenRegion?.hasAttribute("inert")).toBe(true);

		rerender(
			<PersistentChatComposer hidden={false}>
				<DraftAndAttachmentState />
			</PersistentChatComposer>,
		);
		expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(
			"Keep this thought",
		);
		expect(screen.getByText("intake.pdf")).toBeDefined();
	});
});
