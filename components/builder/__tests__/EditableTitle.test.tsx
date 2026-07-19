// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditableTitle } from "@/components/builder/EditableTitle";

const session = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => session.canEdit,
}));

describe("EditableTitle wrapping layout", () => {
	beforeEach(() => {
		session.canEdit = true;
	});

	it("wraps a complete authored name inside its parent while preserving inline editing", () => {
		const longName =
			"Community health follow-up and medication administration for returning clients";
		const onSave = vi.fn(() => ({ ok: true as const }));
		render(
			<div className="w-48">
				<EditableTitle
					value={longName}
					onSave={onSave}
					wrap
					ariaLabel="Module name"
				/>
			</div>,
		);

		const title = screen.getByRole("textbox", { name: "Module name" });
		expect(title.tagName).toBe("TEXTAREA");
		expect(title.className).toContain("w-full");
		expect(title.className).toContain("max-w-full");
		expect(title.className).toContain("break-words");
		expect(title.className).toContain("whitespace-pre-wrap");
		expect(title.className).not.toContain("truncate");
		expect(title.getAttribute("rows")).toBe("1");
		expect(title.getAttribute("data-slot")).toBe("textarea");

		fireEvent.focus(title);
		fireEvent.change(title, { target: { value: `${longName} updated` } });
		fireEvent.keyDown(title, { key: "Enter" });

		expect(onSave).toHaveBeenCalledWith(`${longName} updated`);
	});

	it("shows the full wrapping name as non-interactive content to viewers", () => {
		session.canEdit = false;
		render(
			<EditableTitle
				value="A long module name that remains completely available to viewers"
				wrap
				ariaLabel="Module name"
			/>,
		);

		const title = screen.getByRole("textbox", { name: "Module name" });
		expect((title as HTMLTextAreaElement).readOnly).toBe(true);
		expect(title.getAttribute("tabindex")).toBe("-1");
		expect(title.className).toContain("pointer-events-none");
		expect(title.className).toContain("whitespace-pre-wrap");
	});

	it("keeps a frozen single-line title labeled and out of the tab order", () => {
		session.canEdit = false;
		render(
			<EditableTitle value="Client intake" ariaLabel="Application name" />,
		);

		const title = screen.getByRole("textbox", { name: "Application name" });
		expect((title as HTMLInputElement).readOnly).toBe(true);
		expect(title.getAttribute("tabindex")).toBe("-1");
		expect(title.className).toContain("pointer-events-none");
	});
});
