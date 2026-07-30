// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid, type SelectOption } from "@/lib/domain";
import { BuilderSessionProvider } from "@/lib/session/provider";
import { OptionsEditorWidget } from "../OptionsEditor";

const wrapper = ({ children }: { children: React.ReactNode }) => (
	<BlueprintDocProvider>
		<BuilderSessionProvider>{children}</BuilderSessionProvider>
	</BlueprintDocProvider>
);

const RED = asUuid("3b806d84-1eb0-405c-af19-782be433f696");
const BLUE = asUuid("ed104049-ffc3-4310-aa8a-6cc8f861bfda");
const GREEN = asUuid("b5bc9e6a-2c29-4ca0-a52d-a479391b514c");

const baseOptions: SelectOption[] = [
	{ uuid: RED, value: "red", label: "Red" },
	{ uuid: BLUE, value: "blue", label: "Blue" },
];

function ControlledWidget({
	initial = baseOptions,
	onDispatch,
}: {
	readonly initial?: SelectOption[];
	readonly onDispatch?: (next: SelectOption[]) => void;
}) {
	const [options, setOptions] = useState(initial);
	return (
		<OptionsEditorWidget
			options={options}
			slotKeyBase="field-options"
			onSave={(next) => {
				setOptions(next);
				onDispatch?.(next);
				return { ok: true };
			}}
		/>
	);
}

describe("OptionsEditorWidget", () => {
	it("renders every canonical inline option", () => {
		render(
			<OptionsEditorWidget
				options={baseOptions}
				slotKeyBase="field-options"
				onSave={() => ({ ok: true })}
			/>,
			{ wrapper },
		);
		expect(screen.getByDisplayValue("Red")).toBeTruthy();
		expect(screen.getByDisplayValue("Blue")).toBeTruthy();
	});

	it("mints a UUID and keeps the added row focused through the parent echo", () => {
		const onDispatch = vi.fn();
		render(<ControlledWidget onDispatch={onDispatch} />, { wrapper });

		fireEvent.click(screen.getByRole("button", { name: "Add option" }));

		const next = onDispatch.mock.calls[0]?.[0] as SelectOption[];
		expect(next).toHaveLength(3);
		expect(next[2]?.uuid).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		const labels = screen.getAllByPlaceholderText("Label");
		expect(document.activeElement).toBe(labels[2]);
	});

	it("preserves identity when editing a label", async () => {
		const onDispatch = vi.fn();
		render(<ControlledWidget onDispatch={onDispatch} />, { wrapper });
		const red = screen.getByDisplayValue("Red");
		fireEvent.focus(red);
		fireEvent.change(red, { target: { value: "Crimson" } });
		fireEvent.blur(red);
		await act(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);

		const next = onDispatch.mock.calls.at(-1)?.[0] as SelectOption[];
		expect(next[0]).toMatchObject({
			uuid: RED,
			value: "red",
			label: "Crimson",
		});
	});

	it("keeps the valid two-option floor by disabling both remove buttons", () => {
		render(<ControlledWidget />, { wrapper });
		expect(
			screen
				.getByRole("button", { name: "Remove Red" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen
				.getByRole("button", { name: "Remove Blue" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("removes one option from a three-option source", () => {
		const onDispatch = vi.fn();
		render(
			<ControlledWidget
				initial={[
					...baseOptions,
					{ uuid: GREEN, value: "green", label: "Green" },
				]}
				onDispatch={onDispatch}
			/>,
			{ wrapper },
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove Red" }));
		const next = onDispatch.mock.calls.at(-1)?.[0] as SelectOption[];
		expect(next.map((option) => option.uuid)).toEqual([BLUE, GREEN]);
	});
});
