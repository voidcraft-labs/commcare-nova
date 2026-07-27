// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DraftCommitInput, DraftLinesField } from "../DraftCommitField";

describe("DraftCommitInput", () => {
	it("keeps invalid intermediate name states local until an explicit commit", () => {
		const commit = vi.fn(() => ({ ok: true as const }));
		render(
			<DraftCommitInput
				id="role-name"
				value="Community health worker"
				disabled={false}
				validate={(value) => (value === "" ? "Enter a role name." : undefined)}
				onCommit={commit}
			/>,
		);
		const input = screen.getByRole("textbox");

		fireEvent.change(input, { target: { value: "" } });
		expect(commit).not.toHaveBeenCalled();
		fireEvent.blur(input);
		expect(commit).not.toHaveBeenCalled();
		expect((input as HTMLInputElement).value).toBe("");
		expect(screen.getByRole("alert").textContent).toContain(
			"Enter a role name",
		);
	});

	it("preserves a typed duplicate-prefix draft when the commit gate refuses it", () => {
		const commit = vi.fn(() => ({
			ok: false as const,
			messages: ["A role with that name already exists."],
		}));
		render(
			<DraftCommitInput
				id="persona-name"
				value="Asha"
				disabled={false}
				onCommit={commit}
			/>,
		);
		const input = screen.getByRole("textbox");

		// "Ann" may transiently collide while the author is typing "Anna".
		fireEvent.change(input, { target: { value: "Ann" } });
		expect(commit).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "Anna" } });
		expect(commit).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: "Enter" });

		expect(commit).toHaveBeenCalledOnce();
		expect((input as HTMLInputElement).value).toBe("Anna");
		expect(screen.getByRole("alert").textContent).toContain(
			"A role with that name already exists",
		);
	});

	it("refuses to clobber a peer edit and Escape restores the shared value", () => {
		const commit = vi.fn(() => ({ ok: true as const }));
		const view = render(
			<DraftCommitInput
				id="label"
				value="Region"
				disabled={false}
				onCommit={commit}
			/>,
		);
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Area" } });

		view.rerender(
			<DraftCommitInput
				id="label"
				value="District"
				disabled={false}
				onCommit={commit}
			/>,
		);
		fireEvent.blur(input);

		expect(commit).not.toHaveBeenCalled();
		expect((input as HTMLInputElement).value).toBe("Area");
		expect(screen.getByRole("alert").textContent).toContain(
			"changed in another editor",
		);
		fireEvent.keyDown(input, { key: "Escape" });
		expect((input as HTMLInputElement).value).toBe("District");
	});
});

describe("DraftLinesField", () => {
	it("keeps assigned-value changes visible when narrowing choices is refused", () => {
		const commit = vi.fn(() => ({
			ok: false as const,
			messages: ['Asha has Region set to "south", which is not accepted.'],
		}));
		render(
			<DraftLinesField
				id="accepted"
				value={["north", "south"]}
				disabled={false}
				onCommit={commit}
			/>,
		);
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "north" } });
		expect(commit).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "Apply accepted values" }),
		);

		expect(commit).toHaveBeenCalledWith(["north"]);
		expect((input as HTMLTextAreaElement).value).toBe("north");
		expect(screen.getByRole("alert").textContent).toContain(
			'Asha has Region set to "south"',
		);
		expect(
			screen
				.getByRole("button", { name: "Apply accepted values" })
				.className.split(/\s+/),
		).toContain("min-h-11");
	});
});
