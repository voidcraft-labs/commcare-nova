// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	type DistanceUnit,
	literal,
	prop,
	term,
	within,
} from "@/lib/domain/predicate";
import { PredicateCardEditor } from "../../PredicateCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [{ name: "location", label: "Home", data_type: "geopoint" }],
};

function renderDistance(
	onChange = vi.fn(),
	options: { distance?: number; unit?: DistanceUnit } = {},
) {
	const distance = options.distance ?? 1;
	const unit = options.unit ?? "miles";
	render(
		<PredicateCardEditor
			value={within(
				prop("patient", "location"),
				term(literal("0 0")),
				distance,
				unit,
			)}
			onChange={onChange}
			caseTypes={[PATIENT]}
			currentCaseType="patient"
		/>,
	);
	return {
		input: screen.getByLabelText("Distance") as HTMLInputElement,
		onChange,
	};
}

describe("WithinDistanceCard distance validation", () => {
	it("labels the property choice as location information", () => {
		renderDistance();
		expect(
			screen.getByRole("button", { name: "Location information: Home" }),
		).toBeDefined();
	});

	it.each([
		["an empty distance", "", ""],
		["non-numeric input", "not-a-number", ""],
		["a negative distance", "-1", "-1"],
		["a zero distance", "0", "0"],
	])("preserves %s and explains how to fix it", (_label, authoredDraft, visibleDraft) => {
		const { input, onChange } = renderDistance();
		expect(Number(input.min)).toBeGreaterThan(0);
		expect(input.step).toBe("any");

		input.focus();
		fireEvent.change(input, { target: { value: authoredDraft } });
		fireEvent.blur(input);

		expect(input.value).toBe(visibleDraft);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		const error = screen.getByRole("alert");
		expect(error.textContent).toBe("Enter a distance greater than 0");
		expect(input.getAttribute("aria-describedby")).toBe(error.id);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("clears the error and commits a positive distance", () => {
		const { input, onChange } = renderDistance();
		input.focus();
		fireEvent.change(input, { target: { value: "-1" } });
		fireEvent.blur(input);
		expect(input.getAttribute("aria-invalid")).toBe("true");

		input.focus();
		fireEvent.change(input, { target: { value: "0.25" } });
		expect(input.getAttribute("aria-invalid")).toBeNull();
		expect(screen.queryByText("Enter a distance greater than 0")).toBeNull();
		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "within-distance", distance: 0.25 }),
		);
	});

	it("explains when the selected unit would overflow during conversion", () => {
		const { input, onChange } = renderDistance();
		input.focus();
		fireEvent.change(input, { target: { value: String(Number.MAX_VALUE) } });
		fireEvent.blur(input);

		expect(screen.getByRole("alert").textContent).toBe(
			"Enter a smaller distance in miles",
		);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps a safe unit and shows an inline repair when another unit would overflow", async () => {
		const onChange = vi.fn();
		const safeKilometersOnly = Number.MAX_VALUE / 1200;
		renderDistance(onChange, {
			distance: safeKilometersOnly,
			unit: "kilometers",
		});

		const trigger = screen.getByRole("combobox", {
			name: "Distance unit kilometers",
		});
		fireEvent.click(trigger);
		const miles = await screen.findByRole("option", { name: "miles" });
		fireEvent.pointerDown(miles, { pointerType: "mouse" });
		fireEvent.click(miles);
		// Base UI releases the closed select's scroll lock on a zero-delay
		// timer. Drain that teardown before the leak detector samples the test.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(onChange).not.toHaveBeenCalled();
		expect(trigger.getAttribute("aria-invalid")).toBe("true");
		const error = screen.getByRole("alert");
		expect(error.textContent).toBe(
			"Enter a smaller distance before switching to miles",
		);
		expect(trigger.getAttribute("aria-describedby")).toBe(error.id);
		expect(
			screen.getByRole("combobox", { name: "Distance unit kilometers" }),
		).toBeDefined();
	});
});
