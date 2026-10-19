/** Session names bind at parse time; saved reads retain domain entry identity. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	chosen,
	chosenCase,
	chosenCaseDoc,
	chosenCaseProperty,
} from "@/lib/domain/__tests__/chosenCaseFixture";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	formFixture,
	ids,
} from "@/lib/domain/expression/__tests__/formFixture";
import {
	instanceReadsDoc,
	reads,
	setCalculate,
} from "@/lib/domain/expression/__tests__/instanceReadsFixture";
import { eq, literal, prop, term } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { advancedSearchInputDef } from "@/lib/domain/modules";
import type { Uuid } from "@/lib/domain/uuid";
import { runValidation } from "../runner";

const selectedCase: Expression = {
	kind: "term",
	term: {
		kind: "session-datum",
		datum: { kind: "selected-case", module: ids.module },
	},
};
const newCase: Expression = {
	kind: "term",
	term: { kind: "session-datum", datum: { kind: "new-case" } },
};
const slot = { entity: "field", uuid: ids.hidden, slot: "calculate" } as const;
function readDoc(expression: Expression) {
	const doc = formFixture();
	const hidden = doc.fields[ids.hidden];
	if (hidden.kind !== "hidden")
		throw new Error("The calculated fixture is missing.");
	hidden.calculate = expression;
	return doc;
}

describe("session datum admission", () => {
	it.each([
		{
			source: "instance('commcaresession')/session/data/supply_point_id",
			code: "unknown-datum",
		},
		{
			source: "count(instance('commcaresession')/session/data/*)",
			code: "wildcard",
		},
	])(
		"refuses an unbound session path before storing it: $source",
		({ source, code }) => {
			const parsed = parseFormExpression(source, {
				doc: formFixture(),
				slot,
				lookup: "unavailable",
			});
			expect(parsed).toMatchObject({
				ok: false,
				issues: [expect.objectContaining({ code })],
			});
		},
	);
	it("accepts the selected-case identity in a follow-up form", () => {
		expect(
			runValidation(readDoc(selectedCase), LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual([]);
	});
	it("refuses a saved selection when the form no longer opens with one", () => {
		const doc = readDoc(selectedCase);
		doc.forms[ids.form].type = "survey";
		delete doc.forms[ids.form].formLinks;
		const findings = runValidation(
			structuredClone(doc),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			code: "SESSION_DATUM_NOT_SUPPLIED",
			location: { fieldId: "hidden", field: "calculate", formName: "Visit" },
			details: {
				datumKind: "selected-case",
				datumModule: ids.module,
				slot: "calculate",
				carrier: "field",
			},
		});
		expect(userFacingError(findings[0])).toContain(
			'"Visit" no longer opens with that choice',
		);
		expect(userFacingError(findings[0])).not.toContain(ids.module);
	});
	it("does not mistake a several-case datum for one selected value", () => {
		const doc = formFixture();
		const config = doc.modules[ids.module].caseListConfig;
		if (config === undefined)
			throw new Error("The case list fixture is missing.");
		config.selection = { kind: "multiple", maximum: 10 };
		const parsed = parseFormExpression(
			"instance('commcaresession')/session/data/selected_cases",
			{ doc, slot, lookup: "unavailable" },
		);
		expect(parsed).toMatchObject({
			ok: false,
			issues: [expect.objectContaining({ code: "multi-select-datum-value" })],
		});
	});
	it("locates a link's absent datum and offers values the link can read", () => {
		const doc = formFixture();
		const link = doc.forms[ids.form].formLinks?.[0];
		if (link === undefined) throw new Error("The link fixture is missing.");
		link.condition = {
			kind: "eq",
			left: newCase,
			right: { kind: "term", term: { kind: "literal", value: "case-1" } },
		};
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "SESSION_DATUM_NOT_SUPPLIED",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].details).toMatchObject({
			datumKind: "new-case",
			slot: "form_link_condition",
			carrier: "form-link",
		});
		expect(userFacingError(findings[0])).toContain('A link from "Visit"');
		expect(userFacingError(findings[0])).not.toContain("question");
	});
	it("locates an absent datum in a Connect setting", () => {
		const doc = formFixture();
		doc.connectType = "deliver";
		doc.forms[ids.form].connect = {
			deliver_unit: {
				id: "home_visit",
				name: "Home visit",
				entity_id: newCase,
			},
		};
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "SESSION_DATUM_NOT_SUPPLIED",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].details).toMatchObject({
			datumKind: "new-case",
			slot: "deliver_entity_id",
			carrier: "connect",
		});
		expect(userFacingError(findings[0])).toContain(
			'A Connect setting of "Visit"',
		);
	});

	it("reads a several-case form's chosen cases, and refuses the read once the menu chooses one case", () => {
		const chosen: Expression = {
			kind: "count",
			via: { kind: "selected-cases", module: reads.batch },
		};
		const doc = instanceReadsDoc();
		setCalculate(doc, reads.closeProbe, chosen);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const single = structuredClone(doc);
		const config = single.modules[reads.batch].caseListConfig;
		if (config === undefined)
			throw new Error("The case list fixture is missing.");
		delete config.selection;
		const findings = runValidation(single, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(findings).toMatchObject([
			{
				code: "SESSION_DATUM_NOT_SUPPLIED",
				location: { fieldId: "probe", formName: "Close household" },
				details: {
					datumKind: "selected-cases",
					datumModule: reads.batch,
					reason: "selected-cases",
					carrier: "field",
				},
			},
		]);
		expect(userFacingError(findings[0])).toBe(
			'"probe" reads the cases chosen in "Batch", but "Close household" no longer works on cases chosen there, so CommCare can\'t open the form. You can choose the cases before this form again, or read a question instead.',
		);
	});
	it("refuses a link that reads the chosen cases, which only the form's questions read", () => {
		const doc = instanceReadsDoc();
		const link = testUuid("session-data-batch-link");
		doc.forms[reads.close].formLinks = [
			{
				uuid: link,
				target: { type: "module", moduleUuid: reads.batch },
				condition: {
					kind: "gt",
					left: {
						kind: "count",
						via: { kind: "selected-cases", module: reads.batch },
					},
					right: { kind: "term", term: { kind: "literal", value: 1 } },
				},
			},
		];
		doc.forms[reads.close].postSubmit = "app_home";
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "SESSION_DATUM_NOT_SUPPLIED",
		);
		expect(findings).toMatchObject([
			{
				location: { field: "form_link_condition" },
				details: {
					reason: "selected-cases-carrier",
					carrier: "form-link",
					datumModuleName: "Batch",
				},
			},
		]);
		expect(userFacingError(findings[0])).toBe(
			'A link from "Close household" reads the cases chosen in "Batch", which only the form\'s questions can read while it runs. You can save how many there are to a worker detail in the form and read it with #user/ instead.',
		);
	});

	it("admits the link's suggested next step: the count saved to a worker detail, read with #user/", () => {
		const doc = instanceReadsDoc();
		const detail = testUuid("session-data-closed-count");
		doc.userProperties = {
			[detail]: { uuid: detail, slug: "closed_count", label: "Closed count" },
		};
		doc.userPropertyOrder = [detail];
		const probe = doc.fields[reads.closeProbe];
		if (probe.kind !== "hidden") throw new Error("The probe is missing.");
		probe.calculate = {
			kind: "count",
			via: { kind: "selected-cases", module: reads.batch },
		};
		probe.caseWrite = { caseType: "commcare-user", property: "closed_count" };
		const link = testUuid("session-data-batch-link");
		doc.forms[reads.close].formLinks = [
			{ uuid: link, target: { type: "module", moduleUuid: reads.batch } },
		];
		doc.forms[reads.close].postSubmit = "app_home";
		const read = parseFormExpression("#user/closed_count > 1", {
			doc,
			lookup: new Map(),
			slot: {
				entity: "form",
				uuid: reads.close,
				slot: "form_link_condition",
				member: { linkUuid: link },
			},
		});
		if (!read.ok || read.expression === undefined)
			throw new Error("The #user/ read did not parse.");
		const [added] = doc.forms[reads.close].formLinks ?? [];
		if (added === undefined) throw new Error("The link is missing.");
		added.condition = read.expression;
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});
});

describe("the case chosen in an earlier menu, read by a record slot", () => {
	const villageOfHousehold = eq(
		term(prop("member", "village_name")),
		chosenCaseProperty(chosen.households, "household", "village_name"),
	);
	const withFilter = (
		doc: BlueprintDoc,
		module: Uuid,
		filter: Expression,
	): BlueprintDoc => {
		const mod = doc.modules[module];
		doc.modules[module] = {
			...mod,
			caseListConfig: {
				...(mod.caseListConfig ?? caseListConfig([])),
				filter,
			},
		};
		return doc;
	};
	const validate = (doc: BlueprintDoc) =>
		runValidation(structuredClone(doc), LOOKUP_CONTEXT_UNAVAILABLE);

	it("admits a child's case list filter reading the household its entries chose", () => {
		expect(validate(chosenCaseDoc())).toEqual([]);
		expect(
			validate(withFilter(chosenCaseDoc(), chosen.members, villageOfHousehold)),
		).toEqual([]);
	});
	it("refuses the read once the module stops choosing its household first", () => {
		const doc = withFilter(chosenCaseDoc(), chosen.members, villageOfHousehold);
		doc.modules[chosen.members].parentCaseModuleUuid = undefined;
		const [finding, ...rest] = validate(doc);
		expect(rest).toEqual([]);
		expect(finding).toMatchObject({
			code: "SESSION_DATUM_NOT_SUPPLIED",
			details: {
				carrier: "case-list",
				reason: "not-before",
				slotCode: "CASE_LIST_FILTER_TYPE_ERROR",
				datumModuleName: "Households",
			},
		});
		expect(userFacingError(finding)).toBe(
			'The case list of "Members" reads the case chosen in "Households", but "Members" no longer opens after "Households", so CommCare has no chosen case to read there. You can open "Members" from "Households" again, or remove that read.',
		);
	});
	it("refuses a list another module shows with the choice in another place", () => {
		const doc = withFilter(
			chosenCaseDoc(),
			chosen.households,
			eq(term(literal("x")), chosenCase(chosen.villages)),
		);
		const [finding, ...rest] = validate(doc);
		expect(rest).toEqual([]);
		expect(finding).toMatchObject({
			code: "SESSION_DATUM_NOT_SUPPLIED",
			details: { carrier: "case-list", reason: "differs" },
		});
		expect(userFacingError(finding)).toBe(
			'The case list of "Households" reads the case chosen in "Villages", but "Members" also shows this list, and there CommCare keeps that choice in another place, so the read would not find that case. You can remove the read, or give "Members" its own list to choose from.',
		);
		// Without a module choosing through it, Households' list runs in its
		// own entries alone.
		doc.modules[chosen.members].parentCaseModuleUuid = undefined;
		expect(validate(doc)).toEqual([]);
	});
	it("admits the read in an advanced search field's condition", () => {
		const doc = chosenCaseDoc();
		const members = doc.modules[chosen.members];
		doc.modules[chosen.members] = {
			...members,
			caseSearchConfig: {},
			caseListConfig: {
				...(members.caseListConfig ?? caseListConfig([])),
				searchInputs: [
					advancedSearchInputDef(
						testUuid("chosen-search-input"),
						"same_village",
						"Same village",
						"text",
						villageOfHousehold,
					),
				],
			},
		};
		expect(validate(doc)).toEqual([]);
	});
	it("admits a case-first form's display condition and refuses it once the module lists forms first", () => {
		const doc = chosenCaseDoc();
		doc.forms[chosen.memberForm].displayCondition = villageOfHousehold;
		expect(validate(doc)).toEqual([]);
		const registration = testUuid("chosen-member-registration");
		doc.forms[registration] = {
			uuid: registration,
			id: "register_member",
			name: "Register member",
			type: "registration",
		};
		doc.formOrder[chosen.members] = [
			...doc.formOrder[chosen.members],
			registration,
		];
		doc.fieldOrder[registration] = [];
		const findings = validate(doc).filter(
			(finding) => finding.code === "SESSION_DATUM_NOT_SUPPLIED",
		);
		expect(findings).toMatchObject([
			{
				details: { carrier: "form-display-condition", reason: "not-before" },
			},
		]);
		expect(userFacingError(findings[0])).toBe(
			'"Visit member" shows only when the case chosen in "Households" matches, but its menu shows before that case is chosen. You can choose the case before this menu, or base the condition on the worker instead.',
		);
	});
	it("refuses a module's display condition and a several-case menu", () => {
		const menu = chosenCaseDoc();
		menu.modules[chosen.members].displayCondition = villageOfHousehold;
		expect(validate(menu).map((finding) => finding.code)).toContain(
			"MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE",
		);
		const several = withFilter(
			chosenCaseDoc(),
			chosen.members,
			villageOfHousehold,
		);
		several.modules[chosen.households] = {
			...several.modules[chosen.households],
			caseListConfig: {
				...caseListConfig([{ field: "case_name", header: "Name" }]),
				selection: { kind: "multiple", maximum: 3 },
			},
		};
		expect(
			validate(several).find(
				(finding) => finding.code === "SESSION_DATUM_NOT_SUPPLIED",
			),
		).toMatchObject({ details: { reason: "several-cases" } });
	});
});
