// @vitest-environment happy-dom

/**
 * RequiredEditor — declarative editor for the `required` field's
 * tri-state lifecycle (undefined / "true()" / conditional XPath).
 *
 * The component walks `fieldParent` to resolve the owning form for
 * XPath lint context, so every test mounts the editor inside a
 * BlueprintDocProvider that seeds the field in a form. Tests that
 * only assert on the toggle transitions never expand into the
 * XPath editor, so the doc wrapper is mostly for context-lookup
 * safety rather than behavior coverage.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { TextField } from "@/lib/domain";
import { BuilderSessionProvider } from "@/lib/session/provider";
import { RequiredEditor } from "../RequiredEditor";

const FIELD_UUID = asUuid("q-required-0000-0000-0000-000000000000");
const FORM_UUID = asUuid("form-0000-0000-0000-000000000000");
const MODULE_UUID = asUuid("mod-0000-0000-0000-000000000000");

const baseField: TextField = {
	kind: "text",
	uuid: FIELD_UUID,
	id: "name",
	label: "Name",
};

// Minimal doc that wires the field under one form/module so the
// fieldParent walk in RequiredEditor lands on a real form entry.
const bp: BlueprintDoc = {
	appId: "t",
	appName: "Test",
	connectType: null,
	caseTypes: null,
	modules: {
		[MODULE_UUID]: { uuid: MODULE_UUID, id: "m", name: "M" },
	},
	forms: {
		[FORM_UUID]: { uuid: FORM_UUID, id: "f", name: "F", type: "survey" },
	},
	fields: {
		[FIELD_UUID]: baseField,
	},
	moduleOrder: [MODULE_UUID],
	formOrder: { [MODULE_UUID]: [FORM_UUID] },
	fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
	fieldParent: { [FIELD_UUID]: FORM_UUID },
};

// Three provider layers:
//   - BlueprintDocProvider seeds field/form lookups for the
//     lint-context walk.
//   - BuilderSessionProvider backs useSessionFocusHint.
//   - EditGuardProvider is required the moment the nested XPath
//     editor activates (InlineXPathEditor calls useRegisterEditGuard).
function wrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="t" initialDoc={bp}>
			<BuilderSessionProvider>
				<EditGuardProvider>{children}</EditGuardProvider>
			</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}

describe("RequiredEditor", () => {
	it("renders the toggle in the off position when value is undefined", () => {
		render(
			<RequiredEditor
				field={baseField}
				value={undefined}
				onChange={() => {}}
				label="Required"
				keyName="required"
			/>,
			{ wrapper },
		);
		const toggle = screen.getByRole("switch");
		expect(toggle.getAttribute("aria-checked")).toBe("false");
	});

	it("dispatches the always-required sentinel when toggled from off", () => {
		const onChange = vi.fn();
		render(
			<RequiredEditor
				field={baseField}
				value={undefined}
				onChange={onChange}
				label="Required"
				keyName="required"
			/>,
			{ wrapper },
		);
		fireEvent.click(screen.getByRole("switch"));
		expect(onChange).toHaveBeenCalledWith("true()");
	});

	it("dispatches undefined when toggled from on to off", () => {
		const onChange = vi.fn();
		render(
			<RequiredEditor
				field={baseField}
				value="true()"
				onChange={onChange}
				label="Required"
				keyName="required"
			/>,
			{ wrapper },
		);
		fireEvent.click(screen.getByRole("switch"));
		expect(onChange).toHaveBeenCalledWith(undefined);
	});

	it("renders the Add Condition pill when required is true() with no condition", () => {
		render(
			<RequiredEditor
				field={baseField}
				value="true()"
				onChange={() => {}}
				label="Required"
				keyName="required"
			/>,
			{ wrapper },
		);
		// The "Condition" label is the pill's only text.
		expect(screen.getByText("Condition").textContent).toContain("Condition");
	});

	it("mounts the XPath editor when the Condition pill is clicked", () => {
		render(
			<RequiredEditor
				field={baseField}
				value="true()"
				onChange={() => {}}
				label="Required"
				keyName="required"
			/>,
			{ wrapper },
		);
		// Before the click the pill is the only control besides the toggle.
		expect(screen.queryByText("Condition")).not.toBeNull();
		fireEvent.click(screen.getByText("Condition"));
		// Clicking the pill swaps it out for the XPath editor — the
		// pill's text is gone and the condition container is mounted.
		expect(screen.queryByText("Condition")).toBeNull();
		const conditionContainer = document.querySelector(
			'[data-field-id="required_condition"]',
		);
		expect(conditionContainer).not.toBeNull();
	});

	it("renders the condition XPath when value is a non-sentinel expression", () => {
		// Conditional required = any string other than `"true()"`. The
		// XPath editor mounts with the condition value; no Add pill is
		// offered because the condition already exists.
		render(
			<RequiredEditor
				field={baseField}
				value="age > 18"
				onChange={() => {}}
				label="Required"
				keyName="required"
			/>,
			{ wrapper },
		);
		expect(screen.queryByText("Condition")).toBeNull();
		const conditionContainer = document.querySelector(
			'[data-field-id="required_condition"]',
		);
		expect(conditionContainer).not.toBeNull();
	});

	it("dispatches the always-required sentinel when the condition is removed", () => {
		// Removing a condition leaves the toggle on — the value falls
		// back to the sentinel rather than clearing.
		const onChange = vi.fn();
		render(
			<RequiredEditor
				field={baseField}
				value="age > 18"
				onChange={onChange}
				label="Required"
				keyName="required"
			/>,
			{ wrapper },
		);
		fireEvent.click(screen.getByLabelText("Remove condition"));
		expect(onChange).toHaveBeenCalledWith("true()");
	});
});
