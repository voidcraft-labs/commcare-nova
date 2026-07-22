// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBuilderShortcuts } from "@/components/builder/useBuilderShortcuts";
import { keyboardManager } from "@/lib/ui/keyboardManager";

const state = vi.hoisted(() => ({
	accessPhase: "authorized" as
		| "authorized"
		| "refreshing"
		| "reconnecting"
		| "upgradeRequired"
		| "revoked",
	canEdit: true,
	canRedo: false,
	canUndo: false,
	deleteSelected: vi.fn(),
	docApi: { getState: vi.fn(() => ({})) },
	duplicateField: vi.fn(),
	fieldRefs: [] as Array<{ uuid: string }>,
	getCrossLevelFieldMoveTargets: vi.fn(() => ({})),
	getFieldMoveTargets: vi.fn(() => ({})),
	isReady: true,
	location: { kind: "home" } as { kind: string; [key: string]: unknown },
	moveField: vi.fn(() => ({})),
	notifyMoveRename: vi.fn(),
	previewing: false,
	redo: vi.fn(),
	select: vi.fn(),
	setPending: vi.fn(),
	transitionPreview: vi.fn(),
	undo: vi.fn(),
}));

vi.mock("@/components/builder/contexts/ScrollRegistryContext", () => ({
	useScrollIntoView: () => ({ setPending: state.setPending }),
}));

vi.mock("@/components/builder/usePreviewModeTransition", () => ({
	usePreviewModeTransition: () => state.transitionPreview,
}));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDocApi: () => state.docApi,
}));

vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		duplicateField: state.duplicateField,
		moveField: state.moveField,
	}),
}));

vi.mock("@/lib/doc/hooks/useUndoRedo", () => ({
	useCanRedo: () => state.canRedo,
	useCanUndo: () => state.canUndo,
}));

vi.mock("@/lib/doc/mutations/notify", () => ({
	notifyMoveRename: state.notifyMoveRename,
}));

vi.mock("@/lib/doc/navigation", () => ({
	flattenFieldRefs: () => state.fieldRefs,
	getCrossLevelFieldMoveTargets: () => state.getCrossLevelFieldMoveTargets(),
	getFieldMoveTargets: () => state.getFieldMoveTargets(),
}));

vi.mock("@/lib/routing/builderActions", () => ({
	useDeleteSelectedField: () => state.deleteSelected,
	useUndoRedo: () => ({ undo: state.undo, redo: state.redo }),
}));

vi.mock("@/lib/routing/hooks", () => ({
	useLocation: () => state.location,
	useSelect: () => state.select,
}));

vi.mock("@/lib/session/hooks", () => ({
	useAccessPhase: () => state.accessPhase,
	useBuilderIsReady: () => state.isReady,
	useCanEdit: () => state.canEdit,
	usePreviewing: () => state.previewing,
}));

const REGISTRATION_ID = "builder-shortcuts-test";

function registerBuilderShortcuts() {
	const hook = renderHook(() => useBuilderShortcuts(vi.fn()));
	keyboardManager.register(REGISTRATION_ID, hook.result.current);
	return hook;
}

function dispatchKey(
	key: string,
	options: Omit<KeyboardEventInit, "key"> = {},
) {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...options,
	});
	document.dispatchEvent(event);
	return event;
}

