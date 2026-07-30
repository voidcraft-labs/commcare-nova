import { describe, expect, it } from "vitest";
import {
	classifyFrozenObservedCatalogLifecycle,
	FROZEN_EXTERNAL_RELATION_KEYS,
	FROZEN_FOLD_FAMILY_OBJECT_KEYS,
	FROZEN_POST_PRIVILEGE_OCCURRENCE_RELATIONS,
	FROZEN_PRE_PRIVILEGE_OCCURRENCE_RELATIONS,
} from "../20260728000000_canonical_identity_foundation/frozenRelationLifecycle";
import {
	classifyFrozenProjectForeignKeyRows,
	classifyFrozenScannerCutoverState,
	type FrozenScannerCatalogSummary,
	frozenCanonicalIdentityTerminalAuditExitCode,
	frozenProjectTenancyFindings,
} from "../20260728000000_canonical_identity_foundation/frozenScanner";

const exactProjectForeignKeys = [
	{
		constraint_name:
			"app_change_fold_baselines_project_id_auth_organization_fk",
		local_relation: "app_change_fold_baselines",
		local_columns: ["project_id"],
		referenced_relation: "auth_organization",
		referenced_columns: ["id"],
		definition:
			"FOREIGN KEY (project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
		validated: true,
		deferrable: false,
		initially_deferred: false,
		update_action: "r",
		delete_action: "r",
	},
	{
		constraint_name: "app_changes_from_project_id_auth_organization_fk",
		local_relation: "app_changes",
		local_columns: ["from_project_id"],
		referenced_relation: "auth_organization",
		referenced_columns: ["id"],
		definition:
			"FOREIGN KEY (from_project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
		validated: true,
		deferrable: false,
		initially_deferred: false,
		update_action: "r",
		delete_action: "r",
	},
	{
		constraint_name: "app_changes_to_project_id_auth_organization_fk",
		local_relation: "app_changes",
		local_columns: ["to_project_id"],
		referenced_relation: "auth_organization",
		referenced_columns: ["id"],
		definition:
			"FOREIGN KEY (to_project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
		validated: true,
		deferrable: false,
		initially_deferred: false,
		update_action: "r",
		delete_action: "r",
	},
	{
		constraint_name: "apps_project_id_auth_organization_fk",
		local_relation: "apps",
		local_columns: ["project_id"],
		referenced_relation: "auth_organization",
		referenced_columns: ["id"],
		definition:
			"FOREIGN KEY (project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
		validated: true,
		deferrable: false,
		initially_deferred: false,
		update_action: "r",
		delete_action: "r",
	},
] as const;

const RUN_SUMMARIES_RELATION = {
	schema: "public",
	table: "run_summaries",
} as const;

function finalTerminalCatalog(): FrozenScannerCatalogSummary {
	return {
		state: "final",
		canonicalPhase: "final",
		privilegePhase: "post-privilege",
		foldFamilyState: "final",
		relationState: "valid",
		authState: "complete",
		casesState: "runtime-post-privilege",
		projectForeignKeyState: "final",
		evidenceDigest: "catalog",
	};
}

