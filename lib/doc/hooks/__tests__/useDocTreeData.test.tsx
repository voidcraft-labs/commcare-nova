// @vitest-environment happy-dom

/**
 * Tests for useDocTreeData and useDocHasData.
 *
 * Exercises four scenarios matching the simplified precedence:
 * 1. Empty doc, no partialScaffold → undefined
 * 2. Populated doc → full TreeData with modules/forms/questions
 * 3. Empty doc with partialScaffold → TreeData with module stubs
 * 4. Populated doc (during generation) → derives from doc (no phase check)
 *
 * In the Phase 4 model, scaffold modules are doc entities created by the
 * mutation mapper — so the doc derivation works at ALL phases. The only
 * fallback is `partialScaffold` for the brief pre-scaffold window.
 */

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { assert, describe, expect, it } from "vitest";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useDocTreeData } from "@/lib/doc/hooks/useDocTreeData";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { PartialScaffoldData } from "@/lib/session/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const MOD_UUID = asUuid("module-1-uuid");
const FORM_UUID = asUuid("form-1-uuid");
const Q_AAA = asUuid("q-aaa-0000-0000-0000-000000000000");
const Q_BBB = asUuid("q-bbb-0000-0000-0000-000000000000");

/**
 * Normalized `BlueprintDoc` fixture for tree-derivation tests.
 *
 * Contains one module with one form and two text fields. The `useDocTreeData`
 * hook reads from the normalized entity maps and derives `TreeData` from them
 * directly (no `toBlueprint` conversion needed).
 */
const TEST_DOC: BlueprintDoc = {
	appId: "app-tree-test",
	appName: "Tree Test App",
	connectType: null,
	caseTypes: null,
	modules: {
		[MOD_UUID]: {
			uuid: MOD_UUID,
			id: "registration",
			name: "Registration",
			caseType: "patient",
		},
	},
	forms: {
		[FORM_UUID]: {
			uuid: FORM_UUID,
			id: "intake",
			name: "Intake",
			type: "registration",
		},
	},
	fields: {
		[Q_AAA]: {
			uuid: Q_AAA,
			id: "patient_name",
			kind: "text",
			label: "Patient Name",
		} as BlueprintDoc["fields"][typeof Q_AAA],
		[Q_BBB]: {
			uuid: Q_BBB,
			id: "dob",
			kind: "date",
			label: "Date of Birth",
		} as BlueprintDoc["fields"][typeof Q_BBB],
	},
	moduleOrder: [MOD_UUID],
	formOrder: { [MOD_UUID]: [FORM_UUID] },
	fieldOrder: { [FORM_UUID]: [Q_AAA, Q_BBB] },
	fieldParent: {},
};

const TEST_PARTIAL_SCAFFOLD: PartialScaffoldData = {
	appName: "Streaming App",
	modules: [
		{
			name: "Mod 1",
			case_type: "type_1",
			forms: [{ name: "F1", type: "registration" }],
		},
		{
			name: "Mod 2",
			forms: [{ name: "F2", type: "followup" }],
		},
	],
};

// ── Helpers ─────────────────────────────────────────────────────────────

function setupEmpty() {
	const store = createBlueprintDocStore();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper };
}

function setupPopulated() {
	const store = createBlueprintDocStore();
	store.getState().load(TEST_DOC);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper };
}

// ── useDocTreeData ──────────────────────────────────────────────────────

describe("useDocTreeData", () => {
	it("returns undefined when doc is empty and no partialScaffold", () => {
		const { wrapper } = setupEmpty();
		const { result } = renderHook(() => useDocTreeData(), { wrapper });
		expect(result.current).toBeUndefined();
	});

	it("derives full TreeData from populated doc", () => {
		const { wrapper } = setupPopulated();
		const { result } = renderHook(() => useDocTreeData(), { wrapper });

		const tree = result.current;
		assert(tree);
		expect(tree.app_name).toBe("Tree Test App");
		expect(tree.modules).toHaveLength(1);

		const mod = tree.modules[0];
		expect(mod.name).toBe("Registration");
		expect(mod.case_type).toBe("patient");
		expect(mod.forms).toHaveLength(1);

		const form = mod.forms[0];
		expect(form.name).toBe("Intake");
		expect(form.type).toBe("registration");
		assert(form.questions);
		expect(form.questions).toHaveLength(2);
		expect(form.questions[0].id).toBe("patient_name");
		expect(form.questions[1].id).toBe("dob");
	});

	it("returns partialScaffold TreeData when doc is empty", () => {
		const { wrapper } = setupEmpty();
		const { result } = renderHook(() => useDocTreeData(TEST_PARTIAL_SCAFFOLD), {
			wrapper,
		});

		const tree = result.current;
		assert(tree);
		expect(tree.app_name).toBe("Streaming App");
		expect(tree.modules).toHaveLength(2);
		expect(tree.modules[0].name).toBe("Mod 1");
		expect(tree.modules[0].case_type).toBe("type_1");
		expect(tree.modules[1].name).toBe("Mod 2");
	});

	it("derives from doc even when partialScaffold is provided (doc wins)", () => {
		/* When the doc has modules, the doc derivation takes precedence over
		 * partialScaffold. This happens during generation after setScaffold
		 * creates doc entities — the partial is stale at that point. */
		const { wrapper } = setupPopulated();
		const { result } = renderHook(() => useDocTreeData(TEST_PARTIAL_SCAFFOLD), {
			wrapper,
		});

		const tree = result.current;
		assert(tree);
		/* Doc data wins, not partial scaffold data. */
		expect(tree.app_name).toBe("Tree Test App");
		expect(tree.modules).toHaveLength(1);
		expect(tree.modules[0].name).toBe("Registration");
	});

	it("returns undefined when partialScaffold has empty modules array", () => {
		const { wrapper } = setupEmpty();
		const emptyPartial: PartialScaffoldData = { modules: [] };
		const { result } = renderHook(() => useDocTreeData(emptyPartial), {
			wrapper,
		});
		expect(result.current).toBeUndefined();
	});
});

// ── useDocHasData ───────────────────────────────────────────────────────

describe("useDocHasData", () => {
	it("returns false when doc is empty", () => {
		const { wrapper } = setupEmpty();
		const { result } = renderHook(() => useDocHasData(), { wrapper });
		expect(result.current).toBe(false);
	});

	it("returns true when doc has modules", () => {
		const { wrapper } = setupPopulated();
		const { result } = renderHook(() => useDocHasData(), { wrapper });
		expect(result.current).toBe(true);
	});
});
