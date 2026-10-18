/** Private wire projection: these checks assert expression placement, not the
 * runtime truth values. Native navigation evidence evaluates exported rules. */
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireExpressionContext } from "@/lib/commcare/expressionContext";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import {
	and,
	concat,
	eq,
	gt,
	gte,
	literal,
	lt,
	lte,
	matchAll,
	matchNone,
	neq,
	or,
	prop,
	sessionContext,
	sessionUser,
	term,
} from "@/lib/domain/expression";
import {
	type DisplayConditionCarrier,
	emitFormDisplayConditionForHq as formConditionForHq,
	emitFormDisplayConditionForSuite as formConditionForSuite,
	emitModuleDisplayCondition as moduleCondition,
} from "../displayConditions";

function displayContext(
	carrier: DisplayConditionCarrier,
	owner: "form" | "module",
	caseType = "patient",
) {
	const doc = buildDoc({
		modules: [
			{
				name: "Cases",
				caseType,
				...(owner === "module" ? carrier : {}),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [],
						...(owner === "form" ? carrier : {}),
					},
				],
			},
		],
		caseTypes: [
			{
				name: caseType,
				properties: ["given_name", "x", "nickname", "age"].map((name) => ({
					name,
					label: { parts: [{ kind: "text", text: name }] },
					...(name === "age" ? { data_type: "int" as const } : {}),
				})),
			},
		],
	});
	const module = doc.moduleOrder[0];
	return requireExpressionContext(
		doc,
		owner === "form"
			? {
					entity: "form",
					uuid: doc.formOrder[module][0],
					slot: "form_display_condition",
				}
			: { entity: "module", uuid: module, slot: "module_display_condition" },
	);
}
const emitFormDisplayConditionForHq = (
	carrier: DisplayConditionCarrier,
	caseType?: string,
	selectedCaseDatumId?: string,
) => {
	const condition = formConditionForHq(
		carrier,
		displayContext(carrier, "form", caseType),
		undefined,
		selectedCaseDatumId,
	);
	return (
		condition &&
		serializeWire(condition, { target: "hq-json", interpolation: "case" }).text
	);
};
const emitFormDisplayConditionForSuite = (
	carrier: DisplayConditionCarrier,
	caseType?: string,
	selectedCaseDatumId?: string,
) => {
	const condition = formConditionForSuite(
		carrier,
		displayContext(carrier, "form", caseType),
		undefined,
		selectedCaseDatumId,
	);
	return condition && serializeWire(condition, { target: "suite" }).text;
};
const emitModuleDisplayCondition = (carrier: DisplayConditionCarrier) => {
	const condition = moduleCondition(carrier, displayContext(carrier, "module"));
	return condition && serializeWire(condition, { target: "suite" }).text;
};

const anchor =
	"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/selected_patient]";

