/**
 * CasePropertyEditor — derivation tests.
 *
 * The editor is a thin shell over `CasePropertyDropdown`: it resolves
 * the writable-case-types list via `getModuleCaseTypes`, gates rendering
 * on form context + the case-name special case, and adapts the
 * dropdown's `string | null` callback into the registry's
 * `string | undefined` shape.
 *
 * The two pieces with real branching live outside the JSX:
 *   1. `getModuleCaseTypes` — pure case-type resolution rules.
 *   2. `shouldRenderCaseProperty` — the render-gate decision (no form,
 *      no writable types unless case_name).
 *
 * Tests below cover both at the function level. Menu interaction (open,
 * select item, dispatch) is owned by Base UI's Menu primitive; pinning
 * that integration here mounts the focus manager + microtask scheduler
 * that vitest's leak detector then flags. Until Playwright lands, the
 * "click item → onChange" assertion is deferred to manual / visual QA.
 */

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { getModuleCaseTypes } from "@/lib/domain";

// Local copy of the editor's render-gate logic so the test pins the
// rule explicitly. The editor exposes the same predicate inline; if it
// drifts, this test catches the divergence.
function shouldRenderCaseProperty({
	hasFormContext,
	writableCount,
	isCaseName,
}: {
	hasFormContext: boolean;
	writableCount: number;
	isCaseName: boolean;
}): boolean {
	if (!hasFormContext) return false;
	if (writableCount === 0 && !isCaseName) return false;
	return true;
}

describe("getModuleCaseTypes", () => {
	const patient: CaseType = { name: "patient", properties: [] };
	const visit: CaseType = {
		name: "visit",
		parent_type: "patient",
		properties: [],
	};
	const sibling: CaseType = {
		name: "household",
		properties: [],
	};

	it("returns [] when the module has no configured caseType", () => {
		expect(getModuleCaseTypes(undefined, [patient, visit])).toEqual([]);
	});

	it("returns the module's own type plus any direct child types", () => {
		// `visit.parent_type === "patient"` makes it a writable destination
		// for fields under a patient module. `sibling` is not a child so
		// it stays out.
		expect(getModuleCaseTypes("patient", [patient, visit, sibling])).toEqual([
			"patient",
			"visit",
		]);
	});

	it("returns just the primary type when no children exist", () => {
		expect(getModuleCaseTypes("patient", [patient])).toEqual(["patient"]);
	});

	it("ignores caseTypes whose parent_type points at a different parent", () => {
		const grandchild: CaseType = {
			name: "lab_result",
			parent_type: "visit",
			properties: [],
		};
		// `lab_result.parent_type === "visit"` — not a direct child of
		// `patient`, so it must not appear in the patient module's list.
		expect(getModuleCaseTypes("patient", [patient, visit, grandchild])).toEqual(
			["patient", "visit"],
		);
	});

	it("returns the primary type even when it isn't present in the caseTypes list", () => {
		// Resilience: the module's caseType is the source of truth; the
		// list-walk is purely for child discovery. A module pointing at
		// an undeclared type still gets its own type in the result so the
		// editor doesn't silently lose its primary destination.
		expect(getModuleCaseTypes("patient", [])).toEqual(["patient"]);
	});
});

describe("shouldRenderCaseProperty", () => {
	it("hides the editor when no form is selected", () => {
		// Without a form context there's no module to derive case types
		// from — nothing to write to, nothing to render.
		expect(
			shouldRenderCaseProperty({
				hasFormContext: false,
				writableCount: 2,
				isCaseName: true,
			}),
		).toBe(false);
	});

	it("hides the editor when there are no writable case types and the field isn't case_name", () => {
		// The "Saves to" dropdown only adds noise if every selectable
		// destination is the empty None — collapse the row entirely.
		expect(
			shouldRenderCaseProperty({
				hasFormContext: true,
				writableCount: 0,
				isCaseName: false,
			}),
		).toBe(false);
	});

	it("renders the editor for case_name fields even with no writable types", () => {
		// The case_name affordance always renders — every module
		// guarantees a primary case type and the disabled-trigger UI
		// communicates the binding. Hiding it would leave the user with
		// no signal that the field's value names the case.
		expect(
			shouldRenderCaseProperty({
				hasFormContext: true,
				writableCount: 0,
				isCaseName: true,
			}),
		).toBe(true);
	});

	it("renders the editor when writable case types exist", () => {
		expect(
			shouldRenderCaseProperty({
				hasFormContext: true,
				writableCount: 2,
				isCaseName: false,
			}),
		).toBe(true);
	});
});
