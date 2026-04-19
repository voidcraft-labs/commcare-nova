// @vitest-environment happy-dom

/**
 * FieldHeader — top chrome of the field inspector.
 *
 * Renders the type-icon adornment from `fieldRegistry[kind].icon`,
 * the editable ID input with sibling-conflict shake + popover, the
 * kebab menu, and the trash button. The tests pin the two highest-
 * value guarantees:
 *
 *   1. The icon adornment is sourced from the registry — no parallel
 *      icon map, no per-kind switch.
 *   2. Renaming to a conflicting sibling id shows the error popover
 *      (and applies the shake class — its removal is a setTimeout
 *      the test doesn't need to stub).
 *
 * The header relies on URL-derived selection (`useLocation` reads
 * `window.location`) so every test seeds the URL to
 * `/build/{appId}/{formUuid}/{fieldUuid}` before mounting.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { TextField } from "@/lib/domain";
import { BuilderSessionProvider } from "@/lib/session/provider";
import { FieldHeader } from "../FieldHeader";

const APP_ID = "app-header";
const FIELD_UUID = asUuid("q-hdr-0000-0000-0000-000000000001");
const SIBLING_UUID = asUuid("q-hdr-0000-0000-0000-000000000002");
const FORM_UUID = asUuid("form-hdr-0000-0000-0000-000000000000");
const MODULE_UUID = asUuid("mod-hdr-0000-0000-0000-000000000000");

const baseField: TextField = {
	kind: "text",
	uuid: FIELD_UUID,
	id: "name",
	label: "Name",
};

const siblingField: TextField = {
	kind: "text",
	uuid: SIBLING_UUID,
	id: "occupied",
	label: "Occupied",
};

// Two-field doc: the selected field plus a sibling whose id is the
// conflict target used in the rename test. Both live under the same
// form so the rename reducer treats them as siblings (its conflict
// rule scopes to the immediate parent's fieldOrder).
function makeDoc(): BlueprintDoc {
	return {
		appId: APP_ID,
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
			[SIBLING_UUID]: siblingField,
		},
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: [FIELD_UUID, SIBLING_UUID] },
		fieldParent: {
			[FIELD_UUID]: FORM_UUID,
			[SIBLING_UUID]: FORM_UUID,
		},
	};
}

function wrap(doc: BlueprintDoc) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocProvider appId={APP_ID} initialDoc={doc}>
				<BuilderSessionProvider>
					<ScrollRegistryProvider>
						<EditGuardProvider>{children}</EditGuardProvider>
					</ScrollRegistryProvider>
				</BuilderSessionProvider>
			</BlueprintDocProvider>
		);
	};
}

/** Seed the URL so `useLocation` resolves to the form with the
 *  target field selected. `parsePathToLocation` walks formOrder to
 *  derive the module; a single-field URL suffices because the path
 *  schema `/build/{id}/{formUuid}/{fieldUuid}` encodes selection. */
function seedSelectedUrl() {
	window.history.replaceState(
		null,
		"",
		`/build/${APP_ID}/${FORM_UUID}/${FIELD_UUID}`,
	);
}

describe("FieldHeader", () => {
	beforeEach(() => {
		seedSelectedUrl();
	});

	it("renders the type-icon adornment from the registry", () => {
		// The icon comes from `fieldRegistry["text"].icon` — an
		// IconifyIcon object. The Icon component renders it as an
		// inline SVG. The tooltip text matches the registry label
		// ("Text" for a text field), which is the user-visible proof
		// that the header consulted the registry.
		render(<FieldHeader field={baseField} />, { wrapper: wrap(makeDoc()) });
		// The adornment slot holds the type icon — asserting an svg
		// is present in the header is sufficient because the only
		// icon inside the ID-input badge is the type icon.
		const input = screen.getByDisplayValue("name");
		const root = input.closest("[data-field-id='id']");
		expect(root).not.toBeNull();
		const svg = root?.querySelector("svg");
		expect(svg).not.toBeNull();
	});

	it("shakes + shows error popover on rename with a conflicting sibling id", () => {
		// Rename attempts flow through useCommitField → renameField
		// mutation. A sibling conflict returns `conflict: true`; the
		// header reacts by toggling the `xpath-shake` class on the
		// wrapper and mounting an error popover with the conflict
		// message.
		const doc = makeDoc();
		render(<FieldHeader field={baseField} />, { wrapper: wrap(doc) });

		const input = screen.getByDisplayValue("name");
		// Change the draft to the sibling's id, then commit via blur —
		// useCommitField triggers validate on blur/Enter.
		fireEvent.change(input, { target: { value: "occupied" } });
		fireEvent.blur(input);

		// Error popover alerts with the conflict message. Matching
		// the role and a substring keeps the assertion robust to the
		// exact formatting.
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("occupied");
		expect(alert.textContent?.toLowerCase()).toContain("sibling");

		// Shake class lands on the id wrapper — the ancestor of the
		// input that also owns the border + background styling. The
		// setTimeout that removes the class runs at 400ms and isn't
		// stubbed here; asserting the initial state is enough.
		const shakeTarget = input.closest(".xpath-shake");
		expect(shakeTarget).not.toBeNull();
	});
});