describe("navigation expression projection", () => {
	it("anchors nested properties to the supplied datum locally and HQ's case placeholder remotely", () => {
		const condition = eq(
			concat(term(prop("patient", "given_name")), term(literal("!"))),
			literal("Ada!"),
		);
		expect(
			emitFormDisplayConditionForSuite(
				{ displayCondition: condition },
				"patient",
				"selected_patient",
			),
		).toBe(`concat(${anchor}/given_name, '!') = 'Ada!'`);
		expect(
			emitFormDisplayConditionForHq({ displayCondition: condition }, "patient"),
		).toBe("concat(#case/given_name, '!') = 'Ada!'");
	});
	it("keeps reserved metadata as attributes and leaves global terms outside the case anchor", () => {
		const condition = eq(prop("patient", "owner_id"), sessionContext("userid"));
		expect(
			emitFormDisplayConditionForSuite(
				{ displayCondition: condition },
				"patient",
				"selected_patient",
			),
		).toBe(
			`${anchor}/@owner_id = instance('commcaresession')/session/context/userid`,
		);
		// HQ's `#case/` parser takes no attribute, so the HQ JSON reads one
		// through the selected case as the local suite does.
		expect(
			emitFormDisplayConditionForHq(
				{ displayCondition: condition },
				"patient",
				"selected_patient",
			),
		).toBe(
			`${anchor}/@owner_id = instance('commcaresession')/session/context/userid`,
		);
		expect(
			emitModuleDisplayCondition({
				displayCondition: eq(sessionUser("role"), literal("supervisor")),
			}),
		).toBe("instance('commcaresession')/session/user/data/role = 'supervisor'");
	});
	it("reads a property through HQ's case placeholder and an attribute through the selected case's datum", () => {
		const condition = and(
			neq(prop("patient", "x"), literal("")),
			eq(prop("patient", "status"), literal("open")),
		);
		expect(
			emitFormDisplayConditionForHq(
				{ displayCondition: condition },
				"patient",
				"selected_patient",
			),
		).toBe(`#case/x != '' and ${anchor}/@status = 'open'`);
		const withoutAttribute = emitFormDisplayConditionForHq(
			{ displayCondition: neq(prop("patient", "x"), literal("")) },
			"patient",
			"selected_patient",
		);
		expect(withoutAttribute).toBe("#case/x != ''");
		expect(withoutAttribute).not.toContain("instance('casedb')");
	});
	it.each([
		[eq(prop("patient", "nickname"), literal("")), "nickname = ''"],
		[neq(prop("patient", "nickname"), literal("known")), "nickname != 'known'"],
		[eq(prop("patient", "age"), literal(0)), "age = 0"],
		[neq(prop("patient", "age"), literal(0)), "age != 0"],
		[gt(prop("patient", "age"), literal(0)), "age > 0"],
		[gte(prop("patient", "age"), literal(0)), "age >= 0"],
		[lt(prop("patient", "age"), literal(0)), "age < 0"],
		[lte(prop("patient", "age"), literal(0)), "age <= 0"],
	] as const)(
		"emits the raw comparison %j as %s in both dialects",
		(condition, suffix) => {
			expect(
				emitFormDisplayConditionForSuite(
					{ displayCondition: condition },
					"patient",
					"selected_patient",
				),
			).toBe(`${anchor}/${suffix}`);
			expect(
				emitFormDisplayConditionForHq(
					{ displayCondition: condition },
					"patient",
				),
			).toBe(`#case/${suffix}`);
		},
	);
	const worker = eq(sessionContext("userid"), literal("worker"));
	const workerText =
		"instance('commcaresession')/session/context/userid = 'worker'";
	const emitters = [
		emitModuleDisplayCondition,
		emitFormDisplayConditionForSuite,
		emitFormDisplayConditionForHq,
	] as const;

	it("emits nothing for an absent condition or a root always", () => {
		for (const emit of emitters) {
			expect(emit({})).toBeUndefined();
			expect(emit({ displayCondition: matchAll() })).toBeUndefined();
		}
	});

	it("holds every other condition as written, with no clause absorbed", () => {
		for (const emit of emitters) {
			expect(emit({ displayCondition: and(worker, matchNone()) })).toBe(
				`${workerText} and false()`,
			);
			expect(emit({ displayCondition: and(worker, matchAll()) })).toBe(
				`${workerText} and true()`,
			);
			expect(emit({ displayCondition: or(worker, matchAll()) })).toBe(
				`${workerText} or true()`,
			);
		}
	});

	it("writes an item off the menu as false() alone or conjoined with its condition", () => {
		for (const emit of emitters) {
			expect(emit({ hiddenFromMenu: true })).toBe("false()");
			expect(emit({ hiddenFromMenu: true, displayCondition: matchAll() })).toBe(
				"false()",
			);
			expect(emit({ hiddenFromMenu: true, displayCondition: worker })).toBe(
				`false() and ${workerText}`,
			);
			expect(
				emit({
					hiddenFromMenu: true,
					displayCondition: or(worker, eq(sessionUser("role"), literal("x"))),
				}),
			).toBe(
				`false() and (${workerText} or instance('commcaresession')/session/user/data/role = 'x')`,
			);
		}
	});
});
