/** Session names bind at parse time; saved reads retain domain entry identity. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	formFixture,
	ids,
} from "@/lib/domain/expression/__tests__/formFixture";
import {
	instanceReadsDoc,
	reads,
	setCalculate,
} from "@/lib/domain/expression/__tests__/instanceReadsFixture";
import type { Expression } from "@/lib/domain/expression/types";
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
