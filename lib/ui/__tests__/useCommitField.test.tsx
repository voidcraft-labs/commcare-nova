// @vitest-environment happy-dom

/**
 * useCommitField — the commit/cancel/checkmark model shared by every
 * inline text editor in the builder (EditableText, EditableTitle,
 * InlineField, FieldHeader's id input).
 *
 * The hook owns the interesting branching (draft isolation, blur
 * double-commit guard, Enter/Escape semantics, multiline gating,
 * validate gating, onEmpty routing, the saved-window timer, selectAll
 * on focus). Tests live here so each branch can be exercised without
 * mounting consumer components.
 *
 * Coverage map:
 *   - draft mirrors prop value when blurred; isolates while focused
 *   - commit-on-blur, commit-on-Enter, Escape-cancels (single + multi)
 *   - validate-blocks-save (no onSave, no checkmark)
 *   - onEmpty path triggers on empty commit
 *   - required path swallows empty commit without onSave
 *   - saved flag flips true → false after the timer; cleanup on unmount
 *   - selectAll calls `.select()` synchronously on focus
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCommitField } from "../hooks/useCommitField";

// Lightweight key-event factory — the hook reads only `.key`, `.metaKey`,
// `.ctrlKey`, `.preventDefault`, `.stopPropagation`. Building partial
// React.KeyboardEvent shape and asserting through the cast is cleaner
// than spinning up testing-library's full event simulation.
function key(
	k: string,
	mods: { meta?: boolean; ctrl?: boolean } = {},
): React.KeyboardEvent {
	return {
		key: k,
		metaKey: !!mods.meta,
		ctrlKey: !!mods.ctrl,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as unknown as React.KeyboardEvent;
}

describe("useCommitField — draft display", () => {
	it("mirrors prop value when not focused", () => {
		const { result } = renderHook(() =>
			useCommitField({ value: "alpha", onSave: vi.fn() }),
		);
		expect(result.current.draft).toBe("alpha");
		expect(result.current.focused).toBe(false);
	});

	it("isolates the draft from prop changes while focused", () => {
		// Snapshot taken on focus must not be clobbered by an external
		// `value` change mid-edit — that would silently overwrite the
		// user's in-progress text from an undo or LLM mutation.
		const { result, rerender } = renderHook(
			({ value }) => useCommitField({ value, onSave: vi.fn() }),
			{ initialProps: { value: "alpha" } },
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("alpha-edited"));
		rerender({ value: "external-update" });
		expect(result.current.draft).toBe("alpha-edited");
		// Once blurred, the prop value reasserts itself — undo/redo lands.
		act(() => result.current.handleBlur());
		expect(result.current.draft).toBe("external-update");
	});
});

describe("useCommitField — commit paths", () => {
	it("commits trimmed draft on blur", () => {
		const onSave = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "old", onSave }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("  new  "));
		act(() => result.current.handleBlur());
		expect(onSave).toHaveBeenCalledWith("new");
	});

	it("commits on Enter in single-line mode", () => {
		const onSave = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "old", onSave }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("typed"));
		act(() => result.current.handleKeyDown(key("Enter")));
		expect(onSave).toHaveBeenCalledWith("typed");
	});

	it("plain Enter in multiline mode does NOT commit", () => {
		// Multiline newlines are part of the content; only Cmd/Ctrl+Enter
		// is the commit affordance.
		const onSave = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "", onSave, multiline: true }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("line1"));
		act(() => result.current.handleKeyDown(key("Enter")));
		expect(onSave).not.toHaveBeenCalled();
	});

	it("Cmd/Ctrl+Enter commits in multiline mode", () => {
		const onSave = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "", onSave, multiline: true }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("line1\nline2"));
		act(() => result.current.handleKeyDown(key("Enter", { meta: true })));
		expect(onSave).toHaveBeenCalledWith("line1\nline2");
	});

	it("Escape cancels without firing onSave", () => {
		const onSave = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "old", onSave }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("discarded"));
		act(() => result.current.handleKeyDown(key("Escape")));
		expect(onSave).not.toHaveBeenCalled();
		expect(result.current.focused).toBe(false);
	});

	it("blur after Enter does not double-commit (committedRef guard)", () => {
		// Enter triggers commit which calls .blur() on the input, which
		// fires onBlur. Without the committedRef latch, onSave would fire
		// twice for one logical commit.
		const onSave = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "old", onSave }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("once"));
		act(() => result.current.handleKeyDown(key("Enter")));
		act(() => result.current.handleBlur());
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("does not call onSave when committed value matches the persisted value", () => {
		// No-op commit (trimmed draft equals current value) is a UX no-op:
		// no save, no checkmark, no churn through the reducer.
		const onSave = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "same", onSave }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("same"));
		act(() => result.current.handleBlur());
		expect(onSave).not.toHaveBeenCalled();
	});
});

describe("useCommitField — validate gate", () => {
	it("validate returning false blocks the save", () => {
		const onSave = vi.fn();
		const validate = vi.fn(() => false);
		const { result } = renderHook(() =>
			useCommitField({ value: "old", onSave, validate }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("rejected"));
		act(() => result.current.handleBlur());
		expect(validate).toHaveBeenCalledWith("rejected");
		expect(onSave).not.toHaveBeenCalled();
		expect(result.current.saved).toBe(false);
	});

	it("validate returning true allows the save and triggers the checkmark", () => {
		const onSave = vi.fn();
		const validate = vi.fn(() => true);
		const { result } = renderHook(() =>
			useCommitField({ value: "old", onSave, validate }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("accepted"));
		act(() => result.current.handleBlur());
		expect(onSave).toHaveBeenCalledWith("accepted");
		expect(result.current.saved).toBe(true);
	});
});

describe("useCommitField — empty / required handling", () => {
	it("onEmpty fires when committing an empty trimmed value", () => {
		const onEmpty = vi.fn();
		const onSave = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "old", onSave, onEmpty }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("   "));
		act(() => result.current.handleBlur());
		expect(onEmpty).toHaveBeenCalledTimes(1);
		expect(onSave).not.toHaveBeenCalled();
	});

	it("required: empty commit is swallowed without onSave or onEmpty", () => {
		const onSave = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "old", onSave, required: true }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft(""));
		act(() => result.current.handleBlur());
		expect(onSave).not.toHaveBeenCalled();
	});

	it("cancel on a field that started empty triggers onEmpty (cleanup deletion)", () => {
		// Cancelling an Escape on a previously-empty field should still
		// fire onEmpty so the host can delete the placeholder item rather
		// than leave it dangling.
		const onEmpty = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "", onSave: vi.fn(), onEmpty }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.handleKeyDown(key("Escape")));
		expect(onEmpty).toHaveBeenCalled();
	});
});

describe("useCommitField — saved-window timer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("flips saved=true on commit and back to false 1.5s later", () => {
		const onSave = vi.fn();
		const { result } = renderHook(() =>
			useCommitField({ value: "old", onSave }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("typed"));
		act(() => result.current.handleBlur());
		expect(result.current.saved).toBe(true);
		// Advance to 1500ms — the timer fires inside act() so React state
		// updates flush synchronously.
		act(() => {
			vi.advanceTimersByTime(1500);
		});
		expect(result.current.saved).toBe(false);
	});

	it("unmount cancels the saved timer (no setState-after-unmount)", () => {
		// The cleanup return from the saved-effect must clear the pending
		// timer so no setState lands after unmount.
		const onSave = vi.fn();
		const { result, unmount } = renderHook(() =>
			useCommitField({ value: "old", onSave }),
		);
		act(() => result.current.handleFocus());
		act(() => result.current.setDraft("typed"));
		act(() => result.current.handleBlur());
		expect(result.current.saved).toBe(true);
		unmount();
		// Clearing pending timers is a no-op if cleanup ran. If it didn't,
		// the assertion below would catch a residual scheduled callback —
		// `getTimerCount()` should be 0 immediately after unmount.
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("useCommitField — selectAll on focus", () => {
	// `.select()` runs synchronously inside handleFocus — there is no
	// timer to track, no cleanup needed, no leak path. We assert on the
	// HTMLInputElement.select() call directly via a callback ref that
	// captures the underlying element.

	it("calls .select() synchronously on focus when selectAll is set", () => {
		const { result } = renderHook(() =>
			useCommitField({ value: "v", onSave: vi.fn(), selectAll: true }),
		);
		// Mount a real input through the hook's ref so we can spy on
		// .select(). happy-dom provides a working HTMLInputElement.
		const input = document.createElement("input");
		input.value = "v";
		const selectSpy = vi.spyOn(input, "select");
		result.current.ref(input);
		act(() => result.current.handleFocus());
		expect(selectSpy).toHaveBeenCalledTimes(1);
	});

	it("does NOT call .select() when selectAll is unset", () => {
		const { result } = renderHook(() =>
			useCommitField({ value: "v", onSave: vi.fn() }),
		);
		const input = document.createElement("input");
		input.value = "v";
		const selectSpy = vi.spyOn(input, "select");
		result.current.ref(input);
		act(() => result.current.handleFocus());
		expect(selectSpy).not.toHaveBeenCalled();
	});
});
