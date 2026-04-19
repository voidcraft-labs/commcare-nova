// @vitest-environment happy-dom

/**
 * FieldEditorPanel — composes Data / Logic / Appearance sections for
 * the selected field, driven by the per-kind `fieldEditorSchemas`
 * record.
 *
 * The panel owns the section card chrome. Each `FieldEditorSection`
 * returns null when its entries contribute nothing — the panel's
 * wrapper here respects that null and skips the card so the
 * Data/Appearance labels aren't rendered for structural kinds that
 * have no fields in those sections.
 *
 * The tests mount the panel inside the same provider stack every
 * editor needs (doc + session) and assert on the presence/absence
 * of the section labels "Data" / "Logic" / "Appearance" — the label
 * render is the canonical "this section is live" signal.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { GroupField, TextField } from "@/lib/domain";
import { BuilderSessionProvider } from "@/lib/session/provider";
import { FieldEditorPanel } from "../FieldEditorPanel";

const FIELD_UUID = asUuid("q-panel-0000-0000-0000-000000000000");
const FORM_UUID = asUuid("form-panel-0000-0000-0000-000000000000");
const MODULE_UUID = asUuid("mod-panel-0000-0000-0000-000000000000");

function makeDoc(field: TextField | GroupField): BlueprintDoc {
	return {
		appId: "t",
		appName: "Test",
		connectType: null,
		// Seed a case type so the Data section's CasePropertyEditor has
		// something writable and the Data label renders for text fields.
		caseTypes: [{ name: "patient", properties: [] }],
		modules: {
			[MODULE_UUID]: {
				uuid: MODULE_UUID,
				id: "m",
				name: "M",
				caseType: "patient",
			},
		},
		forms: {
			[FORM_UUID]: { uuid: FORM_UUID, id: "f", name: "F", type: "followup" },
		},
		fields: { [FIELD_UUID]: field },
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
		fieldParent: { [FIELD_UUID]: FORM_UUID },
	};
}

function wrap(doc: BlueprintDoc) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocProvider appId="t" initialDoc={doc}>
				<BuilderSessionProvider>
					<EditGuardProvider>{children}</EditGuardProvider>
				</BuilderSessionProvider>
			</BlueprintDocProvider>
		);
	};
}

// The routing layer reads window.location. Seed a form URL so
// `useSelectedFormContext` (consumed by CasePropertyEditor) has a
// real context to resolve the writable case types from.
function seedFormUrl() {
	window.history.replaceState(null, "", `/build/t/${FORM_UUID}`);
}

describe("FieldEditorPanel", () => {
	it("renders Data, Logic, and Appearance sections for a text field", () => {
		seedFormUrl();
		// Text field with a case-property available + at least one
		// always-addable logic entry (required) + an always-addable
		// UI entry (hint). The section cards only render when their
		// inner FieldEditorSection has *something* to offer, including
		// addable pills, so every section card appears for text.
		const field: TextField = {
			kind: "text",
			uuid: FIELD_UUID,
			id: "name",
			label: "Name",
		};
		render(<FieldEditorPanel field={field} />, {
			wrapper: wrap(makeDoc(field)),
		});
		expect(screen.getByText("Data")).toBeTruthy();
		expect(screen.getByText("Logic")).toBeTruthy();
		expect(screen.getByText("Appearance")).toBeTruthy();
	});

	it("hides Data + Appearance for a group field (only Logic has entries)", () => {
		seedFormUrl();
		// Group's schema has an empty data array + empty ui array and a
		// single logic entry (relevant, hidden-but-addable). The Data
		// and Appearance cards should not render; Logic still shows
		// because the addable pill counts as content.
		const field: GroupField = {
			kind: "group",
			uuid: FIELD_UUID,
			id: "household",
			label: "Household",
		};
		render(<FieldEditorPanel field={field} />, {
			wrapper: wrap(makeDoc(field)),
		});
		expect(screen.queryByText("Data")).toBeNull();
		expect(screen.queryByText("Appearance")).toBeNull();
		expect(screen.getByText("Logic")).toBeTruthy();
	});

	it("hides a section entirely when its entries are all hidden and non-addable", () => {
		// A group field has no data or ui entries — those entire
		// sections should be absent (no label, no card chrome).
		seedFormUrl();
		const field: GroupField = {
			kind: "group",
			uuid: FIELD_UUID,
			id: "group",
			label: "Group",
		};
		const { container } = render(<FieldEditorPanel field={field} />, {
			wrapper: wrap(makeDoc(field)),
		});
		// No "Data" or "Appearance" anywhere.
		expect(container.textContent).not.toContain("Data");
		expect(container.textContent).not.toContain("Appearance");
	});
});
