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
		expect(trigger.className).toContain("data-[size=default]:h-8");
		expect(trigger.className).not.toContain("line-clamp-none");

		view.rerender(<SelectFixture wrapValue />);
		trigger = screen.getByRole("combobox", { name: "Status" });
		expect(trigger.className).toContain("whitespace-normal");
		expect(trigger.className).toContain("line-clamp-none");
		expect(trigger.className).toContain("data-[size=default]:h-auto");
		expect(trigger.className).not.toContain("line-clamp-1");
		expect(trigger.className).not.toContain("data-[size=default]:h-8");
	});
});
