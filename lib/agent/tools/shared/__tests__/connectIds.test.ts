// Tests for the SA-path connect-id enforcement helpers.
//
// Covers the explicit-duplicate-rejection arm (previously untested):
//   - `enforceConnectIds` rejects an explicit id that duplicates another
//     block's id (→ `{ ok: false }`, no config), including the
//     order-dependent same-form cross-kind case (learn_module accumulated
//     before assessment is checked);
//   - `collectConnectIdsExcept` counts only mode-matching (live) kinds, so a
//     stray cross-mode block isn't "taken" — matching the UI / emit /
//     validator scopes.

import { describe, expect, it } from "vitest";
import { asUuid, type BlueprintDoc, type ConnectConfig } from "@/lib/domain";
import { collectConnectIdsExcept, enforceConnectIds } from "../connectIds";

const FORM_A = asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const FORM_B = asUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
const MOD = asUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

describe("enforceConnectIds — explicit-duplicate rejection", () => {
	it("rejects an explicit id duplicating another form's id (no config returned)", () => {
		// Another form already uses "intro"; this form's explicit
		// learn_module.id repeats it → fail the call.
		const config: ConnectConfig = {
			learn_module: {
				id: "intro",
				name: "L",
				description: "x",
				time_estimate: 5,
			},
		};
		const result = enforceConnectIds(
			config,
			"Module",
			"Form",
			new Set(["intro"]),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected rejection");
		expect(result.error).toContain("intro");
	});

	it("rejects a same-form cross-kind explicit duplicate (pins the ordering invariant)", () => {
		// learn_module.id === assessment.id in one call. learn_module is
		// accumulated into the taken set before assessment is checked, so the
		// assessment id is caught as a duplicate.
		const config: ConnectConfig = {
			learn_module: {
				id: "dup",
				name: "L",
				description: "x",
				time_estimate: 5,
			},
			assessment: { id: "dup", user_score: "100" },
		};
		const result = enforceConnectIds(config, "Module", "Form", new Set());
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected rejection");
		expect(result.error).toContain("dup");
	});

	it("accepts distinct explicit ids", () => {
		const config: ConnectConfig = {
			learn_module: {
				id: "lm",
				name: "L",
				description: "x",
				time_estimate: 5,
			},
			assessment: { id: "as", user_score: "100" },
		};
		const result = enforceConnectIds(config, "Module", "Form", new Set());
		expect(result.ok).toBe(true);
	});
});

describe("collectConnectIdsExcept — mode-matching scope", () => {
	/** Learn doc: FORM_A has learn_module "intro" + a stray deliver_unit
	 *  "stray"; FORM_B has learn_module "lesson_two". */
	function learnDocWithStray(): BlueprintDoc {
		return {
			appId: "app",
			appName: "n",
			connectType: "learn",
			caseTypes: null,
			modules: { [MOD]: { uuid: MOD, id: "m", name: "M" } },
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
						deliver_unit: { id: "stray", name: "Stray" },
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
			moduleOrder: [MOD],
			formOrder: { [MOD]: [FORM_A, FORM_B] },
			fieldOrder: {},
			fieldParent: {},
		};
	}

	it("counts only live (mode-matching) kinds and excludes the named form", () => {
		const doc = learnDocWithStray();
		// Excluding FORM_A: FORM_B's learn_module "lesson_two" is in scope.
		const scope = collectConnectIdsExcept(doc, FORM_A);
		expect(scope.has("lesson_two")).toBe(true);
		// FORM_A's own ids excluded (it's the edited form).
		expect(scope.has("intro")).toBe(false);
	});

	it("excludes a stray cross-mode block from the taken set", () => {
		const doc = learnDocWithStray();
		// Excluding FORM_B: FORM_A's learn_module "intro" is in scope, but its
		// stray deliver_unit "stray" is NOT (deliver_unit isn't live in learn).
		const scope = collectConnectIdsExcept(doc, FORM_B);
		expect(scope.has("intro")).toBe(true);
		expect(scope.has("stray")).toBe(false);
	});
});
