// Tests for the SA-path connect-id enforcement helpers.
//
// Covers the explicit-duplicate-rejection arm (previously untested):
//   - `enforceConnectIds` rejects an explicit id that duplicates another
//     block's id (→ `{ ok: false }`, no config), including a same-form,
//     cross-kind duplicate found by the explicit-id reservation pass;
//   - `collectConnectIds` reads every id from complete final configs.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, ConnectConfig } from "@/lib/domain";
import {
	collectConnectIds,
	enforceConnectIds,
	reserveExplicitConnectIds,
} from "../connectIds";

const FORM_A = testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const FORM_B = testUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
const MOD = testUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

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
			"learn",
			"Module",
			"Form",
			new Set(["intro"]),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected rejection");
		expect(result.error).toContain("intro");
	});

	it("rejects a same-form cross-kind explicit duplicate in the reservation pass", () => {
		// learn_module.id === assessment.id in one call. The first pass reserves
		// every stated identity before any omission derives, so the duplicate is
		// rejected independently of derivation order.
		const config: ConnectConfig = {
			learn_module: {
				id: "dup",
				name: "L",
				description: "x",
				time_estimate: 5,
			},
			assessment: { id: "dup", user_score: xp("100") },
		};
		const result = enforceConnectIds(
			config,
			"learn",
			"Module",
			"Form",
			new Set(),
		);
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
			assessment: { id: "as", user_score: xp("100") },
		};
		const result = enforceConnectIds(
			config,
			"learn",
			"Module",
			"Form",
			new Set(),
		);
		expect(result.ok).toBe(true);
	});

	it("reserves a later explicit id before deriving an earlier omitted id", () => {
		const result = enforceConnectIds(
			{
				learn_module: {
					name: "Learning",
					description: "x",
					time_estimate: 5,
				},
				assessment: { id: "learning", user_score: xp("100") },
			},
			"learn",
			"Learning",
			"Assessment",
			new Set(),
		);
		expect(result).toMatchObject({
			ok: true,
			config: {
				learn_module: { id: "learning_2" },
				assessment: { id: "learning" },
			},
		});
	});
});

describe("reserveExplicitConnectIds — complete target preflight", () => {
	it("reserves every present id and reports duplicates without rewriting them", () => {
		const taken = new Set<string>();
		expect(
			reserveExplicitConnectIds(
				{
					learn_module: {
						id: "same",
						name: "L",
						description: "x",
						time_estimate: 5,
					},
					assessment: { id: "same", user_score: xp("100") },
				},
				taken,
			),
		).toEqual([expect.stringContaining('"same" is already used')]);
		expect(taken).toEqual(new Set(["same"]));
	});
});

describe("collectConnectIds — final config scope", () => {
	/** Learn doc: FORM_A has two distinct learn-mode ids; FORM_B has one. */
	function learnDoc(): BlueprintDoc {
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
						assessment: { id: "quiz", user_score: xp("100") },
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
		const doc = learnDoc();
		// Excluding FORM_A: FORM_B's learn_module "lesson_two" is in scope.
		const scope = collectConnectIds(doc, FORM_A);
		expect(scope.has("lesson_two")).toBe(true);
		// FORM_A's own ids excluded (it's the edited form).
		expect(scope.has("intro")).toBe(false);
	});

	it("includes every subkind in a mode-compatible config", () => {
		const doc = learnDoc();
		const scope = collectConnectIds(doc, FORM_B);
		expect(scope.has("intro")).toBe(true);
		expect(scope.has("quiz")).toBe(true);
	});
});
