import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	ROUTE,
	SOURCE,
	twoMenus,
	VISIT,
} from "@/lib/commcare/__tests__/menuFormRoutesFixture";
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
						caseSearchConfig: { formsReadSearch: true },
						caseListRegistrationForm: { formUuid: "register" },
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
								...(multiple ? { postSubmit: "firstMenu" as const } : {}),
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
				managedLookupTables: [],
				managedLookupWorkbooks: [],
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

describe("a deep link a menu holds for another menu's form", () => {
	it("is published with its own route's signature and selection, beside the source's", () => {
		const doc = twoMenus();
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
			managedLookupTables: [],
			managedLookupWorkbooks: [],
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
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const routed = byId.get("clinic-visit");
		const owned = byId.get("visit");
		if (!routed || !owned) throw new Error("Both form links are published.");
		expect(routed.target).toEqual({
			kind: "form",
			moduleUuid: ROUTE,
			formUuid: VISIT,
		});
		expect(owned.target).toEqual({
			kind: "form",
			moduleUuid: SOURCE,
			formUuid: VISIT,
		});
		// Each link is checked against the suite's own endpoint for its route.
		expect(routed.signature).not.toBe(owned.signature);
		expect(routed.requiredSelections).toEqual([
			{
				moduleUuid: ROUTE,
				caseType: "patient",
				cardinality: "one",
				maximum: 1,
				argumentId: "case_id",
			},
		]);
		expect(
			entryPointArguments(routed, [
				{ moduleUuid: ROUTE, caseIds: ["case-a"] },
			]).get("case_id"),
		).toBe("case-a");
	});
});
