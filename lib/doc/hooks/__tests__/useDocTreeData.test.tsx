// @vitest-environment happy-dom

/**
 * Tests for useDocTreeData and useDocHasData.
 *
 * Exercises four scenarios matching the old deriveTreeData precedence:
 * 1. Empty doc, Idle phase → undefined
 * 2. Populated doc, Ready phase → full TreeData with modules/forms/questions
 * 3. Empty doc, Generating phase, partialScaffold → TreeData with module stubs
 * 4. Populated doc, Generating phase, scaffold + partialModules → merged view
 *
 * The doc store is set up via `createBlueprintDocStore().load()` — same
 * pattern as the existing `lib/doc/__tests__/hooks.test.tsx`.
 */

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useDocTreeData } from "@/lib/doc/hooks/useDocTreeData";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { AppBlueprint, Scaffold } from "@/lib/schemas/blueprint";
import { BuilderPhase } from "@/lib/services/builder";
import type { GenerationData } from "@/lib/services/builderStore";

// ── Fixtures ────────────────────────────────────────────────────────────

const TEST_BLUEPRINT: AppBlueprint = {
	app_name: "Tree Test App",
	connect_type: undefined,
	modules: [
		{
			name: "Registration",
			case_type: "patient",
			forms: [
				{
					name: "Intake",
					type: "registration",
					questions: [
						{
							uuid: "q-aaa-0000-0000-0000-000000000000",
							id: "patient_name",
							type: "text",
							label: "Patient Name",
						},
						{
							uuid: "q-bbb-0000-0000-0000-000000000000",
							id: "dob",
							type: "date",
							label: "Date of Birth",
						},
					],
				},
			],
		},
	],
	case_types: null,
};

const TEST_SCAFFOLD: Scaffold = {
	app_name: "Scaffold App",
	description: "Test scaffold",
	connect_type: "",
	modules: [
		{
			name: "Module A",
			case_type: "case_a",
			case_list_only: false,
			purpose: "Module A purpose",
			forms: [
				{
					name: "Form A1",
					type: "registration",
					purpose: "Register",
					formDesign: "basic intake",
				},
				{
					name: "Form A2",
					type: "followup",
					purpose: "Follow up",
					formDesign: "followup design",
				},
			],
		},
		{
			name: "Module B",
			case_type: "case_b",
			case_list_only: false,
			purpose: "Module B purpose",
			forms: [
				{
					name: "Form B1",
					type: "registration",
					purpose: "Register B",
					formDesign: "register B",
				},
			],
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
	store.getState().load(TEST_BLUEPRINT, "app-tree-test");
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper };
}

// ── useDocTreeData ──────────────────────────────────────────────────────

describe("useDocTreeData", () => {
	it("returns undefined when doc is empty and phase is Idle", () => {
		const { wrapper } = setupEmpty();
		const { result } = renderHook(
			() =>
				useDocTreeData({
					phase: BuilderPhase.Idle,
					generationData: undefined,
				}),
			{ wrapper },
		);
		expect(result.current).toBeUndefined();
	});

	it("derives full TreeData from populated doc in Ready phase", () => {
		const { wrapper } = setupPopulated();
		const { result } = renderHook(
			() =>
				useDocTreeData({
					phase: BuilderPhase.Ready,
					generationData: undefined,
				}),
			{ wrapper },
		);

		const tree = result.current;
		expect(tree).toBeDefined();
		expect(tree!.app_name).toBe("Tree Test App");
		expect(tree!.modules).toHaveLength(1);

		const mod = tree!.modules[0];
		expect(mod.name).toBe("Registration");
		expect(mod.case_type).toBe("patient");
		expect(mod.forms).toHaveLength(1);

		const form = mod.forms[0];
		expect(form.name).toBe("Intake");
		expect(form.type).toBe("registration");
		expect(form.questions).toHaveLength(2);
		expect(form.questions![0].id).toBe("patient_name");
		expect(form.questions![1].id).toBe("dob");
	});

	it("returns partialScaffold TreeData during generation with empty doc", () => {
		const { wrapper } = setupEmpty();
		const generationData: GenerationData = {
			partialScaffold: {
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
			},
			partialModules: {},
		};
		const { result } = renderHook(
			() =>
				useDocTreeData({
					phase: BuilderPhase.Generating,
					generationData,
				}),
			{ wrapper },
		);

		const tree = result.current;
		expect(tree).toBeDefined();
		expect(tree!.app_name).toBe("Streaming App");
		expect(tree!.modules).toHaveLength(2);
		expect(tree!.modules[0].name).toBe("Mod 1");
		expect(tree!.modules[1].name).toBe("Mod 2");
	});

	it("returns merged scaffold+partials during generation", () => {
		const { wrapper } = setupEmpty();
		const generationData: GenerationData = {
			scaffold: TEST_SCAFFOLD,
			partialModules: {
				0: {
					caseListColumns: [{ field: "name", header: "Name" }],
					forms: {
						0: {
							name: "Form A1",
							type: "registration",
							questions: [
								{
									uuid: "q-merge-0001",
									id: "field_a",
									type: "text",
									label: "Field A",
								},
							],
						},
					},
				},
			},
		};
		const { result } = renderHook(
			() =>
				useDocTreeData({
					phase: BuilderPhase.Generating,
					generationData,
				}),
			{ wrapper },
		);

		const tree = result.current;
		expect(tree).toBeDefined();
		expect(tree!.app_name).toBe("Scaffold App");
		expect(tree!.modules).toHaveLength(2);

		/* Module 0 has partial data merged in */
		const mod0 = tree!.modules[0];
		expect(mod0.name).toBe("Module A");
		expect(mod0.case_list_columns).toEqual([{ field: "name", header: "Name" }]);
		/* Form A1 has assembled question content from the partial */
		expect(mod0.forms[0].questions).toHaveLength(1);
		expect(mod0.forms[0].questions![0].id).toBe("field_a");
		/* Form A2 is still scaffold-only (no partial) — purpose preserved */
		expect(mod0.forms[1].name).toBe("Form A2");
		expect(mod0.forms[1].purpose).toBe("Follow up");
		expect(mod0.forms[1].questions).toBeUndefined();

		/* Module 1 has no partial — scaffold only */
		const mod1 = tree!.modules[1];
		expect(mod1.name).toBe("Module B");
		expect(mod1.forms[0].name).toBe("Form B1");
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
