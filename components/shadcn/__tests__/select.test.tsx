// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../select";

function SelectFixture({ wrapValue = false }: { wrapValue?: boolean }) {
	return (
		<Select value="active">
			<SelectTrigger aria-label="Status" wrapValue={wrapValue}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="active">Active</SelectItem>
			</SelectContent>
		</Select>
	);
}

describe("Select value layout", () => {
	it("keeps compact selects single-line unless wrapping is requested", () => {
		const view = render(<SelectFixture />);
		let trigger = screen.getByRole("combobox", { name: "Status" });
		expect(trigger.className).toContain("whitespace-nowrap");
		expect(trigger.className).toContain("line-clamp-1");
		expect(trigger.className).toContain("h-11");
		expect(trigger.className).not.toContain("line-clamp-none");

		view.rerender(<SelectFixture wrapValue />);
		trigger = screen.getByRole("combobox", { name: "Status" });
		expect(trigger.className).toContain("whitespace-normal");
		expect(trigger.className).toContain("line-clamp-none");
		expect(trigger.className).toContain("min-h-11");
		expect(trigger.className).not.toContain("line-clamp-1");
		expect(trigger.className).not.toContain(" h-11 ");
	});

	it("renders the item's label in the trigger when the root carries items", () => {
		// A bare <SelectValue /> resolves its text through the root's `items`
		// map; without it Base UI falls back to the raw stored value, which is
		// how a filter trigger once read `all` while its menu said
		// "All statuses".
		render(
			<Select value="needs-review" items={{ "needs-review": "Needs review" }}>
				<SelectTrigger aria-label="Filter by status">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="needs-review">Needs review</SelectItem>
				</SelectContent>
			</Select>,
		);
		const trigger = screen.getByRole("combobox", { name: "Filter by status" });
		expect(trigger.textContent).toContain("Needs review");
		expect(trigger.textContent).not.toContain("needs-review");
	});

	it("centers the value at every height, wrapping or not", () => {
		// A trigger that grows for a two-line value must still center a value
		// that happens to fit on one line: top-aligning it leaves the label
		// hanging under the top edge of a `min-h-*` touch target.
		const view = render(<SelectFixture />);
		let trigger = screen.getByRole("combobox", { name: "Status" });
		expect(trigger.className).toContain("items-center");
		expect(trigger.className).not.toContain("items-start");

		view.rerender(<SelectFixture wrapValue />);
		trigger = screen.getByRole("combobox", { name: "Status" });
		expect(trigger.className).toContain("items-center");
		expect(trigger.className).not.toContain("items-start");
	});
});
