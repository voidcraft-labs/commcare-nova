/**
 * The case tags of an advanced form: the tag a person adding the action on
 * HQ's case configuration page gets, a held tag kept as held, and every
 * tag distinct with its `case_<tag>` block clear of every root name.
 * Catches a case block appended beside a question of its name, two actions
 * sharing a tag HQ's page refuses, and a published tag renamed.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	advancedCaseBlockName,
	allocateAdvancedTags,
	HQ_CASE_TAG_PATTERN,
} from "@/lib/commcare/advancedTags";
import { CASE_TYPE_REGEX } from "@/lib/commcare/constants";

const load = (caseType: string, held?: string) => ({
	caseType,
	worker: false,
	...(held !== undefined && { held }),
});
const workerLoad = { caseType: "commcare-user", worker: true } as const;

describe("allocateAdvancedTags", () => {
	it("spells each tag by its position, the worker's load last", () => {
		expect(
			allocateAdvancedTags({
				loads: [load("household"), load("patient"), workerLoad],
				opens: [{ caseType: "visit" }, { caseType: "visit" }],
				rootNames: new Set(),
			}),
		).toEqual({
			loads: ["load_household0", "load_patient1", "autoload_commcare_user2"],
			opens: ["open_visit_0", "open_visit_1"],
		});
	});

	it("spells a case type's - as _, so its case block is an element name, and keeps two such types apart", () => {
		const { loads, opens } = allocateAdvancedTags({
			loads: [load("follow-up"), load("follow_up")],
			opens: [{ caseType: "home-visit" }],
			rootNames: new Set(),
		});
		expect(loads).toEqual(["load_follow_up0", "load_follow_up1"]);
		expect(opens).toEqual(["open_home_visit_0"]);
		for (const tag of [...loads, ...opens])
			expect(advancedCaseBlockName(tag)).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
	});

	it("keeps a held tag and steps a derived tag past it", () => {
		expect(
			allocateAdvancedTags({
				loads: [load("patient"), load("patient", "load_patient0")],
				opens: [{ caseType: "visit", held: "parent" }],
				rootNames: new Set(),
			}),
		).toEqual({
			loads: ["load_patient1", "load_patient0"],
			opens: ["parent"],
		});
	});

	it("steps past a tag whose case block a root name holds", () => {
		expect(
			allocateAdvancedTags({
				loads: [load("patient")],
				opens: [{ caseType: "visit" }],
				rootNames: new Set(["case_load_patient0", "case_open_visit_0"]),
			}),
		).toEqual({ loads: ["load_patient1"], opens: ["open_visit_1"] });
	});

	it("keeps two derived tags apart where two case types spell one tag", () => {
		// `load_a1` + `0` and `load_a` + `10` are the same text.
		const loads = [
			load("a1"),
			...Array.from({ length: 9 }, () => load("b")),
			load("a"),
		];
		const tags = allocateAdvancedTags({
			loads,
			opens: [],
			rootNames: new Set(),
		}).loads;
		expect(tags[0]).toBe("load_a10");
		expect(tags[10]).toBe("load_a11");
	});

	it("refuses a case type CommCare does not accept", () => {
		for (const caseType of ["9lives", "a/b"])
			expect(() =>
				allocateAdvancedTags({
					loads: [],
					opens: [{ caseType }],
					rootNames: new Set(),
				}),
			).toThrow(/not a case type CommCare accepts/);
	});

	it("keeps tags distinct, HQ-valid and clear of every root name", () => {
		const caseType = fc.stringMatching(CASE_TYPE_REGEX, { maxLength: 6 });
		fc.assert(
			fc.property(
				fc.array(caseType, { maxLength: 6 }),
				fc.array(caseType, { maxLength: 6 }),
				fc.boolean(),
				fc.array(fc.nat({ max: 8 }), { maxLength: 30 }),
				(loadTypes, openTypes, worker, taken) => {
					const loads = [
						...loadTypes.map((type) => load(type)),
						...(worker ? [workerLoad] : []),
					];
					const opens = openTypes.map((caseType) => ({ caseType }));
					// Root names that take the blocks the derived tags would want.
					const rootNames = new Set([
						...taken.flatMap((n) => [
							...loadTypes.map((type) => `case_load_${type}${n}`),
							...openTypes.map((type) => `case_open_${type}_${n}`),
							`case_autoload_commcare_user${n}`,
						]),
					]);
					const tags = allocateAdvancedTags({ loads, opens, rootNames });
					const all = [...tags.loads, ...tags.opens];
					expect(new Set(all).size).toBe(all.length);
					for (const tag of all) {
						expect(tag).toMatch(HQ_CASE_TAG_PATTERN);
						expect(tag).not.toContain("/");
						expect(rootNames.has(advancedCaseBlockName(tag))).toBe(false);
					}
				},
			),
			{ seed: 20261102 },
		);
	});
});
