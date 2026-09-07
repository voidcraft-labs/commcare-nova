import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	CASE_WRITE_VERDICT_WORKER_VERSION,
	type CaseWriteVerdictCandidate,
} from "@/lib/doc/caseWriteVerdictWorkerProtocol";
import { evaluateCaseWriteVerdictBatch } from "@/lib/doc/caseWriteVerdictWorkerRuntime";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

describe("case-write verdict worker runtime", () => {
	it("returns the authoritative verdict for every candidate in its partition", () => {
		const doc = buildDoc({
			appName: "Worker verdicts",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "notes", label: proseText("Notes") },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									kind: "text",
									id: "notes",
									label: proseText("Notes"),
								}),
							],
						},
					],
				},
			],
		});
		assertAdmittedDoc(doc);
		const field = Object.values(doc.fields).find(
			(candidate) => candidate.id === "notes",
		);
		if (field === undefined) throw new Error("fixture field missing");
		const candidates: readonly CaseWriteVerdictCandidate[] = [
			{ key: "clear", caseWrite: null },
			{
				key: "duplicate",
				caseWrite: { caseType: "patient", property: "case_name" },
			},
		];

		const response = evaluateCaseWriteVerdictBatch({
			version: CASE_WRITE_VERDICT_WORKER_VERSION,
			requestId: 7,
			doc: structuredClone(toPersistableDoc(doc)),
			fieldUuid: field.uuid,
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			candidates,
		});

		expect(response).toEqual({
			version: 1,
			requestId: 7,
			ok: true,
			verdicts: [
				["clear", { ok: true }],
				[
					"duplicate",
					{
						ok: false,
						reason: expect.stringMatching(/more than one field naming/),
					},
				],
			],
		});
	});
});
