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

// Two provider layers: the doc store seeds field/form lookups for the
// lint-context walk; the session provider backs useSessionFocusHint.
// RequiredEditor reads both on every render, so both must be mounted
// for the component to render at all.
function wrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="t" initialDoc={bp}>
			<BuilderSessionProvider>{children}</BuilderSessionProvider>
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
});