describe("frozen canonical-identity scanner state", () => {
	it("classifies the exact four Project foreign keys as one auth-owned phase", () => {
		expect(classifyFrozenProjectForeignKeyRows([])).toBe(
			"interrupted-auth-phase",
		);
		expect(classifyFrozenProjectForeignKeyRows(exactProjectForeignKeys)).toBe(
			"final",
		);
		expect(
			classifyFrozenProjectForeignKeyRows(exactProjectForeignKeys.slice(0, 3)),
		).toBe("drift");
		expect(
			classifyFrozenProjectForeignKeyRows([
				...exactProjectForeignKeys,
				{
					...exactProjectForeignKeys[3],
					constraint_name: "unexpected_project_fk",
				},
			]),
		).toBe("drift");
		expect(
			classifyFrozenProjectForeignKeyRows([
				...exactProjectForeignKeys.slice(0, 3),
				{ ...exactProjectForeignKeys[3], delete_action: "a" },
			]),
		).toBe("drift");
	});

	it("derives zero-app applied state from the complete final catalog, not baseline rows", () => {
		const catalog = classifyFrozenObservedCatalogLifecycle({
			purpose: "migration-or-scan",
			appCount: "0",
			observedRelations: [
				...FROZEN_PRE_PRIVILEGE_OCCURRENCE_RELATIONS,
				RUN_SUMMARIES_RELATION,
			],
			observedFoldObjectKeys: FROZEN_FOLD_FAMILY_OBJECT_KEYS,
		});

		expect(catalog.state).toBe("final");
		expect(catalog.relations.authState).toBe("absent-greenfield");
		expect(
			classifyFrozenScannerCutoverState({
				identitySqlType: "uuid",
				catalogLifecycle: catalog,
			}),
		).toBe("applied");
	});

	it("classifies an empty but partial fold family as drift", () => {
		const catalog = classifyFrozenObservedCatalogLifecycle({
			purpose: "migration-or-scan",
			appCount: "0",
			observedRelations: [
				...FROZEN_PRE_PRIVILEGE_OCCURRENCE_RELATIONS,
				RUN_SUMMARIES_RELATION,
			],
			observedFoldObjectKeys: ["relation:public:app_change_fold_baselines"],
		});

		expect(catalog.foldFamily.state).toBe("drift");
		expect(catalog.state).toBe("drift");
		expect(
			classifyFrozenScannerCutoverState({
				identitySqlType: "uuid",
				catalogLifecycle: catalog,
			}),
		).toBe("drift");
	});

	it("allows only whole-family auth absence on a zero-app greenfield catalog", () => {
		const pristineRelations = FROZEN_PRE_PRIVILEGE_OCCURRENCE_RELATIONS.filter(
			(relation) => relation.table !== "app_change_fold_baselines",
		).map((relation) =>
			relation.table === "app_changes"
				? { ...relation, table: "accepted_mutations" }
				: relation,
		);
		const completePristineRelations = [
			...pristineRelations,
			RUN_SUMMARIES_RELATION,
		];
		const greenfield = classifyFrozenObservedCatalogLifecycle({
			purpose: "migration-or-scan",
			appCount: "0",
			observedRelations: completePristineRelations,
			observedFoldObjectKeys: [],
		});
		expect(greenfield.state).toBe("pristine");
		expect(greenfield.relations.authState).toBe("absent-greenfield");

		const partialAuth = classifyFrozenObservedCatalogLifecycle({
			purpose: "migration-or-scan",
			appCount: "0",
			observedRelations: [
				...completePristineRelations,
				{ schema: "public", table: FROZEN_EXTERNAL_RELATION_KEYS[0] },
			],
			observedFoldObjectKeys: [],
		});
		expect(partialAuth.state).toBe("drift");
		expect(partialAuth.relations.authState).toBe("drift");
	});

	it("lets the terminal audit pass only the exact deployed final topology", () => {
		const completeAuthRelations = FROZEN_EXTERNAL_RELATION_KEYS.map(
			(table) => ({ schema: "public", table }),
		);
		const catalog = classifyFrozenObservedCatalogLifecycle({
			purpose: "migration-or-scan",
			appCount: "0",
			observedRelations: [
				...FROZEN_POST_PRIVILEGE_OCCURRENCE_RELATIONS,
				RUN_SUMMARIES_RELATION,
				...completeAuthRelations,
			],
			observedFoldObjectKeys: FROZEN_FOLD_FAMILY_OBJECT_KEYS,
		});
		expect(catalog.state).toBe("final");
		expect(catalog.relations.authState).toBe("complete");

		const report = {
			findingCount: 0,
			cutoverPlan: { state: "applied" as const },
			catalogLifecycle: finalTerminalCatalog(),
		};
		expect(frozenCanonicalIdentityTerminalAuditExitCode(report)).toBe(0);
		expect(
			frozenCanonicalIdentityTerminalAuditExitCode({
				...report,
				cutoverPlan: { state: "pristine" },
			}),
		).toBe(2);
		expect(
			frozenCanonicalIdentityTerminalAuditExitCode({
				...report,
				catalogLifecycle: {
					...report.catalogLifecycle,
					authState: "absent-greenfield",
				},
			}),
		).toBe(2);
		expect(
			frozenCanonicalIdentityTerminalAuditExitCode({
				...report,
				findingCount: 1,
			}),
		).toBe(2);
	});
});

describe("frozen scanner Project-tenancy findings", () => {
	it("emits one blocking finding for every invalid app, target, and case row", () => {
		const findings = frozenProjectTenancyFindings({
			invalidApps: [
				{ id: "app-null", owner: "", project_id: null },
				{ id: "app-blank", owner: "owner", project_id: " " },
			],
			missingProjectTargets: [
				{ id: "app-missing-1", project_id: "project-1" },
				{ id: "app-missing-2", project_id: "project-2" },
			],
			appsWithoutAuthCatalog: [
				{ id: "app-unverifiable", project_id: "project-3" },
			],
			invalidCases: [
				{
					app_id: "app-a",
					case_id: "case-a",
					project_id: null,
					app_project_id: "project-a",
				},
				{
					app_id: "app-b",
					case_id: "case-b",
					project_id: "project-wrong",
					app_project_id: "project-b",
				},
			],
		});

		expect(findings).toHaveLength(7);
		expect(
			findings.filter(
				(finding) => finding.carrierId === "apps.project-tenancy",
			),
		).toHaveLength(2);
		expect(
			findings.filter((finding) => finding.carrierId === "apps.project-target"),
		).toHaveLength(3);
		expect(
			findings.filter(
				(finding) => finding.carrierId === "cases.project-tenancy",
			),
		).toHaveLength(2);
		expect(
			findings.every((finding) => finding.disposition === "block-current"),
		).toBe(true);
	});
});
