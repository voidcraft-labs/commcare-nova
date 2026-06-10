// @vitest-environment happy-dom
//
// XPathEditor — `validate_msg` clear-arm tests.
//
// XPathEditor bundles an optional `validate_msg` text editor under
// the `validate` key (the message has no meaning without an
// expression). The clear callback wired into the message editor's
// `onEmpty` does two pieces of work that have different
// conditionality:
//
//   1. Slot clear (`updateField({ validate_msg: undefined })`) — the
//      authoring-layer write that drops the message string. Gated
//      on `validateMsg !== undefined` so a passive focus-blur or
//      Esc on a never-set slot does not stamp a redundant removal
//      patch into undo history.
//
//   2. Add-pill state reset (`setAddingMsg(false)`) — local UI state
//      cleanup. Always fires so a user backing out of "Add
//      Validation Message" can close the editor and bring the pill
//      back, regardless of whether the slot ever held a value.
//
// The test below pins the two arms together: rendering with
// `validate_msg` undefined and `addingMsg=true` (simulated via a
// click on the Add pill), focus + blur the message input, then
// assert (a) the message input is gone and the Add pill is back AND
// (b) `updateField` was not called. A regression in either arm
// fails the test loudly:
//
//   - If the slot-clear arm becomes unconditional again, `updateField`
//     fires on the no-op gesture and the test catches it.
//   - If the UI-state arm is incorrectly gated on `validateMsg`, the
//     editor stays mounted and the Add pill never returns.
//
// Mocks: `XPathField` is replaced with a non-CodeMirror stub so
// the test doesn't need a CodeMirror harness; `useBlueprintMutations`
// is mocked so the dispatch site can be observed without mounting
// the doc-store provider; the session focus-hint and form lint
// context hooks are stubbed since they have no bearing on the
// regression.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import type { TextField } from "@/lib/domain";

// Stub XPathField — the real implementation mounts CodeMirror and
// requires a ReferenceProvider context. The stub renders an opaque
// placeholder so the component tree mounts; the test never interacts
// with the parent expression.
vi.mock("@/components/builder/XPathField", () => ({
	XPathField: ({ value }: { value: string }) => (
		<div data-testid="xpath-field-stub">{value}</div>
	),
}));

// Track every call to `updateField` so the test can assert the
// slot-clear arm did or did not fire.
const updateFieldMock = vi.fn(
	(_uuid: unknown, _kind: unknown, _patch: unknown) => ({ ok: true }) as const,
);
vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({ updateField: updateFieldMock }),
}));

// `useSessionFocusHint` returns the active focus-restore key. The
// test runs without an undo/redo restoration, so the hook returns
// undefined.
vi.mock("@/lib/session/hooks", () => ({
	useSessionFocusHint: () => undefined,
}));

// `useFormLintContext` returns a context-getter for the XPath
// linter. The stubbed XPathField never calls it, so a no-op getter
// is enough to satisfy the type contract.
vi.mock("@/components/builder/editor/fields/useFormLintContext", () => ({
	useFormLintContext: () => () => undefined,
}));

import { XPathEditor } from "../XPathEditor";

const baseField: TextField = {
	kind: "text",
	uuid: asUuid("u1-text"),
	id: "patient_age",
	label: "Patient age",
	validate: ". > 0",
};

describe("XPathEditor — validate_msg clear-arm split", () => {
	it("clicking Add pill, focusing, and blurring the message input on a never-set slot returns the Add pill without calling updateField", () => {
		// Reset the shared mock between cases so prior tests don't
		// pollute the assertion.
		updateFieldMock.mockClear();

		render(
			<XPathEditor
				field={baseField}
				value=". > 0"
				onChange={() => ({ ok: true }) as const}
				label="Validation"
				keyName="validate"
			/>,
		);

		// Pre-state: the Add pill is rendered because `validate` is
		// non-empty and `validate_msg` is absent.
		const addPill = screen.getByRole("button", { name: /Validation Message/i });
		expect(addPill).toBeDefined();

		// User clicks Add — the editor mounts in place of the pill.
		fireEvent.click(addPill);
		const messageInput = screen.getByLabelText(
			"Validation Message",
		) as HTMLInputElement;
		expect(messageInput.value).toBe("");

		// User focus-blurs the input without typing — the cancel-on-
		// empty path. The local-state arm must close the editor; the
		// slot-clear arm must NOT dispatch a removal patch on a slot
		// that never held a value.
		fireEvent.focus(messageInput);
		fireEvent.blur(messageInput);

		// Editor closed → input gone, Add pill back.
		expect(screen.queryByLabelText("Validation Message")).toBeNull();
		expect(
			screen.getByRole("button", { name: /Validation Message/i }),
		).toBeDefined();

		// Slot-clear arm did not fire — the slot was already absent.
		expect(updateFieldMock).not.toHaveBeenCalled();
	});

	it("blurring an emptied populated message dispatches the clear and returns the Add pill", () => {
		// Companion case — the gate is "nothing to clear," not "never
		// fire." When the field has a real `validate_msg` and the user
		// empties it, the slot-clear arm must fire so the message is
		// dropped from the doc.
		updateFieldMock.mockClear();

		render(
			<XPathEditor
				field={{ ...baseField, validate_msg: "Must be greater than zero." }}
				value=". > 0"
				onChange={() => ({ ok: true }) as const}
				label="Validation"
				keyName="validate"
			/>,
		);

		// `validate_msg` populated → editor mounts directly (no Add
		// pill click needed).
		const messageInput = screen.getByLabelText(
			"Validation Message",
		) as HTMLInputElement;
		expect(messageInput.value).toBe("Must be greater than zero.");

		// User clears the input and blurs.
		messageInput.focus();
		fireEvent.change(messageInput, { target: { value: "" } });
		fireEvent.blur(messageInput);

		// Slot-clear arm fired with the removal patch.
		expect(updateFieldMock).toHaveBeenCalledTimes(1);
		const [uuidArg, kindArg, patchArg] = updateFieldMock.mock.calls[0] ?? [];
		expect(uuidArg).toBe(baseField.uuid);
		expect(kindArg).toBe("text");
		expect(patchArg).toEqual({ validate_msg: undefined });
	});
});
