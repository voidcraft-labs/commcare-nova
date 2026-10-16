// HQ's form builder reads a Save to Case block by name: it searches the
// block's `<case>` at any depth for `create` and `close` (Vellum
// `src/saveToCase.js::parseDataNode`), so a connection or a written property
// of either name would change the case action on the builder's next save.
// These tests hold Nova's gate over the lane's `case-operation-link`
// document, the one whose case change carries a connection.

import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { caseOperationFixture } from "./caseOperationFixture";

function linkDocument(): { doc: BlueprintDoc; operation: CaseOperation } {
	const doc = caseOperationFixture("link");
	const operation = Object.values(doc.forms)
		.flatMap((form) => form.caseOperations ?? [])
		.find((candidate) => (candidate.links ?? []).length > 0);
	if (operation === undefined) throw new Error("Missing the linked change");
	return { doc, operation };
}

describe("names HQ's form builder reads as a case action", () => {
	it("admits the document as it stands", () => {
		expect(
			runValidation(linkDocument().doc, LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual([]);
	});

	it.each([
		["close", "closing the case"],
		["create", "starting a new case"],
	])("refuses a connection named %s, offering q_%s", (identifier, action) => {
		const { doc, operation } = linkDocument();
		const link = operation.links?.[0];
		if (link === undefined) throw new Error("Missing the connection");
		link.identifier = identifier;
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(findings.map((finding) => finding.code)).toEqual([
			"CASE_OPERATION_LINK_INVALID",
		]);
		expect(findings[0]?.details).toMatchObject({
			linkIdentifier: identifier,
			problem: "reads_as_case_action",
			suggestedId: `q_${identifier}`,
		});
		expect(findings[0]?.message).toContain(
			`"${identifier}" is a name CommCare HQ's form builder reads as ${action}. "q_${identifier}" is free here.`,
		);
		link.identifier = `q_${identifier}`;
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("refuses a case change that writes a property named close", () => {
		const { doc, operation } = linkDocument();
		const patient = doc.caseTypes?.find((type) => type.name === "patient");
		const nickname = patient?.properties.find(
			(property) => property.name === "nickname",
		);
		if (patient === undefined || nickname === undefined)
			throw new Error("Missing the patient catalog");
		patient.properties.push({ ...nickname, name: "close" });
		operation.writes = [
			...(operation.writes ?? []),
			{ property: "close", value: term(literal("closed")) },
		];
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(findings.map((finding) => finding.code)).toEqual([
			"CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP",
		]);
		expect(findings[0]?.details).toMatchObject({
			property: "close",
			problem: "closes_case",
		});
	});
});
