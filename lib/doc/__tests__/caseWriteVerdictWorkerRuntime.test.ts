import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { caseWriteChoiceVerdict } from "@/lib/doc/caseWriteChoices";
import {
	CASE_WRITE_VERDICT_WORKER_VERSION,
	type CaseWriteVerdictCandidate,
} from "@/lib/doc/caseWriteVerdictWorkerProtocol";
import { evaluateCaseWriteVerdictBatch } from "@/lib/doc/caseWriteVerdictWorkerRuntime";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";

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
			doc,
			fieldUuid: field.uuid,
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			candidates,
		});

		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.verdicts).toEqual(
			candidates.map((candidate) => [
				candidate.key,
				caseWriteChoiceVerdict(
					doc,
					field,
					candidate.caseWrite,
					LOOKUP_CONTEXT_UNAVAILABLE,
				),
			]),
		);
	});
});
