import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { LookupRevision } from "@/lib/lookup/types";
import {
	auditRuntimeProbeParsedBlueprint,
	chooseRuntimeProbeCandidate,
	summarizeRuntimeProbeAppAudits,
} from "../runtimeDatabaseProbe";

const LOOKUP_CONTEXT: LookupValidationContext = {
	kind: "available",
	projectId: "project-probe",
	projectRevision: "0" as LookupRevision,
	definitions: [],
};

describe("chooseRuntimeProbeCandidate", () => {
	it("chooses an existing membership with edit authority", () => {
		expect(
			chooseRuntimeProbeCandidate([
				{
					app_id: "viewer-app",
					project_id: "project-a",
					user_id: "viewer-user",
					role: "viewer",
				},
				{
					app_id: "editor-app",
					project_id: "project-b",
					user_id: "editor-user",
					role: "editor",
				},
			]),
		).toEqual({
			app_id: "editor-app",
			project_id: "project-b",
			user_id: "editor-user",
			role: "editor",
		});
	});

	it("fails closed when no existing membership can exercise a write", () => {
		expect(() =>
			chooseRuntimeProbeCandidate([
				{
					app_id: "viewer-app",
					project_id: "project-a",
					user_id: "viewer-user",
					role: "viewer",
				},
			]),
		).toThrow("requires an existing editable Project app membership");
	});
});

describe("summarizeRuntimeProbeAppAudits", () => {
	it("accounts for every app without a sampling cap", () => {
		const audits = Array.from({ length: 1_501 }, () => ({
			parsed: true,
			gateFindingCount: 0,
			localReferenceIndexFindingCount: 0,
			projectReferenceIndexFindingCount: 0,
			mediaReferenceProjectionFindingCount: 0,
		}));
		expect(summarizeRuntimeProbeAppAudits(audits.length, audits)).toEqual({
			scannedAppCount: 1_501,
			parsedAppCount: 1_501,
			parserFindingCount: 0,
			gateFindingCount: 0,
			localReferenceIndexFindingCount: 0,
			projectReferenceIndexFindingCount: 0,
			mediaReferenceProjectionFindingCount: 0,
			findingCount: 0,
		});
	});

	it("reports the actual parser, gate, and both reference-index findings", () => {
		expect(
			summarizeRuntimeProbeAppAudits(3, [
				{
					parsed: true,
					gateFindingCount: 2,
					localReferenceIndexFindingCount: 1,
					projectReferenceIndexFindingCount: 0,
					mediaReferenceProjectionFindingCount: 2,
				},
				{
					parsed: false,
					gateFindingCount: 0,
					localReferenceIndexFindingCount: 0,
					projectReferenceIndexFindingCount: 0,
					mediaReferenceProjectionFindingCount: 0,
				},
				{
					parsed: true,
					gateFindingCount: 0,
					localReferenceIndexFindingCount: 0,
					projectReferenceIndexFindingCount: 3,
					mediaReferenceProjectionFindingCount: 1,
				},
			]),
		).toEqual({
			scannedAppCount: 3,
			parsedAppCount: 2,
			parserFindingCount: 1,
			gateFindingCount: 2,
			localReferenceIndexFindingCount: 1,
			projectReferenceIndexFindingCount: 3,
			mediaReferenceProjectionFindingCount: 3,
			findingCount: 10,
		});
	});

	it("fails if even one selected app has no audit outcome", () => {
		expect(() => summarizeRuntimeProbeAppAudits(2, [])).toThrow(
			"exactly one audit for every selected app",
		);
	});
});

describe("auditRuntimeProbeParsedBlueprint", () => {
	it("counts every real gate finding and still executes both reference-index proofs", () => {
		const invalidDoc = buildDoc({ appName: "", modules: [] });
		const verdict = mutationCommitVerdict(invalidDoc, [], LOOKUP_CONTEXT);
		if (verdict.ok)
			throw new Error("expected invalid production-shaped fixture");

		const audit = auditRuntimeProbeParsedBlueprint({
			doc: invalidDoc,
			appName: invalidDoc.appName,
			projectId: "project-probe",
			lookupContext: LOOKUP_CONTEXT,
			storedProjectLookupReferences: [],
			mediaReferenceProjectionFindingCount: 0,
		});
		expect(audit).toEqual({
			parsed: true,
			gateFindingCount: verdict.findings.length,
			localReferenceIndexFindingCount: 0,
			projectReferenceIndexFindingCount: 0,
			mediaReferenceProjectionFindingCount: 0,
		});
		expect(audit.gateFindingCount).toBeGreaterThan(0);

		expect(
			auditRuntimeProbeParsedBlueprint({
				doc: invalidDoc,
				appName: invalidDoc.appName,
				projectId: "project-probe",
				lookupContext: LOOKUP_CONTEXT,
				storedProjectLookupReferences: [
					{
						project_id: "project-probe",
						table_id: "11111111-1111-4111-8111-111111111111",
						column_id: null,
					},
				],
				mediaReferenceProjectionFindingCount: 0,
			}).projectReferenceIndexFindingCount,
		).toBe(1);
	});
});
