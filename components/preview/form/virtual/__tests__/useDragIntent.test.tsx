// @vitest-environment happy-dom

/**
 * useDragIntent smoke tests.
 *
 * The real behavior — placeholder resolution, cycle guard, no-op
 * detection, mutation dispatch — is exercised through the existing
 * `useFormRows` + `dragData` unit suites plus manual drag-drop
 * verification in the browser. These tests only pin the hook's
 * contract-level guarantees: it mounts without throwing inside a
 * realistic provider stack, and its initial state matches what the
 * `VirtualFormList` shell assumes at first render.
 */

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { FormRow } from "../rowModel";
import { useDragIntent } from "../useDragIntent";

/*
 * `useSelect` (consumed by the hook) calls `useConsultEditGuard`, which
 * throws outside `EditGuardProvider`. The guard has nothing to do with
 * drag state at the hook level — stub it to always allow navigation
 * so the smoke test can stand up without the full builder provider
 * stack. Mirrors the pattern in `lib/routing/__tests__`.
 */
vi.mock("@/components/builder/contexts/EditGuardContext", () => ({
	useConsultEditGuard: () => () => true,
}));

// ── Fixture ────────────────────────────────────────────────────────────

const MODULE_UUID = asUuid("module-1-0000-0000-0000-000000000000");
const FORM_UUID = asUuid("form-1-0000-0000-0000-000000000001");

const TEST_DOC: BlueprintDoc = {
	appId: "app-drag-intent",
	appName: "Drag Intent Test",
	connectType: null,
	caseTypes: null,
	modules: {
		[MODULE_UUID]: { uuid: MODULE_UUID, id: "m", name: "M" },
	},
	forms: {
		[FORM_UUID]: {
			uuid: FORM_UUID,
			id: "f",
			name: "F",
			type: "registration",
		},
	},
	fields: {},
	moduleOrder: [MODULE_UUID],
	formOrder: { [MODULE_UUID]: [FORM_UUID] },
	fieldOrder: { [FORM_UUID]: [] },
	fieldParent: {},
};

function wrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider initialDoc={TEST_DOC} appId="app-drag-intent">
			{children}
		</BlueprintDocProvider>
	);
}

/**
 * Thin renderHook-driver that mirrors how `VirtualFormList` actually
 * calls the hook — with a live `baseRowsRef` populated by the parent.
 * The hook reads `baseRowsRef.current` inside `onDrag`, so nothing here
 * needs to fire synchronously for the smoke tests.
 */
function useDragIntentTestHarness() {
	const baseRowsRef = useRef<readonly FormRow[]>([]);
	return useDragIntent({ formUuid: FORM_UUID, baseRowsRef });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("useDragIntent", () => {
	it("starts with dragActive === false", () => {
		const { result } = renderHook(useDragIntentTestHarness, { wrapper });
		expect(result.current.dragActive).toBe(false);
	});

	it("starts with placeholderIndex === null", () => {
		const { result } = renderHook(useDragIntentTestHarness, { wrapper });
		expect(result.current.placeholderIndex).toBeNull();
	});

	it("mounts inside a BlueprintDoc provider without throwing", () => {
		expect(() => {
			renderHook(useDragIntentTestHarness, { wrapper });
		}).not.toThrow();
	});
});
