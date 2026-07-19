// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseType,
	type Column,
	idMappingColumn,
	imageMapColumn,
} from "@/lib/domain";
import { ColumnEditor } from "../../../ColumnEditor";

vi.mock("@/components/builder/media/MediaSlot", () => ({
	SingleAssetSlot: ({
		slotKey,
		ariaLabel,
		onChange,
	}: {
		slotKey: string;
		ariaLabel: string;
		onChange: (next: string) => void;
	}) => (
		<fieldset aria-label={ariaLabel} data-slot-key={slotKey}>
			<button type="button" onClick={() => onChange("asset-selected")}>
				Choose image
			</button>
		</fieldset>
	),
}));

const TEST_UUID = asUuid("00000000-0000-0000-0000-000000000001");

const PATIENT: CaseType = {
	name: "patient",
	properties: [{ name: "status", label: "Status", data_type: "text" }],
};

function ControlledColumnEditor({ initial }: { initial: Column }) {
	const [value, setValue] = useState(initial);
	return (
		<ColumnEditor
			value={value}
			onChange={(next) => setValue(structuredClone(next))}
			caseTypes={[PATIENT]}
			currentCaseType="patient"
		/>
	);
}

describe("mapping row UI identity", () => {
	it.each([
		[
			"text labels",
			idMappingColumn(TEST_UUID, "status", "Status", [
				{ value: "open", label: "Open" },
			]),
		],
		[
			"images",
			imageMapColumn(TEST_UUID, "status", "Status", [
				{ value: "open", assetId: "asset-open" },
			]),
		],
	] as const)("keeps the focused saved-value input mounted after an Enter commit for %s", (_label, initial) => {
		render(<ControlledColumnEditor initial={initial} />);
		const input = screen.getByLabelText(
			"Value 1 saved value",
		) as HTMLInputElement;

		input.focus();
		fireEvent.change(input, { target: { value: "closed" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(input.isConnected).toBe(true);
		expect(screen.getByLabelText("Value 1 saved value")).toBe(input);
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe("closed");
	});

	it("keeps an image picker's trigger mounted when the selected asset commits", () => {
		render(
			<ControlledColumnEditor
				initial={imageMapColumn(TEST_UUID, "status", "Status", [
					{ value: "open", assetId: "" },
				])}
			/>,
		);
		const trigger = screen.getByRole("button", { name: "Choose image" });
		trigger.focus();

		fireEvent.click(trigger);

		expect(trigger.isConnected).toBe(true);
		expect(screen.getByRole("button", { name: "Choose image" })).toBe(trigger);
		expect(document.activeElement).toBe(trigger);
	});

	it("moves row DOM and staged-media identity with an image mapping entry", () => {
		render(
			<ControlledColumnEditor
				initial={imageMapColumn(TEST_UUID, "status", "Status", [
					{ value: "open", assetId: "asset-open" },
					{ value: "closed", assetId: "asset-closed" },
				])}
			/>,
		);

		const firstInput = screen.getByLabelText("Value 1 saved value");
		const secondInput = screen.getByLabelText("Value 2 saved value");
		const firstMedia = screen.getByRole("group", { name: "Value 1 image" });
		const secondMedia = screen.getByRole("group", { name: "Value 2 image" });
		const firstSlotKey = firstMedia.getAttribute("data-slot-key");
		const secondSlotKey = secondMedia.getAttribute("data-slot-key");

		fireEvent.click(
			screen.getAllByRole("button", { name: /move value .* later/i })[0],
		);

		expect(screen.getByLabelText("Value 1 saved value")).toBe(secondInput);
		expect(screen.getByLabelText("Value 2 saved value")).toBe(firstInput);
		expect(
			screen
				.getByRole("group", { name: "Value 1 image" })
				.getAttribute("data-slot-key"),
		).toBe(secondSlotKey);
		expect(
			screen
				.getByRole("group", { name: "Value 2 image" })
				.getAttribute("data-slot-key"),
		).toBe(firstSlotKey);
	});
});
