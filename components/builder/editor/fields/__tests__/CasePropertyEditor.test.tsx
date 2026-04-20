// @vitest-environment happy-dom

/**
 * CasePropertyEditor — declarative editor for the `case_property` key.
 *
 * The component reads two sources: the selected form context (for the
 * module's case type and its child types) and the doc's top-level
 * caseTypes list (for the parent→child lookup). If no form is
 * selected, the editor renders nothing — there's no place for the
 * selection to write back to. The field's kind and id also determine
 * whether the editor renders at all (case_name fields show a disabled
 * name; media fields suppress the dropdown entirely).
 *
 * Because the editor hinges on URL-driven form selection, these tests
 * seed the URL via history.pushState before mounting. The routing
 * hooks read `window.location` on mount.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { TextField } from "@/lib/domain";
import { BuilderSessionProvider } from "@/lib/session/provider";
import {
	CasePropertyDropdown,
	CasePropertyEditor,
} from "../CasePropertyEditor";

const FIELD_UUID = asUuid("q-case-0000-0000-0000-000000000000");
const FORM_UUID = asUuid("form-case-0000-0000-0000-000000000000");
const MODULE_UUID = asUuid("mod-case-0000-0000-0000-000000000000");

const baseField: TextField = {
	kind: "text",
	uuid: FIELD_UUID,
	id: "name",
	label: "Name",
};

function makeDoc(caseType: string | undefined): BlueprintDoc {
	return {
		appId: "app-1",
		appName: "Test",
		connectType: null,
		caseTypes: [{ name: "patient", properties: [] }],
		modules: {
			[MODULE_UUID]: { uuid: MODULE_UUID, id: "m", name: "M", caseType },
		},
		forms: {
			[FORM_UUID]: { uuid: FORM_UUID, id: "f", name: "F", type: "followup" },
		},
		fields: { [FIELD_UUID]: baseField },
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
		fieldParent: { [FIELD_UUID]: FORM_UUID },
	};
}

function wrap(doc: BlueprintDoc) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocProvider appId="app-1" initialDoc={doc}>
				<BuilderSessionProvider>{children}</BuilderSessionProvider>
			</BlueprintDocProvider>
		);
	};
}

// The routing layer reads window.location. Seed the URL to a form
// route so useSelectedFormContext returns a real context in tests
// that want the dropdown to render. Single-segment form URLs
// implicitly derive the module — the parser walks formOrder.
function seedFormUrl() {
	window.history.replaceState(null, "", `/build/app-1/${FORM_UUID}`);
}

function seedHomeUrl() {
	window.history.replaceState(null, "", `/build/app-1`);
}

describe("CasePropertyEditor", () => {
	beforeEach(() => {
		seedHomeUrl();
	});

	it("renders nothing when no form is selected", () => {
		const { container } = render(
			<CasePropertyEditor
				field={baseField}
				value={undefined}
				onChange={() => {}}
				label="Saves to"
				keyName="case_property"
			/>,
			{ wrapper: wrap(makeDoc("patient")) },
		);
		expect(container.innerHTML).toBe("");
	});

	it("renders the dropdown trigger when a writable case type exists", () => {
		seedFormUrl();
		render(
			<CasePropertyEditor
				field={baseField}
				value={undefined}
				onChange={() => {}}
				label="Saves to"
				keyName="case_property"
			/>,
			{ wrapper: wrap(makeDoc("patient")) },
		);
		// Trigger is labeled with the current state — "None" when unset.
		const trigger = screen.getByRole("button", { name: /Saves to/i });
		expect(trigger.textContent ?? "").toContain("None");
	});

	it("dispatches the selected case type when a menu item is clicked", () => {
		seedFormUrl();
		const onChange = vi.fn();
		render(
			<CasePropertyEditor
				field={baseField}
				value={undefined}
				onChange={onChange}
				label="Saves to"
				keyName="case_property"
			/>,
			{ wrapper: wrap(makeDoc("patient")) },
		);
		// Open the menu, then click the "patient" item.
		fireEvent.click(screen.getByRole("button", { name: /Saves to/i }));
		const items = screen.getAllByRole("menuitem");
		// items[0] = None, items[1] = patient
		fireEvent.click(items[1]);
		expect(onChange).toHaveBeenCalledWith("patient");
	});

	it("dispatches undefined when the None menu item is clicked", () => {
		seedFormUrl();
		const onChange = vi.fn();
		render(
			<CasePropertyEditor
				field={baseField}
				value="patient"
				onChange={onChange}
				label="Saves to"
				keyName="case_property"
			/>,
			{ wrapper: wrap(makeDoc("patient")) },
		);
		fireEvent.click(screen.getByRole("button", { name: /Saves to/i }));
		const items = screen.getAllByRole("menuitem");
		fireEvent.click(items[0]);
		expect(onChange).toHaveBeenCalledWith(undefined);
	});

	it("renders a disabled trigger for case_name fields that shows the existing value", () => {
		seedFormUrl();
		const caseNameField: TextField = { ...baseField, id: "case_name" };
		render(
			<CasePropertyEditor
				field={caseNameField}
				value="patient"
				onChange={() => {}}
				label="Saves to"
				keyName="case_property"
			/>,
			{ wrapper: wrap(makeDoc("patient")) },
		);
		const trigger = screen.getByRole("button", { name: /Saves to/i });
		expect(trigger).toHaveProperty("disabled", true);
		expect(trigger.textContent ?? "").toContain("patient");
	});

	it("renders a disabled trigger when the widget is mounted with disabled=true", () => {
		// The MEDIA_TYPES check that disables the dropdown for binary
		// kinds is a widget-level defense — in practice media kinds
		// don't carry `case_property` at all, so the declarative
		// adapter wouldn't mount for them. Drive the widget directly
		// to cover the disabled rendering path.
		render(
			<CasePropertyDropdown
				value={undefined}
				isCaseName={false}
				disabled
				caseTypes={["patient"]}
				onChange={() => {}}
			/>,
		);
		const trigger = screen.getByRole("button", { name: /Saves to/i });
		expect(trigger).toHaveProperty("disabled", true);
	});
});
