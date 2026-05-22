// @vitest-environment happy-dom
//
// Tests for `useAppConnectIds` + `connectIdsExcept` — the app-wide
// Connect-id read backing the authoring uniqueness guard. The hook returns
// every set connect id across the app (located by form + kind); the helper
// derives the "must stay distinct from" set for one editing slot, excluding
// that slot's own id so a re-save isn't a self-conflict.

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
	type AppConnectId,
	connectIdsExcept,
	useAppConnectIds,
} from "@/lib/doc/hooks/useAppConnectIds";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

const MOD_A = asUuid("mod-a");
const MOD_B = asUuid("mod-b");
const FORM_A = asUuid("form-a");
const FORM_B = asUuid("form-b");

/** Learn doc: form A has learn_module "intro" + assessment "intro_quiz";
 *  form B (other module) has learn_module "lesson_two". */
function setup() {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName: "Connect ids",
		connectType: "learn",
		caseTypes: null,
		modules: {
			[MOD_A]: { uuid: MOD_A, id: "a", name: "Module A" },
			[MOD_B]: { uuid: MOD_B, id: "b", name: "Module B" },
		},
		forms: {
			[FORM_A]: {
				uuid: FORM_A,
				id: "form_a",
				name: "Form A",
				type: "survey",
				connect: {
					learn_module: {
						id: "intro",
						name: "Intro",
						description: "x",
						time_estimate: 5,
					},
					assessment: { id: "intro_quiz", user_score: "100" },
				},
			},
			[FORM_B]: {
				uuid: FORM_B,
				id: "form_b",
				name: "Form B",
				type: "survey",
				connect: {
					learn_module: {
						id: "lesson_two",
						name: "Lesson Two",
						description: "x",
						time_estimate: 5,
					},
				},
			},
		},
		fields: {},
		moduleOrder: [MOD_A, MOD_B],
		formOrder: { [MOD_A]: [FORM_A], [MOD_B]: [FORM_B] },
		fieldOrder: {},
		fieldParent: {},
	};
	store.getState().load(doc);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { wrapper };
}

describe("useAppConnectIds", () => {
	it("returns every set connect id across the app, located by form + kind", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useAppConnectIds(), { wrapper });
		expect(result.current).toEqual([
			{ formUuid: FORM_A, kind: "learn_module", id: "intro" },
			{ formUuid: FORM_A, kind: "assessment", id: "intro_quiz" },
			{ formUuid: FORM_B, kind: "learn_module", id: "lesson_two" },
		]);
	});

	it("excludes a cross-mode stray block (only mode-matching kinds count)", () => {
		// A learn app may carry a stray `deliver_unit` (e.g. left on a form
		// after a mode switch). The uniqueness scope must match emit/validator,
		// which only consider mode-matching kinds — so the stray is NOT in the
		// "taken" set (otherwise the UI would reject a duplicate invisible to
		// the rest of the system).
		const store = createBlueprintDocStore();
		store.getState().load({
			appId: "a",
			appName: "n",
			connectType: "learn",
			caseTypes: null,
			modules: { [MOD_A]: { uuid: MOD_A, id: "a", name: "A" } },
			forms: {
				[FORM_A]: {
					uuid: FORM_A,
					id: "form_a",
					name: "Form A",
					type: "survey",
					connect: {
						learn_module: {
							id: "intro",
							name: "Intro",
							description: "x",
							time_estimate: 5,
						},
						// Stray cross-mode block — must be ignored.
						deliver_unit: { id: "stray_deliver", name: "Stray" },
					},
				},
			},
			fields: {},
			moduleOrder: [MOD_A],
			formOrder: { [MOD_A]: [FORM_A] },
			fieldOrder: {},
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BlueprintDocContext.Provider value={store}>
				{children}
			</BlueprintDocContext.Provider>
		);
		const { result } = renderHook(() => useAppConnectIds(), { wrapper });
		expect(result.current).toEqual([
			{ formUuid: FORM_A, kind: "learn_module", id: "intro" },
		]);
		expect(result.current.some((e) => e.id === "stray_deliver")).toBe(false);
	});

	it("returns an empty list for a doc with no connect blocks", () => {
		const store = createBlueprintDocStore();
		store.getState().load({
			appId: "a",
			appName: "n",
			connectType: null,
			caseTypes: null,
			modules: { [MOD_A]: { uuid: MOD_A, id: "a", name: "A" } },
			forms: {},
			fields: {},
			moduleOrder: [MOD_A],
			formOrder: { [MOD_A]: [] },
			fieldOrder: {},
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BlueprintDocContext.Provider value={store}>
				{children}
			</BlueprintDocContext.Provider>
		);
		const { result } = renderHook(() => useAppConnectIds(), { wrapper });
		expect(result.current).toEqual([]);
	});
});

describe("connectIdsExcept", () => {
	const all: AppConnectId[] = [
		{ formUuid: FORM_A, kind: "learn_module", id: "intro" },
		{ formUuid: FORM_A, kind: "assessment", id: "intro_quiz" },
		{ formUuid: FORM_B, kind: "learn_module", id: "lesson_two" },
	];

	it("excludes the editing slot's own id, keeping every other id", () => {
		// Editing FORM_A's learn_module: its own "intro" is excluded (no
		// self-conflict), but the co-located assessment AND the cross-form
		// learn_module are in scope.
		const scope = connectIdsExcept(all, FORM_A, "learn_module");
		expect(scope.has("intro")).toBe(false);
		expect(scope.has("intro_quiz")).toBe(true);
		expect(scope.has("lesson_two")).toBe(true);
	});

	it("a cross-form duplicate is in scope (rejectable by the guard)", () => {
		// Editing FORM_B's learn_module — FORM_A's "intro" is in scope, so
		// typing "intro" here would conflict.
		const scope = connectIdsExcept(all, FORM_B, "learn_module");
		expect(scope.has("intro")).toBe(true);
	});
});
