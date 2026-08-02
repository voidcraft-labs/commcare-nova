// @vitest-environment happy-dom

/**
 * OptionsEditor adapter + widget behavior.
 *
 * Covers:
 *   - label/value rows render, data-field-id wraps the widget,
 *   - add/remove/edit dispatch the expected lists,
 *   - Add Option keeps the new input focused (regression for the
 *     self-sync focus-loss bug: the commit's echoed prop MUST NOT
 *     regenerate draft ids and unmount the focused input),
 *   - the adapter clamps sub-minimum drafts to `undefined` to
 *     respect the schema's `min(2)` constraint on single/multi
 *     select options.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { focusElement } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	type ProseTemplate,
	proseTemplateText,
	type SelectOptionsSource,
	type SingleSelectField,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { BuilderSessionProvider } from "@/lib/session/provider";
import { OptionsEditor } from "../OptionsEditor";

/* Label editing has its own RefLabelInput coverage. Keep this widget suite
 * focused on option-list semantics without mounting TipTap's deferred DOM
 * observer/timer machinery in every test. */
vi.mock("@/components/builder/RefLabelInput", () => ({
	RefLabelInput: ({
		label,
		value,
		autoFocus,
	}: {
		label: string;
		value: ProseTemplate;
		autoFocus?: boolean;
	}) => (
		<input
			ref={(node) => {
				if (node !== null && autoFocus) node.focus();
			}}
			aria-label={label}
			readOnly
			value={value.parts
				.map((part) => (part.kind === "text" ? part.text : ""))
				.join("")}
		/>
	),
}));

/** Option rows mount `MediaSlot`, whose staged-upload chip reads the
 *  session store and whose attach budget check reads the doc store:
 *  provide both the way the builder always does. */
const wrapper = ({ children }: { children: React.ReactNode }) => (
	<BlueprintDocProvider>
		<BuilderSessionProvider>{children}</BuilderSessionProvider>
	</BlueprintDocProvider>
);

const baseField: SingleSelectField = {
	kind: "single_select",
	uuid: testUuid("u1-options"),
	id: "color",
	label: proseText("Color"),
	optionsSource: {
		kind: "inline",
		options: [
			{
				uuid: testUuid("red-option"),
				value: "red",
				label: proseText("Red"),
			},
			{
				uuid: testUuid("blue-option"),
				value: "blue",
				label: proseText("Blue"),
			},
		],
	},
};

const baseSource = baseField.optionsSource as Extract<
	SelectOptionsSource,
	{ kind: "inline" }
>;

/**
 * Minimal controlled parent: mirrors the real doc-store round-trip
 * where `onChange` eventually feeds back in as the new `value` prop.
 * This exposes bugs that only surface on the echo (the focus-loss
 * regression, for example).
 */
function ControlledOptionsEditor({
	initial,
	onDispatch,
}: {
	initial: SelectOptionsSource;
	onDispatch?: (next: SelectOptionsSource) => void;
}) {
	const [value, setValue] = useState<SelectOptionsSource>(initial);
	return (
		<OptionsEditor
			field={{ ...baseField, optionsSource: value } as SingleSelectField}
			value={value}
			onChange={(next) => {
				setValue(next);
				onDispatch?.(next);
				return { ok: true } as const;
			}}
			label="Options"
			keyName="optionsSource"
		/>
	);
}

