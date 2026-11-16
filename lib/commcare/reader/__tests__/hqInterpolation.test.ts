import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { advancedFixture } from "../../__tests__/advancedPlacementFixture";
import {
	dotInterpolate,
	HQ_USERCASE_XPATH,
	hqCaseByIdXPath,
	hqInterpolationSlot,
	interpolateHqXPath,
	syntaxOf,
} from "../hqInterpolation";
import { DOT_VECTORS, INTERPOLATION_VECTORS } from "./interpolationVectors";

describe("CommCare HQ's interpolation, as its procedure computes it", () => {
	it.each(
		INTERPOLATION_VECTORS.map((vector) => [vector.name, vector] as const),
	)("interpolate_xpath: %s", (_name, vector) => {
		expect(interpolateHqXPath(vector.text, vector.slot)).toEqual(
			vector.expected,
		);
	});

	it.each(DOT_VECTORS.map((vector) => [vector.name, vector] as const))(
		"dot_interpolate: %s",
		(_name, vector) => {
			expect(dotInterpolate(vector.text, vector.replacement)).toBe(
				vector.expected,
			);
		},
	);

	it("spells the usercase and a case by id as HQ's helpers do", () => {
		expect(HQ_USERCASE_XPATH).toBe(
			"instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]",
		);
		expect(hqCaseByIdXPath("current()/index/host")).toBe(
			"instance('casedb')/casedb/case[@case_id=current()/index/host]",
		);
	});
});

describe("syntaxOf", () => {
	it("parses the interpolated text, whose spans the tree indexes", () => {
		const read = syntaxOf("#parent/p = 1", {
			caseXPath: "current()",
			interpolateDots: true,
		});
		if (!read.ok) throw new Error("The text should read.");
		expect(read.text).toBe(
			"instance('casedb')/casedb/case[@case_id=current()/index/parent]/p = 1",
		);
		expect(read.syntax.kind).toBe("binary");
		if (read.syntax.kind !== "binary") return;
		const right = read.syntax.right;
		expect(read.text.slice(right.from, right.to)).toBe("1");
		expect(read.text.slice(read.syntax.left.from, read.syntax.left.to)).toBe(
			"instance('casedb')/casedb/case[@case_id=current()/index/parent]/p",
		);
	});

	it("reads a slot HQ does not interpolate as written", () => {
		const read = syntaxOf("#case/p = 1", undefined);
		expect(read.ok && read.syntax.kind).toBe("binary");
	});

	it("names each refusal", () => {
		expect(syntaxOf("p = ", undefined)).toEqual({
			ok: false,
			reason: "syntax",
		});
		expect(syntaxOf("", undefined)).toEqual({ ok: false, reason: "syntax" });
		expect(syntaxOf("#case/p", { interpolateDots: true })).toEqual({
			ok: false,
			reason: "case-reference",
		});
		expect(
			syntaxOf("$fixture_value = 1", {
				caseXPath: "current()",
				interpolateDots: true,
			}),
		).toEqual({ ok: false, reason: "fixture-value" });
	});
});

describe("hqInterpolationSlot", () => {
	const HOUSEHOLDS = testUuid("interpolation-households");
	const PATIENTS = testUuid("interpolation-patients");
	const VISIT = testUuid("interpolation-visit");
	const REGISTER = testUuid("interpolation-register");
	const doc = buildDoc({
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "patient", parent_type: "household", properties: [] },
		],
		modules: [
			{
				uuid: "interpolation-households",
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "interpolation-register",
						name: "Register",
						type: "registration",
						fields: [],
					},
				],
			},
			{
				uuid: "interpolation-patients",
				name: "Patients",
				caseType: "patient",
				parentCaseModuleUuid: "interpolation-households",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "interpolation-visit",
						name: "Visit",
						type: "followup",
						fields: [],
					},
				],
			},
		],
	});

	it("gives a case list's filter the listed case", () => {
		expect(
			hqInterpolationSlot(
				doc,
				{ entity: "module", uuid: PATIENTS, slot: "case_list_filter" },
				"case",
			),
		).toEqual({ caseXPath: "current()", interpolateDots: true });
	});

	it("gives a form's display condition the case chosen last, not the first", () => {
		const slot = hqInterpolationSlot(
			doc,
			{ entity: "form", uuid: VISIT, slot: "form_display_condition" },
			"case",
		);
		expect(slot?.interpolateDots).toBe(true);
		// The household is chosen first and the patient after it: the
		// patient's datum is the case HQ's build reads `#case` as.
		expect(slot?.caseXPath).toBe(
			hqCaseByIdXPath("instance('commcaresession')/session/data/case_id"),
		);
	});

	it("gives an advanced form's display condition its own last load, not the menu's selection", () => {
		// A follow-up in Members, chosen under a household, of a menu held
		// advanced: the form loads the household and then the member, each
		// under a datum named for its load (`case_id_<tag>`), which is no id
		// the menu's own case list selects under.
		const { doc: advanced, formUuid } = advancedFixture({
			formType: "followup",
			menu: "members",
		});
		const slot = hqInterpolationSlot(
			advanced,
			{ entity: "form", uuid: formUuid, slot: "form_display_condition" },
			"case",
		);
		expect(slot?.caseXPath).toBe(
			hqCaseByIdXPath(
				"instance('commcaresession')/session/data/case_id_load_member1",
			),
		);
	});

	it("answers no slot for a form that chooses no case", () => {
		expect(
			hqInterpolationSlot(
				doc,
				{ entity: "form", uuid: REGISTER, slot: "form_display_condition" },
				"case",
			),
		).toBeUndefined();
	});

	it("reads the two modes with no case path", () => {
		const ref = {
			entity: "module",
			uuid: HOUSEHOLDS,
			slot: "module_display_condition",
		} as const;
		expect(hqInterpolationSlot(doc, ref, "no-case")).toEqual({
			interpolateDots: true,
		});
		expect(hqInterpolationSlot(doc, ref, "no-dots")).toEqual({
			interpolateDots: false,
		});
	});
});