describe("useBuilderShortcuts", () => {
	beforeEach(() => {
		state.accessPhase = "authorized";
		state.canEdit = true;
		state.canRedo = false;
		state.canUndo = false;
		state.fieldRefs = [];
		state.isReady = true;
		state.location = { kind: "home" };
		state.previewing = false;
		for (const value of Object.values(state)) {
			if (typeof value === "function" && "mockClear" in value) {
				value.mockClear();
			}
		}
		state.getCrossLevelFieldMoveTargets.mockReturnValue({});
		state.getFieldMoveTargets.mockReturnValue({});
		state.moveField.mockReturnValue({});
	});

	afterEach(() => {
		keyboardManager.unregister(REGISTRATION_ID);
	});

	it.each([
		["Search", { kind: "search-config", moduleUuid: "module-1" }],
		["Results", { kind: "cases", moduleUuid: "module-1" }],
		["Details", { kind: "detail-config", moduleUuid: "module-1" }],
	])("leaves Tab and Shift+Tab native on the %s workspace", (_name, loc) => {
		state.location = loc;
		registerBuilderShortcuts();

		expect(dispatchKey("Tab").defaultPrevented).toBe(false);
		expect(dispatchKey("Tab", { shiftKey: true }).defaultPrevented).toBe(false);
		expect(state.select).not.toHaveBeenCalled();
		expect(state.setPending).not.toHaveBeenCalled();
	});

	it("declines every conditional builder action when no form action applies", () => {
		state.location = { kind: "cases", moduleUuid: "module-1" };
		registerBuilderShortcuts();

		const events = [
			dispatchKey("Escape"),
			dispatchKey("Tab"),
			dispatchKey("Tab", { shiftKey: true }),
			dispatchKey("Delete"),
			dispatchKey("Backspace"),
			dispatchKey("d", { ctrlKey: true, metaKey: true }),
			dispatchKey("ArrowUp"),
			dispatchKey("ArrowDown"),
			dispatchKey("ArrowUp", { shiftKey: true }),
			dispatchKey("ArrowDown", { shiftKey: true }),
			dispatchKey("z", { ctrlKey: true, metaKey: true }),
			dispatchKey("z", {
				ctrlKey: true,
				metaKey: true,
				shiftKey: true,
			}),
		];

		for (const event of events) expect(event.defaultPrevented).toBe(false);
		expect(state.deleteSelected).not.toHaveBeenCalled();
		expect(state.duplicateField).not.toHaveBeenCalled();
		expect(state.moveField).not.toHaveBeenCalled();
		expect(state.undo).not.toHaveBeenCalled();
		expect(state.redo).not.toHaveBeenCalled();
	});

	it("handles forward and reverse Tab navigation for a selected form field", () => {
		state.location = {
			kind: "form",
			moduleUuid: "module-1",
			formUuid: "form-1",
			selectedUuid: "field-2",
		};
		state.fieldRefs = [
			{ uuid: "field-1" },
			{ uuid: "field-2" },
			{ uuid: "field-3" },
		];
		registerBuilderShortcuts();

		const forward = dispatchKey("Tab");
		const reverse = dispatchKey("Tab", { shiftKey: true });

		expect(forward.defaultPrevented).toBe(true);
		expect(reverse.defaultPrevented).toBe(true);
		expect(state.setPending).toHaveBeenNthCalledWith(
			1,
			"field-3",
			"smooth",
			false,
		);
		expect(state.select).toHaveBeenNthCalledWith(1, "field-3");
		expect(state.setPending).toHaveBeenNthCalledWith(
			2,
			"field-1",
			"smooth",
			false,
		);
		expect(state.select).toHaveBeenNthCalledWith(2, "field-1");
	});

	it("leaves Tab native while Preview is running", () => {
		state.location = {
			kind: "form",
			moduleUuid: "module-1",
			formUuid: "form-1",
			selectedUuid: "missing-field",
		};
		state.fieldRefs = [{ uuid: "field-1" }];
		state.previewing = true;
		registerBuilderShortcuts();

		expect(dispatchKey("Tab").defaultPrevented).toBe(false);
		expect(state.select).not.toHaveBeenCalled();
	});

	it("leaves Tab native for a stale form selection", () => {
		state.location = {
			kind: "form",
			moduleUuid: "module-1",
			formUuid: "form-1",
			selectedUuid: "missing-field",
		};
		state.fieldRefs = [{ uuid: "field-1" }];
		registerBuilderShortcuts();

		expect(dispatchKey("Tab").defaultPrevented).toBe(false);
		expect(state.select).not.toHaveBeenCalled();
	});

	it("handles undo and redo only when their history actions are available", () => {
		state.canRedo = true;
		state.canUndo = true;
		registerBuilderShortcuts();

		const undo = dispatchKey("z", { ctrlKey: true, metaKey: true });
		const redo = dispatchKey("z", {
			ctrlKey: true,
			metaKey: true,
			shiftKey: true,
		});

		expect(undo.defaultPrevented).toBe(true);
		expect(redo.defaultPrevented).toBe(true);
		expect(state.undo).toHaveBeenCalledOnce();
		expect(state.redo).toHaveBeenCalledOnce();
	});

	it.each(["refreshing", "reconnecting"] as const)(
		"disables every builder shortcut while access is %s",
		(accessPhase) => {
			state.accessPhase = accessPhase;
			state.location = {
				kind: "form",
				moduleUuid: "module-1",
				formUuid: "form-1",
				selectedUuid: "field-1",
			};
			state.fieldRefs = [{ uuid: "field-1" }];
			state.canUndo = true;
			registerBuilderShortcuts();

			expect(dispatchKey("p").defaultPrevented).toBe(false);
			expect(dispatchKey("Delete").defaultPrevented).toBe(false);
			expect(
				dispatchKey("z", { ctrlKey: true, metaKey: true }).defaultPrevented,
			).toBe(false);
			expect(state.transitionPreview).not.toHaveBeenCalled();
			expect(state.deleteSelected).not.toHaveBeenCalled();
			expect(state.undo).not.toHaveBeenCalled();
		},
	);

	it("keeps navigation shortcuts for an authorized viewer but removes mutations", () => {
		state.canEdit = false;
		state.canUndo = true;
		state.location = {
			kind: "form",
			moduleUuid: "module-1",
			formUuid: "form-1",
			selectedUuid: "field-1",
		};
		state.fieldRefs = [{ uuid: "field-1" }, { uuid: "field-2" }];
		registerBuilderShortcuts();

		expect(dispatchKey("p").defaultPrevented).toBe(true);
		expect(dispatchKey("Tab").defaultPrevented).toBe(true);
		expect(dispatchKey("Delete").defaultPrevented).toBe(false);
		expect(dispatchKey("ArrowDown").defaultPrevented).toBe(false);
		expect(
			dispatchKey("z", { ctrlKey: true, metaKey: true }).defaultPrevented,
		).toBe(false);
		expect(state.transitionPreview).toHaveBeenCalledOnce();
		expect(state.select).toHaveBeenCalledWith("field-2");
		expect(state.deleteSelected).not.toHaveBeenCalled();
		expect(state.moveField).not.toHaveBeenCalled();
		expect(state.undo).not.toHaveBeenCalled();
	});
});