describe("OptionsEditor", () => {
	it("renders every option row with its label and value", () => {
		render(
			<OptionsEditor
				field={baseField}
				value={baseSource}
				onChange={() => ({ ok: true }) as const}
				label="Options"
				keyName="optionsSource"
			/>,
			{ wrapper },
		);
		const labelEditors = screen.getAllByRole("textbox", { name: "Label" });
		expect((labelEditors[0] as HTMLInputElement).value).toBe("Red");
		expect((labelEditors[1] as HTMLInputElement).value).toBe("Blue");
	});

	it("wraps the widget in a data-field-id=options container", () => {
		const { container } = render(
			<OptionsEditor
				field={baseField}
				value={baseSource}
				onChange={() => ({ ok: true }) as const}
				label="Options"
				keyName="optionsSource"
			/>,
			{ wrapper },
		);
		expect(container.querySelector('[data-field-id="options"]')).not.toBeNull();
	});

	it("dispatches the expanded list when Add option is clicked", () => {
		const onChange = vi.fn(
			(_next: SelectOptionsSource) => ({ ok: true }) as const,
		);
		render(
			<OptionsEditor
				field={baseField}
				value={baseSource}
				onChange={onChange}
				label="Options"
				keyName="optionsSource"
			/>,
			{ wrapper },
		);
		fireEvent.click(screen.getByRole("button", { name: /Add option/i }));
		expect(onChange).toHaveBeenCalled();
		const next = onChange.mock.calls[0][0];
		expect(next.kind).toBe("inline");
		expect(next.kind === "inline" ? next.options : []).toHaveLength(3);
	});

	it("keeps the new input focused after Add option + parent round-trip", async () => {
		// Controlled harness echoes the dispatched list back as the new
		// prop value, reproducing the real doc-store round-trip. A
		// self-sync regression would regenerate draft ids on the echo,
		// unmount the newly-mounted input, and drop focus.
		render(<ControlledOptionsEditor initial={baseSource} />, {
			wrapper,
		});
		fireEvent.click(screen.getByRole("button", { name: /Add option/i }));
		const labelEditors = screen.getAllByRole("textbox", { name: "Label" });
		expect(labelEditors).toHaveLength(3);
		await waitFor(() => {
			expect(document.activeElement).toBe(labelEditors[2]);
		});
	});

	it("dispatches the updated list when a value is edited and the group blurs", async () => {
		const onChange = vi.fn(
			(_next: SelectOptionsSource) => ({ ok: true }) as const,
		);
		render(
			<OptionsEditor
				field={baseField}
				value={baseSource}
				onChange={onChange}
				label="Options"
				keyName="optionsSource"
			/>,
			{ wrapper },
		);
		const redValue = screen.getByDisplayValue("red");
		focusElement(redValue);
		fireEvent.change(redValue, { target: { value: "crimson" } });
		// Group-blur runs inside rAF; flush the frame inside act so
		// React's state update is observed before we assert.
		const outside = document.createElement("button");
		document.body.append(outside);
		focusElement(outside);
		await act(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);
		outside.remove();
		await waitFor(() => expect(onChange).toHaveBeenCalled());
		const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
		expect(last.kind).toBe("inline");
		if (last.kind !== "inline") throw new Error("expected inline options");
		expect(last.options[0]?.value).toBe("crimson");
		expect(proseTemplateText(last.options[0]?.label)).toBe("Red");
		expect(last.options[1]?.value).toBe("blue");
		expect(proseTemplateText(last.options[1]?.label)).toBe("Blue");
	});

	it("dispatches a shorter list when an option row is removed", () => {
		const onChange = vi.fn(
			(_next: SelectOptionsSource) => ({ ok: true }) as const,
		);
		render(
			<OptionsEditor
				field={{
					...baseField,
					optionsSource: {
						kind: "inline",
						options: [
							...baseSource.options,
							{
								uuid: testUuid("green-option"),
								value: "green",
								label: proseText("Green"),
							},
						],
					},
				}}
				value={{
					kind: "inline",
					options: [
						...baseSource.options,
						{
							uuid: testUuid("green-option"),
							value: "green",
							label: proseText("Green"),
						},
					],
				}}
				onChange={onChange}
				label="Options"
				keyName="optionsSource"
			/>,
			{ wrapper },
		);
		// The per-row trash buttons and the Add button are all
		// descendants of the fieldset; the row buttons come first, the
		// Add button is last. Grab the first one and click it.
		// Query the <fieldset> element directly: the per-option MediaSlot
		// now carries role="group" too, so getByRole("group") is ambiguous.
		const fieldset = document.querySelector("fieldset") as HTMLElement;
		const buttons = fieldset.querySelectorAll("button[type='button']");
		fireEvent.click(buttons[0] as HTMLButtonElement);
		expect(onChange).toHaveBeenCalled();
		const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
		expect(last.kind).toBe("inline");
		if (last.kind !== "inline") throw new Error("expected inline options");
		expect(last.options).toHaveLength(2);
		expect(last.options[0]?.value).toBe("blue");
		expect(proseTemplateText(last.options[0]?.label)).toBe("Blue");
	});

	it("keeps the canonical two-option floor by disabling both remove buttons", () => {
		const onChange = vi.fn(
			(_next: SelectOptionsSource) => ({ ok: true }) as const,
		);
		render(
			<OptionsEditor
				field={baseField}
				value={baseSource}
				onChange={onChange}
				label="Options"
				keyName="optionsSource"
			/>,
			{ wrapper },
		);
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
		expect(onChange).not.toHaveBeenCalled();
	});
});
