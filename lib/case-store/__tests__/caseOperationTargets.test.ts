import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	buildCaseTypeMap,
	validateCaseOperationTargetDescriptor,
	validateResolvedCaseOperationTypeSequence,
} from "@/lib/case-store";
import { asUuid } from "@/lib/doc/types";
import type { Form } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";

describe("case-operation runtime target descriptors", () => {
	const expected = {
		projectId: "project-a",
		snapshotCaseType: "patient",
	};

	it("accepts only an exact tenant-bound type descriptor", () => {
		expect(
			validateCaseOperationTargetDescriptor(
				{ caseId: "case-1" },
				{ caseId: "case-1", caseType: "patient", projectId: "project-a" },
				expected,
			),
		).toEqual({
			ok: true,
			descriptor: {
				caseId: "case-1",
				caseType: "patient",
				projectId: "project-a",
			},
		});
	});

	it("collapses malformed and foreign-tenant ids to one opaque verdict", () => {
		for (const [request, resolved] of [
			[
				{ caseId: "case-1" },
				{ caseId: "case-1", caseType: "patient", projectId: "project-b" },
			],
			[
				{ caseId: "case-1" },
				{ caseId: "case-2", caseType: "patient", projectId: "project-a" },
			],
			[{ caseId: "" }, null],
			[{ caseId: "case-1" }, null],
		]) {
			expect(
				validateCaseOperationTargetDescriptor(request, resolved, expected),
			).toEqual({ ok: false, reason: "not-found-or-out-of-scope" });
		}
	});

	it("never treats a client-asserted tenant/type descriptor as authority", () => {
		expect(
			validateCaseOperationTargetDescriptor(
				{
					caseId: "case-1",
					caseType: "patient",
					projectId: "project-a",
				},
				null,
				expected,
			),
		).toEqual({ ok: false, reason: "not-found-or-out-of-scope" });
	});

	it("distinguishes a type mismatch only after tenant authorization", () => {
		expect(
			validateCaseOperationTargetDescriptor(
				{ caseId: "case-1" },
				{ caseId: "case-1", caseType: "visit", projectId: "project-a" },
				expected,
			),
		).toEqual({ ok: false, reason: "case-type-mismatch" });
	});

	it("folds resolved ids so runtime aliases cannot bypass a prior retype", () => {
		expect(
			validateResolvedCaseOperationTypeSequence([
				{
					operationUuid: "promote",
					action: "update",
					target: { caseId: "same-case", snapshotCaseType: "patient" },
					expectedCaseType: "patient",
					resultCaseType: "visit",
				},
				{
					operationUuid: "stale-expression-alias",
					action: "update",
					target: { caseId: "same-case", snapshotCaseType: "patient" },
					expectedCaseType: "patient",
				},
			]),
		).toEqual({
			ok: false,
			reason: "rolling-case-type-mismatch",
			operationUuid: "stale-expression-alias",
			slot: "target",
			expectedCaseType: "patient",
			actualCaseType: "visit",
		});
	});

	it("checks link aliases before installing the operation result type", () => {
		expect(
			validateResolvedCaseOperationTypeSequence([
				{
					operationUuid: "promote",
					action: "update",
					target: { caseId: "patient-1", snapshotCaseType: "patient" },
					expectedCaseType: "patient",
					resultCaseType: "visit",
				},
				{
					operationUuid: "link-stale-alias",
					action: "update",
					target: { caseId: "patient-2", snapshotCaseType: "patient" },
					expectedCaseType: "patient",
					links: [
						{
							slot: "related",
							target: {
								caseId: "patient-1",
								snapshotCaseType: "patient",
							},
							expectedCaseType: "patient",
						},
					],
				},
			]),
		).toMatchObject({
			ok: false,
			reason: "rolling-case-type-mismatch",
			operationUuid: "link-stale-alias",
			slot: "link:related",
			actualCaseType: "visit",
		});
	});

	it("rejects a runtime expression link that resolves back to the operation case", () => {
		expect(
			validateResolvedCaseOperationTypeSequence([
				{
					operationUuid: "dynamic-self-link",
					action: "update",
					target: {
						caseId: "same-resolved-case",
						snapshotCaseType: "patient",
					},
					expectedCaseType: "patient",
					resultCaseType: "visit",
					links: [
						{
							slot: "runtime_expression_alias",
							target: {
								caseId: "same-resolved-case",
								snapshotCaseType: "patient",
							},
							expectedCaseType: "patient",
						},
					],
				},
			]),
		).toEqual({
			ok: false,
			reason: "case-link-target-is-self",
			operationUuid: "dynamic-self-link",
			slot: "link:runtime_expression_alias",
			caseId: "same-resolved-case",
		});
	});

	it("keeps deterministic authored-key identities type-stable", () => {
		expect(
			validateResolvedCaseOperationTypeSequence([
				{
					operationUuid: "retype-keyed",
					action: "update",
					target: {
						caseId: "nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:key",
						snapshotCaseType: "patient",
					},
					expectedCaseType: "patient",
					resultCaseType: "visit",
				},
			]),
		).toMatchObject({
			ok: false,
			reason: "authored-key-identity-is-type-stable",
		});
	});
});

describe("case-operation schema materialization", () => {
	it("feeds operation-writer types into the case-store schema map", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "score", label: "Score" }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [{ name: "Edit", type: "followup" }],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: asUuid("11111111-1111-4111-8111-111111111111"),
				id: "score_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "score", value: term(literal(7)) }],
			},
		];

		expect(
			buildCaseTypeMap(doc)
				.get("patient")
				?.properties.find((property) => property.name === "score")?.data_type,
		).toBe("int");
	});
});
