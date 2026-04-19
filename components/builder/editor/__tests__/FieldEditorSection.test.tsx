// @vitest-environment happy-dom

/**
 * FieldEditorSection — renders one of the Data / Logic / UI sections
 * from a field kind's declarative editor schema.
 *
 * The component partitions entries (via useEntryActivation) into
 * visible editors vs addable pills:
 *   - entries with `visible(field)` truthy or pending activation
 *     render their `component`.
 *   - entries with `visible(field)` falsy AND `addable: true` render
 *     an AddProperty pill; clicking activates the entry and flips it
 *     into the visible bucket on the next render.
 *   - entries with neither stay hidden entirely.
 *
 * The tests use trivial stub entry components (just outputs a DOM
 * marker + captures onChange) so they focus on the section's wiring,
 * not any real editor's internals.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { TextField } from "@/lib/domain";
import type { FieldEditorEntry } from "@/lib/domain/kinds";
import { BuilderSessionProvider } from "@/lib/session/provider";
import { FieldEditorSection } from "../FieldEditorSection";

const FIELD_UUID = asUuid("q-section-0000-0000-0000-000000000000");
const FORM_UUID = asUuid("form-section-0000-0000-0000-000000000000");
const MODULE_UUID = asUuid("mod-section-0000-0000-0000-000000000000");

const baseField: TextField = {
	kind: "text",
	uuid: FIELD_UUID,
	id: "name",
	label: "Name",
};

// Minimal doc that keeps the mutations hook happy — the section
// dispatches updateField on onChange, which walks through the doc
// store even if the test doesn't assert on the resulting state.
const bp: BlueprintDoc = {
	appId: "t",
	appName: "Test",
	connectType: null,
	caseTypes: null,
	modules: { [MODULE_UUID]: { uuid: MODULE_UUID, id: "m", name: "M" } },
	forms: {
		[FORM_UUID]: { uuid: FORM_UUID, id: "f", name: "F", type: "survey" },
	},
	fields: { [FIELD_UUID]: baseField },
	moduleOrder: [MODULE_UUID],
	formOrder: { [MODULE_UUID]: [FORM_UUID] },
	fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
	fieldParent: { [FIELD_UUID]: FORM_UUID },
};

function wrap({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="t" initialDoc={bp}>
			<BuilderSessionProvider>{children}</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}

// ── Stub editor components ──────────────────────────────────────────────
// Each stub advertises its own `keyName` + label so tests can assert on
// which entry rendered. The onClick fires the section's onChange so the
// dispatch path is exercised without depending on a real editor's UI.

type StubProps<K extends string> = {
	value: unknown;
	onChange: (next: unknown) => void;
	label: string;
	keyName: K;
	autoFocus?: boolean;
};

function HintStub(props: StubProps<"hint">) {
	return (
		<button
			type="button"
			data-testid="editor-hint"
			data-autofocus={props.autoFocus ? "true" : "false"}
			onClick={() => props.onChange("new hint")}
		>
			{props.label}
		</button>
	);
}

function ValidateStub(props: StubProps<"validate">) {
	return (
		<div
			data-testid="editor-validate"
			data-autofocus={props.autoFocus ? "true" : "false"}
		>
			{props.label}
		</div>
	);
}

// ── Entry-builder helpers ───────────────────────────────────────────────
// FieldEditorEntry<F> is a discriminated union across F's keys — indexing
// into `["component"]` fails on the union. Cast the full entry literal
// so tests can declare entries without wrestling the generic narrowing.

function hintEntry(
	overrides: Partial<
		Omit<FieldEditorEntry<TextField>, "key" | "component">
	> = {},
): FieldEditorEntry<TextField> {
	return {
		key: "hint",
		component: HintStub as unknown,
		label: "Hint",
		...overrides,
	} as unknown as FieldEditorEntry<TextField>;
}

function validateEntry(
	overrides: Partial<
		Omit<FieldEditorEntry<TextField>, "key" | "component">
	> = {},
): FieldEditorEntry<TextField> {
	return {
		key: "validate",
		component: ValidateStub as unknown,
		label: "Validation",
		...overrides,
	} as unknown as FieldEditorEntry<TextField>;
}

describe("FieldEditorSection", () => {
	it("returns null when no entries are visible and none are addable", () => {
		// Entry has `visible() => false` and no addable flag — section
		// should render absolutely nothing (not even its wrapper).
		const { container } = render(
			<FieldEditorSection
				field={baseField}
				section="ui"
				entries={[hintEntry({ visible: () => false })]}
			/>,
			{ wrapper: wrap },
		);
		expect(container.innerHTML).toBe("");
	});

	it("renders visible entries with their component", () => {
		render(
			<FieldEditorSection
				field={baseField}
				section="ui"
				entries={[hintEntry({ visible: () => true })]}
			/>,
			{ wrapper: wrap },
		);
		expect(screen.getByTestId("editor-hint").textContent).toBe("Hint");
	});

	it("renders an Add pill for an addable hidden entry and no editor", () => {
		render(
			<FieldEditorSection
				field={baseField}
				section="ui"
				entries={[hintEntry({ visible: () => false, addable: true })]}
			/>,
			{ wrapper: wrap },
		);
		expect(screen.queryByTestId("editor-hint")).toBeNull();
		// The add-property pill carries the entry label as its text.
		expect(screen.getByRole("button", { name: /Hint/ })).not.toBeNull();
	});

	it("clicking the Add pill activates the entry and mounts the editor with autoFocus", () => {
		render(
			<FieldEditorSection
				field={baseField}
				section="ui"
				entries={[hintEntry({ visible: () => false, addable: true })]}
			/>,
			{ wrapper: wrap },
		);
		fireEvent.click(screen.getByRole("button", { name: /Hint/ }));
		// After activation the editor takes over with autoFocus=true.
		const editor = screen.getByTestId("editor-hint");
		expect(editor.getAttribute("data-autofocus")).toBe("true");
	});

	it("skips hidden non-addable entries silently", () => {
		// Mix one hidden non-addable with one visible to assert the
		// visible one still renders and the hidden one contributes nothing.
		render(
			<FieldEditorSection
				field={baseField}
				section="logic"
				entries={[
					hintEntry({ visible: () => false }),
					validateEntry({ visible: () => true }),
				]}
			/>,
			{ wrapper: wrap },
		);
		expect(screen.queryByTestId("editor-hint")).toBeNull();
		expect(screen.getByTestId("editor-validate")).not.toBeNull();
	});

	it("does not throw when a visible entry's onChange fires", () => {
		// The stub fires onChange("new hint") on click. If the section's
		// setKey dispatch throws (wrong patch shape, stale ref, etc.) the
		// test fails; no throw = the happy path round-tripped.
		render(
			<FieldEditorSection
				field={baseField}
				section="ui"
				entries={[hintEntry({ visible: () => true })]}
			/>,
			{ wrapper: wrap },
		);
		expect(() =>
			fireEvent.click(screen.getByTestId("editor-hint")),
		).not.toThrow();
	});

	it("does not pass autoFocus to entries that were already visible", () => {
		// autoFocus is reserved for entries that just flipped from
		// hidden → visible via activation. Already-visible entries must
		// render without autoFocus so existing fields don't hijack focus
		// when the panel mounts.
		render(
			<FieldEditorSection
				field={baseField}
				section="ui"
				entries={[hintEntry({ visible: () => true })]}
			/>,
			{ wrapper: wrap },
		);
		expect(
			screen.getByTestId("editor-hint").getAttribute("data-autofocus"),
		).toBe("false");
	});

	it("calls the entry's visible predicate on each render", () => {
		// The visible predicate is evaluated on every render so entries
		// that depend on sibling keys (e.g. validate_msg visible iff
		// validate is set) stay in sync with the field value.
		const visible = vi.fn<(f: TextField) => boolean>(() => true);
		render(
			<FieldEditorSection
				field={baseField}
				section="ui"
				entries={[hintEntry({ visible })]}
			/>,
			{ wrapper: wrap },
		);
		expect(visible.mock.calls.length).toBeGreaterThanOrEqual(1);
	});
});
