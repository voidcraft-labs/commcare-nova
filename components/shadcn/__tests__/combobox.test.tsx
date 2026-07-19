// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	Combobox,
	ComboboxContent,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "../combobox";

describe("Combobox disabled choices", () => {
	it("keeps pointer affordances available for disabled explanations", async () => {
		render(
			<Combobox open items={["Available", "Unavailable"]}>
				<ComboboxInput aria-label="Choose information" />
				<ComboboxContent>
					<ComboboxList>
						<ComboboxItem value="Available">Available</ComboboxItem>
						<ComboboxItem value="Unavailable" disabled>
							Unavailable
						</ComboboxItem>
					</ComboboxList>
				</ComboboxContent>
			</Combobox>,
		);
		await act(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);

		const disabledChoice = screen.getByRole("option", {
			name: "Unavailable",
		});
		expect(disabledChoice.getAttribute("aria-disabled")).toBe("true");
		expect(disabledChoice.className).toContain(
			"data-disabled:cursor-not-allowed",
		);
		expect(disabledChoice.className).not.toContain(
			"data-disabled:pointer-events-none",
		);
	});
});
