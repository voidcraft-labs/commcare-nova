// The dormant-vocabulary gates condition on the activation snapshot:
// while inactive (the omitted-everywhere default) both findings emit
// exactly as before; with the matching flag on, the gate stops
// minting — historical carriers/operations become editable and new
// ones commit. The flags are independent: one turning on never opens
// the other's gate.

import { describe, expect, it } from "vitest";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { buildDoc, f } from "../../../__tests__/docHelpers";
import { evaluateCommit } from "../gate";
import { runValidation } from "../runner";

const TABLE = "018f0000-0000-7000-8000-0000000000t1" as LookupTableId;
const COL_VALUE = "018f0000-0000-7000-8000-0000000000c1" as LookupColumnId;
const COL_LABEL = "018f0000-0000-7000-8000-0000000000c2" as LookupColumnId;

const AVAILABLE_CONTEXT = {
	kind: "available",
	projectId: "project-1",
	projectRevision: "1",
	definitions: [
		{
			id: TABLE,
			name: "Clinics",
			tag: "clinics",
			definitionRevision: "1",
			columns: [
				{ id: COL_VALUE, wireName: "code", label: "Code", dataType: "text" },
				{ id: COL_LABEL, wireName: "label", label: "Label", dataType: "text" },
			],
		},
	],
} as unknown as LookupValidationContext;

function operationDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Ops",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				forms: [
					{
						name: "Follow up",
						type: "followup",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							},
						],
					},
				],
			},
		],
	});
	const formUuid = Object.keys(doc.forms)[0] as Uuid;
	const form = doc.forms[formUuid];
	return {
		...doc,
		forms: {
			...doc.forms,
			[formUuid]: {
				...form,
				caseOperations: [
					{
						uuid: asUuid("018f0000-0000-7000-8000-00000000op01"),
						id: "op_a",
						action: "update" as const,
						caseType: "patient",
						target: { kind: "session" as const },
					},
				],
			},
		},
	};
}

describe("CASE_OPERATIONS_NOT_ACTIVE conditioning", () => {
	it("emits while inactive (the omitted default)", () => {
		const findings = runValidation(operationDoc(), LOOKUP_CONTEXT_UNAVAILABLE);
		expect(findings.some((f) => f.code === "CASE_OPERATIONS_NOT_ACTIVE")).toBe(
			true,
		);
	});

	it("stops emitting when case operations are enabled", () => {
		const findings = runValidation(operationDoc(), LOOKUP_CONTEXT_UNAVAILABLE, {
			activation: { carrierCommitsEnabled: false, caseOperationsEnabled: true },
		});
		expect(findings.some((f) => f.code === "CASE_OPERATIONS_NOT_ACTIVE")).toBe(
			false,
		);
	});

	it("the carrier flag alone does not open the operations gate", () => {
		const findings = runValidation(operationDoc(), LOOKUP_CONTEXT_UNAVAILABLE, {
			activation: { carrierCommitsEnabled: true, caseOperationsEnabled: false },
		});
		expect(findings.some((f) => f.code === "CASE_OPERATIONS_NOT_ACTIVE")).toBe(
			true,
		);
	});
});

describe("LOOKUP_CARRIER_COMMIT_NOT_ACTIVE conditioning", () => {
	it("rejects a new carrier while inactive and admits it when carriers are enabled", () => {
		const nextDoc = buildDoc({
			appName: "Carriers",
			modules: [
				{
					name: "Mod",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "clinic",
									label: "Clinic",
									options: [
										{ value: "a", label: "A" },
										{ value: "b", label: "B" },
									],
								}),
							],
						},
					],
				},
			],
		});
		const fieldUuid = Object.keys(nextDoc.fields)[0] as Uuid;
		const bare = nextDoc.fields[fieldUuid];
		const withCarrier: BlueprintDoc = {
			...nextDoc,
			fields: {
				...nextDoc.fields,
				[fieldUuid]: {
					...bare,
					optionsSource: {
						kind: "lookup-table",
						tableId: TABLE,
						valueColumnId: COL_VALUE,
						labelColumnId: COL_LABEL,
					},
				} as BlueprintDoc["fields"][Uuid],
			},
		};

		const inactive = evaluateCommit({
			prevDoc: nextDoc,
			nextDoc: withCarrier,
			lookupContext: AVAILABLE_CONTEXT,
			scope: "full",
		});
		expect(inactive.ok).toBe(false);
		if (!inactive.ok) {
			expect(
				inactive.introduced.some(
					(finding) => finding.code === "LOOKUP_CARRIER_COMMIT_NOT_ACTIVE",
				),
			).toBe(true);
		}

		const active = evaluateCommit({
			prevDoc: nextDoc,
			nextDoc: withCarrier,
			lookupContext: AVAILABLE_CONTEXT,
			scope: "full",
			activation: {
				carrierCommitsEnabled: true,
				caseOperationsEnabled: false,
			},
		});
		expect(active.ok).toBe(true);
	});
});

describe("operations commit gating end to end", () => {
	it("rejects introducing an operation while inactive and admits it when enabled", () => {
		/* nextDoc derives from prevDoc so entity identities match — the
		 * commit diff must see ONE introduced operation, not a foreign doc. */
		const nextDoc = operationDoc();
		const formUuid = Object.keys(nextDoc.forms)[0] as Uuid;
		const { caseOperations: _dropped, ...bareForm } = nextDoc.forms[formUuid];
		const prevDoc: BlueprintDoc = {
			...nextDoc,
			forms: { ...nextDoc.forms, [formUuid]: bareForm },
		};

		const inactive = evaluateCommit({
			prevDoc,
			nextDoc,
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			scope: "full",
		});
		expect(inactive.ok).toBe(false);
		if (!inactive.ok) {
			expect(
				inactive.introduced.some(
					(f) => f.code === "CASE_OPERATIONS_NOT_ACTIVE",
				),
			).toBe(true);
		}

		const active = evaluateCommit({
			prevDoc,
			nextDoc,
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			scope: "full",
			activation: {
				carrierCommitsEnabled: false,
				caseOperationsEnabled: true,
			},
		});
		expect(active.ok).toBe(true);
	});
});
