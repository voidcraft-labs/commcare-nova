import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { EMPTY_LOOKUP_REFERENCE_TARGETS } from "@/lib/doc/lookupReferences";
import { simpleSearchInputDef } from "@/lib/domain";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { entryPointArguments } from "../entryPointLinks";
import { publishedEntryPoints } from "../entryPointManifest";

describe("published entry point selection contracts", () => {
	it.each([false, true])(
		"retains a search module's selection when no-matches registration is lowered (multiple=%s)",
		(multiple) => {
			const moduleUuid = testUuid("patients");
			const config = caseListConfig([{ field: "case_name", header: "Name" }]);
			config.searchInputs = [
				simpleSearchInputDef(
					testUuid("name-search"),
					"patient_name",
					"Name",
					"text",
					"case_name",
				),
			];
			if (multiple) config.selection = { kind: "multiple", maximum: 5 };
			const doc = buildDoc({
				appName: "Patient visits",
				modules: [
					{
						uuid: moduleUuid,
						name: "Patients",
						caseType: "patient",
						caseListConfig: config,
						caseSearchConfig: { searchFirst: true },
						forms: [
							{
								uuid: "visit",
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "text", id: "notes" })],
							},
							{
								uuid: "register",
								name: "Register patient",
								type: "registration",
								entry: { kind: "search-no-matches" },
								...(multiple ? { postSubmit: "app_home" as const } : {}),
								fields: [
									f({
										kind: "text",
										id: "name",
										caseWrite: { caseType: "patient", property: "case_name" },
									}),
								],
							},
						],
					},
				],
			});
			doc.modules[moduleUuid].entryPoint = {
				uuid: testUuid("patients-link"),
				id: "patients",
			};
			const revision = parseLookupRevision("0");
			const prepared: PreparedExportBoundary = {
				mode: "hq-upload",
				doc,
				compiledAtSeq: 4,
				assets: new Map(),
				lookupTargets: EMPTY_LOOKUP_REFERENCE_TARGETS,
				lookupSnapshot: {
					projectId: "project",
					projectRevision: revision,
					definitions: [],
					rowsByTable: new Map(),
				},
				lookupContext: {
					kind: "available",
					projectId: "project",
					projectRevision: revision,
					definitions: [],
				},
				attachmentTarget: null,
			};
			const runtimeTarget = {
				server: "india" as const,
				domain: "clinic",
				appId: "working-app",
			};
			const entries = publishedEntryPoints(
				prepared,
				expandDoc(doc, { runtimeTarget }),
				doc.appName,
				runtimeTarget,
			);
			expect(entries).toHaveLength(1);
			const entry = entries[0];
			if (!entry) throw new Error("Missing published module entry point");
			expect(entry.requiredSelections).toEqual([
				{
					moduleUuid,
					caseType: "patient",
					cardinality: multiple ? "multiple" : "one",
					maximum: multiple ? 5 : 1,
					argumentId: multiple ? "selected_cases" : "case_id",
				},
			]);
			expect(
				entryPointArguments(entry, [
					{ moduleUuid, caseIds: multiple ? ["case-a", "case-b"] : ["case-a"] },
				]).get(multiple ? "selected_cases" : "case_id"),
			).toBe(multiple ? "case-a,case-b" : "case-a");
		},
	);
});
