import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
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
			{ key: "clear", destination: null },
			{
				key: "notes",
				destination: { caseType: "patient", property: "notes" },
			},
			{
				key: "gone-row",
				destination: { caseType: "patient", property: "notes" },
				replace: { operationUuid: field.uuid, slot: "write" },
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

		// Each verdict is the in-process verdict over the same document, and
		// an admitted one carries the batch it judged.
		expect(response).toEqual({
			version: CASE_WRITE_VERDICT_WORKER_VERSION,
			requestId: 7,
			ok: true,
			verdicts: [
				["clear", { ok: true, mutations: [], notes: [] }],
				[
					"notes",
					{
						ok: true,
						mutations: expect.arrayContaining([
							expect.objectContaining({
								kind: "updateForm",
								caseOperationPatch: expect.objectContaining({
									operation: "add-write",
								}),
							}),
						]),
						notes: [],
					},
				],
				[
					"gone-row",
					{
						ok: false,
						reason: expect.stringMatching(/no longer saves there/),
					},
				],
			],
		});
	});

	it("refuses a request for a field the document doesn't hold", () => {
		const doc = buildDoc({
			appName: "Worker verdicts",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Ask",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
						},
					],
				},
			],
		});
		const response = evaluateCaseWriteVerdictBatch({
			version: CASE_WRITE_VERDICT_WORKER_VERSION,
			requestId: 8,
			doc: structuredClone(toPersistableDoc(doc)),
			fieldUuid: testUuid("absent-field"),
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			candidates: [{ key: "clear", destination: null }],
		});
		expect(response.ok).toBe(false);
	});
});
