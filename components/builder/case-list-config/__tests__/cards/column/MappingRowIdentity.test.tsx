// @vitest-environment happy-dom

import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { type ReactElement, type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	type CaseType,
	type Column,
	columnSchema,
	idMappingColumn,
	imageMapColumn,
	type MediaAssetId,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { ColumnEditor } from "../../../ColumnEditor";

// The surfaces here spell authored prose against the document; every production
// mount sits inside the builder's provider. Wrapping at `render` reproduces it
// and carries through each `rerender`.
function DocumentProvider({ children }: { readonly children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="test-app">{children}</BlueprintDocProvider>
	);
}

function render(ui: ReactElement) {
	return rtlRender(ui, { wrapper: DocumentProvider });
}

vi.mock("@/components/builder/media/MediaSlot", () => ({
	SingleAssetSlot: ({
		slotKey,
		ariaLabel,
		onChange,
	}: {
		slotKey: string;
		ariaLabel: string;
		onChange: (next: MediaAssetId) => void;
	}) => (
		<fieldset aria-label={ariaLabel} data-slot-key={slotKey}>
			<button
				type="button"
				onClick={() => onChange(testMediaAssetId("asset-selected"))}
			>
				Choose image
			</button>
		</fieldset>
	),
}));

const TEST_UUID = testUuid("00000000-0000-0000-0000-000000000001");
const ASSET_OPEN = testMediaAssetId("asset-open");
const ASSET_CLOSED = testMediaAssetId("asset-closed");

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "status", label: proseText("Status"), data_type: "text" },
	],
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
	it("keeps a new image mapping local until both value and image are complete", () => {
		const onChange = vi.fn();
		render(
			<ColumnEditor
				value={imageMapColumn(TEST_UUID, "status", "Status", [])}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add value" }));
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Choose image" })).toBeNull();

		fireEvent.change(screen.getByLabelText("Value 1 saved value"), {
			target: { value: "open" },
		});
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Choose image" }));

		const next = onChange.mock.lastCall?.[0] as Column | undefined;
		expect(next?.kind).toBe("image-map");
		if (next?.kind !== "image-map") throw new Error("expected image-map");
		expect(next.mapping).toEqual([
			{
				value: "open",
				assetId: testMediaAssetId("asset-selected"),
			},
		]);
		expect(() => columnSchema.parse(next)).not.toThrow();
	});

	it.each([
		["whitespace", "not open"],
		["a duplicate", "open"],
	] as const)(
		"does not expose an image picker for %s in a pending mapping value",
		(_label, candidate) => {
			const onChange = vi.fn();
			render(
				<ColumnEditor
					value={imageMapColumn(TEST_UUID, "status", "Status", [
						{ value: "open", assetId: ASSET_OPEN },
					])}
					onChange={onChange}
					caseTypes={[PATIENT]}
					currentCaseType="patient"
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "Add value" }));
			fireEvent.change(screen.getByLabelText("Value 2 saved value"), {
				target: { value: candidate },
			});

			expect(screen.queryByRole("group", { name: "Value 2 image" })).toBeNull();
			expect(onChange).not.toHaveBeenCalled();
		},
	);

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
				{ value: "open", assetId: ASSET_OPEN },
			]),
		],
	] as const)(
		"keeps the focused saved-value input mounted after an Enter commit for %s",
		(_label, initial) => {
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
		},
	);

	it("keeps an image picker's trigger mounted when the selected asset commits", () => {
		render(
			<ControlledColumnEditor
				initial={imageMapColumn(TEST_UUID, "status", "Status", [
					{ value: "open", assetId: ASSET_OPEN },
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
					{ value: "open", assetId: ASSET_OPEN },
					{ value: "closed", assetId: ASSET_CLOSED },
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
