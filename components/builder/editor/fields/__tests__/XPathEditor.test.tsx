// @vitest-environment happy-dom

/**
 * XPathEditor — generic editor for XPath-valued keys (relevant,
 * validate, default_value, calculate). Wraps XPathField with a label
 * and lint-context plumbing, and bundles the nested validate_msg
 * editor under the special validate key.
 *
 * These tests cover the visible contract: label renders, keyName
 * lands on data-field-id so focus hints route back, and the
 * validate-msg pill appears only when keyName is "validate" and the
 * parent XPath has a value. The underlying XPathField save path is
 * covered in its own tests; duplicating CodeMirror event simulation
 * here would be fragile and redundant.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { TextField } from "@/lib/domain";
import { BuilderSessionProvider } from "@/lib/session/provider";
import { XPathEditor } from "../XPathEditor";

const FIELD_UUID = asUuid("q-xpath-0000-0000-0000-000000000000");
const FORM_UUID = asUuid("form-xpath-0000-0000-0000-000000000000");
const MODULE_UUID = asUuid("mod-xpath-0000-0000-0000-000000000000");

const baseField: TextField = {
	kind: "text",
	uuid: FIELD_UUID,
	id: "name",
	label: "Name",
};

function makeDoc(field: TextField): BlueprintDoc {
	return {
		appId: "t",
		appName: "Test",
		connectType: null,
		caseTypes: null,
		modules: { [MODULE_UUID]: { uuid: MODULE_UUID, id: "m", name: "M" } },
		forms: {
			[FORM_UUID]: { uuid: FORM_UUID, id: "f", name: "F", type: "survey" },
		},
		fields: { [FIELD_UUID]: field },
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
		fieldParent: { [FIELD_UUID]: FORM_UUID },
	};
}

function wrap(field: TextField) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocProvider appId="t" initialDoc={makeDoc(field)}>
				<BuilderSessionProvider>{children}</BuilderSessionProvider>
			</BlueprintDocProvider>
		);
	};
}

describe("XPathEditor", () => {
	it("renders the section label", () => {
		render(
			<XPathEditor
				field={baseField}
				value=""
				onChange={() => {}}
				label="Show When"
				keyName="relevant"
			/>,
			{ wrapper: wrap(baseField) },
		);
		expect(screen.getByText("Show When").textContent).toContain("Show When");
	});

	it("threads keyName to data-field-id on the editor container", () => {
		const { container } = render(
			<XPathEditor
				field={baseField}
				value=""
				onChange={() => {}}
				label="Calculate"
				keyName="calculate"
			/>,
			{ wrapper: wrap(baseField) },
		);
		// The data-field-id element wraps the XPathField — query by attribute
		// rather than by role because CodeMirror's editor surfaces are deep.
		expect(
			container.querySelector('[data-field-id="calculate"]'),
		).not.toBeNull();
	});

	it("shows Validation Message pill when validate has a value and validate_msg is unset", () => {
		const field: TextField = { ...baseField, validate: "true()" };
		render(
			<XPathEditor
				field={field}
				value="true()"
				onChange={() => {}}
				label="Validation"
				keyName="validate"
			/>,
			{ wrapper: wrap(field) },
		);
		expect(screen.getByText("Validation Message").textContent).toContain(
			"Validation Message",
		);
	});

	it("omits Validation Message pill when keyName is not validate", () => {
		render(
			<XPathEditor
				field={baseField}
				value="true()"
				onChange={() => {}}
				label="Calculate"
				keyName="calculate"
			/>,
			{ wrapper: wrap(baseField) },
		);
		expect(screen.queryByText("Validation Message")).toBeNull();
	});

	it("hides Validation Message pill entirely when validate is empty", () => {
		// No value on validate → no need to suggest a message; the message
		// only makes sense after the validation expression exists.
		render(
			<XPathEditor
				field={baseField}
				value=""
				onChange={() => {}}
				label="Validation"
				keyName="validate"
			/>,
			{ wrapper: wrap(baseField) },
		);
		expect(screen.queryByText("Validation Message")).toBeNull();
	});
});
