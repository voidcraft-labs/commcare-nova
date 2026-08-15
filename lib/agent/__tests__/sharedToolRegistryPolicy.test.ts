/**
 * Execution-policy invariants over the complete shared tool registry.
 *
 * The `satisfies` clause already forces every entry to DECLARE a policy;
 * these tests keep the declarations COHERENT — a new tool cannot slip in
 * with an external effect and a stageable classification, and the exact
 * classification of every entry is pinned so changing one is a reviewed
 * decision, not a drive-by.
 */

import { describe, expect, it } from "vitest";
import {
	SHARED_TOOL_REGISTRY,
	type ToolExecutionPolicy,
} from "../sharedToolRegistry";

const EXTERNAL_WRITE_CAPABILITIES = [
	"organization-write",
	"media-write",
	"lookup-write",
	"deployment-write",
] as const;

describe("shared tool registry — execution policy coherence", () => {
	it("every external-effect tool is unstageable", () => {
		for (const entry of SHARED_TOOL_REGISTRY) {
			if (
				entry.policy.effect === "mutate-external" ||
				entry.policy.effect === "mixed-transaction"
			) {
				expect(
					entry.policy.staging,
					`${entry.saName} has an external effect and must be forbidden in a change set`,
				).toBe("forbidden");
			}
		}
	});

	it("no stageable tool carries an external-write capability", () => {
		for (const entry of SHARED_TOOL_REGISTRY) {
			if (entry.policy.staging === "forbidden") continue;
			for (const capability of entry.policy.capabilities) {
				expect(
					EXTERNAL_WRITE_CAPABILITIES,
					`${entry.saName} is stageable but requires ${capability}`,
				).not.toContain(capability);
			}
		}
	});

	it("every Blueprint mutator declares the canonical write capability", () => {
		for (const entry of SHARED_TOOL_REGISTRY) {
			if (entry.policy.effect !== "mutate-blueprint") continue;
			expect(
				entry.policy.capabilities,
				`${entry.saName} mutates the Blueprint`,
			).toContain("canonical-blueprint-write");
		}
	});

	it("read-only tools declare no write capability at all", () => {
		for (const entry of SHARED_TOOL_REGISTRY) {
			if (entry.policy.effect !== "read-blueprint") continue;
			for (const capability of entry.policy.capabilities) {
				expect(
					capability.endsWith("-read"),
					`${entry.saName} is a read but requires ${capability}`,
				).toBe(true);
			}
		}
	});

	it("final-guidance read sets are declared read sets", () => {
		for (const entry of SHARED_TOOL_REGISTRY) {
			const policy: ToolExecutionPolicy = entry.policy;
			for (const kind of policy.emitsFinalGuidanceFrom ?? []) {
				expect(
					policy.readSets,
					`${entry.saName} projects guidance from an undeclared read set`,
				).toContain(kind);
			}
		}
	});

	it("the batch-exclusive case-store saga is the only exclusive classification", () => {
		const exclusive = SHARED_TOOL_REGISTRY.filter(
			(entry) => entry.policy.staging === "exclusive",
		).map((entry) => entry.saName);
		expect(exclusive).toEqual(["renameCaseProperties"]);
	});

	it("pins the exact classification of every registry entry", () => {
		const classification = Object.fromEntries(
			SHARED_TOOL_REGISTRY.map((entry) => [
				entry.saName,
				`${entry.policy.effect}/${entry.policy.staging}`,
			]),
		);
		expect(classification).toEqual({
			getAutomations: "read-blueprint/allowed",
			addAutomations: "mutate-blueprint/allowed",
			updateAutomation: "mutate-blueprint/allowed",
			removeAutomation: "mutate-blueprint/allowed",
			addFields: "mutate-blueprint/allowed",
			getLanguages: "read-blueprint/allowed",
			getTranslatableContent: "read-blueprint/allowed",
			addLanguage: "mutate-blueprint/allowed",
			updateLanguage: "mutate-blueprint/allowed",
			removeLanguage: "mutate-blueprint/allowed",
			updateTranslations: "mutate-blueprint/allowed",
			getLookupTables: "read-blueprint/allowed",
			setFieldOptionsSource: "mutate-blueprint/allowed",
			configureConnect: "mutate-blueprint/allowed",
			createForm: "mutate-blueprint/allowed",
			createModule: "mutate-blueprint/allowed",
			editField: "mutate-blueprint/allowed",
			generateSchema: "mutate-blueprint/allowed",
			getField: "read-blueprint/allowed",
			getForm: "read-blueprint/allowed",
			getModule: "read-blueprint/allowed",
			getCaseOperations: "read-blueprint/allowed",
			moveField: "mutate-blueprint/allowed",
			moveModule: "mutate-blueprint/allowed",
			removeField: "mutate-blueprint/allowed",
			removeForm: "mutate-blueprint/allowed",
			removeModule: "mutate-blueprint/allowed",
			renameCaseProperties: "mutate-blueprint/exclusive",
			searchBlueprint: "read-blueprint/allowed",
			addCaseOperations: "mutate-blueprint/allowed",
			updateCaseOperation: "mutate-blueprint/allowed",
			removeCaseOperation: "mutate-blueprint/allowed",
			moveCaseOperation: "mutate-blueprint/allowed",
			addCaseListColumns: "mutate-blueprint/allowed",
			configureCaseList: "mutate-blueprint/allowed",
			addSearchInputs: "mutate-blueprint/allowed",
			removeCaseListColumn: "mutate-blueprint/allowed",
			removeSearchInput: "mutate-blueprint/allowed",
			reorderCaseListColumns: "mutate-blueprint/allowed",
			reorderSearchInputs: "mutate-blueprint/allowed",
			setCaseListFilter: "mutate-blueprint/allowed",
			setCaseListTile: "mutate-blueprint/allowed",
			updateCaseListColumn: "mutate-blueprint/allowed",
			updateSearchInput: "mutate-blueprint/allowed",
			setCaseSearchAdvanced: "mutate-blueprint/allowed",
			setCaseSearchDisplay: "mutate-blueprint/allowed",
			attachFieldMedia: "mutate-blueprint/allowed",
			attachOptionMedia: "mutate-blueprint/allowed",
			setMenuMedia: "mutate-blueprint/allowed",
			setAppLogo: "mutate-blueprint/allowed",
			listMediaAssets: "read-blueprint/allowed",
			removeMediaAsset: "mutate-external/forbidden",
			getUsers: "read-blueprint/allowed",
			getOrganization: "read-blueprint/allowed",
			addOrganizationLevels: "mutate-blueprint/allowed",
			updateOrganizationLevel: "mutate-blueprint/allowed",
			removeOrganizationLevel: "mutate-blueprint/allowed",
			addLocationProperties: "mutate-blueprint/allowed",
			updateLocationProperty: "mutate-blueprint/allowed",
			removeLocationProperty: "mutate-blueprint/allowed",
			createLocation: "mutate-external/forbidden",
			updateLocation: "mutate-external/forbidden",
			moveLocation: "mutate-external/forbidden",
			setLocationArchived: "mixed-transaction/forbidden",
			addUserProperties: "mutate-blueprint/allowed",
			updateUserProperty: "mutate-blueprint/allowed",
			removeUserProperty: "mutate-blueprint/allowed",
			addUserTypes: "mutate-blueprint/allowed",
			updateUserType: "mutate-blueprint/allowed",
			removeUserType: "mutate-blueprint/allowed",
			addPersonas: "mutate-blueprint/allowed",
			updatePersona: "mutate-blueprint/allowed",
			removePersona: "mutate-blueprint/allowed",
			updateApp: "mutate-blueprint/allowed",
			updateForm: "mutate-blueprint/allowed",
			updateModule: "mutate-blueprint/allowed",
		});
	});
});
