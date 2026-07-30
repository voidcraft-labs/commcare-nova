/**
 * Timestamp-frozen READ ONLY advisory/locked scan for the canonical identity cutover.
 *
 * Output is deliberately content-free: counts, byte sizes, digests, rewrite
 * totals, and structural paths only. App names, authored prose/values,
 * filenames, chat text, and tool receipts are never printed.
 */

import { type Kysely, sql } from "kysely";
import {
	captureFrozenCutoverCatalogEvidence,
	captureFrozenCutoverLeaseState,
	createFrozenCutoverPlan,
	type FrozenCutoverAppDisposition,
	type FrozenCutoverLookupContextEvidence,
	type FrozenCutoverState,
	frozenRawCarrierEvidence,
	reviewedFrozenCapacity,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenCutoverPlan";
import {
	assertFrozenFoldBaselineCatalog,
	assertFrozenMediaReferenceCatalog,
	assertFrozenMediaReferenceRows,
	assertFrozenSqlIdentityStructuralCatalog,
	frozenBlueprintMediaReferenceEdges,
	frozenExpectedMediaReferenceEdges,
	readFrozenFoldFamilyObjectKeys,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenDatabaseMigration";
import {
	type FrozenVerifiedJson,
	verifyFrozenJsonCarriers,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenJsonCarriers";
import { readFrozenProjectLookupContext } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenLookupContext";
import {
	captureFrozenStorageSnapshot,
	dispatchFrozenStorageOccurrences,
	frozenExactTextSequenceDigest,
	frozenThreadAttachmentInventory,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher";
import {
	FROZEN_ENTITY_OCCURRENCES,
	FROZEN_FINAL_MUTATION_KINDS,
	FROZEN_OCCURRENCE_RELATIONS,
	FROZEN_ROOT_OCCURRENCES,
	FROZEN_STORAGE_OCCURRENCES,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenOccurrenceManifest";
import {
	decodeFrozenStoredApp,
	materializeFrozenBlueprintJson,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenPersistableBlueprintDecoder";
import {
	type FrozenLookupValidationContext,
	replayFrozenCanonicalAppChangeSuffix,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenPersistableBlueprintValidator.generated.mjs";
import {
	assertFrozenProjectOrphanSummary,
	captureFrozenProjectOrphanInventory,
	type FrozenProjectOrphanSummary,
	summarizeFrozenProjectOrphanInventory,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenProjectTenancy";
import {
	classifyFrozenObservedCatalogLifecycle,
	FROZEN_RELATION_CANDIDATE_PHYSICAL_RELATIONS,
	type FrozenObservedCatalogLifecycleResolution,
	type FrozenPhysicalRelation,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRelationLifecycle";
import {
	CANONICAL_IDENTITY_MIGRATION_VERSION,
	type CanonicalAppPlan,
	type CanonicalIdentityFinding,
	canonicalIdentityDigest,
	isCanonicalAuthoredUuid,
	type LegacyAppSnapshot,
	type LegacyEntityKind,
	type LegacyEntityRow,
	planCanonicalAppMigration,
	scanLookupIdentities,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenTransform";

export interface FrozenCanonicalIdentityScanOptions {
	readonly locked?: boolean;
	/**
	 * Present only on the immutable post-deploy audit entrypoint. Advisory and
	 * locked pre-cutover scans deliberately do not apply deployed role/ACL
	 * expectations.
	 */
	readonly deployedFoldSecurity?: {
		readonly migrationRole: string;
		readonly runtimeRole: string;
		readonly auditRole: string;
	};
}

type FrozenScannerIdentitySqlType = "text" | "uuid" | "mixed" | "other";

export interface FrozenScannerCatalogSummary {
	readonly state: FrozenObservedCatalogLifecycleResolution["state"];
	readonly canonicalPhase: FrozenObservedCatalogLifecycleResolution["canonicalPhase"];
	readonly privilegePhase: FrozenObservedCatalogLifecycleResolution["privilegePhase"];
	readonly foldFamilyState: FrozenObservedCatalogLifecycleResolution["foldFamily"]["state"];
	readonly relationState: FrozenObservedCatalogLifecycleResolution["relations"]["state"];
	readonly authState: FrozenObservedCatalogLifecycleResolution["relations"]["authState"];
	readonly casesState: FrozenObservedCatalogLifecycleResolution["relations"]["cases"]["state"];
	readonly projectForeignKeyState:
		| "pristine-input"
		| "interrupted-auth-phase"
		| "final"
		| "drift";
	readonly evidenceDigest: string;
}

export interface FrozenTerminalAuditReport {
	readonly findingCount: number;
	readonly cutoverPlan: {
		readonly state: FrozenCutoverState;
	};
	readonly catalogLifecycle: FrozenScannerCatalogSummary;
}

interface CountBytes {
	count: string;
	bytes: string;
}

interface FindingSummary {
	readonly count: number;
	readonly sampleDigests: readonly string[];
}

interface OptionIdentityShapes {
	total: number;
	missing: number;
	nonString: number;
	canonical: number;
	preCutoverPositionDerivedExact: number;
	preCutoverPositionDerivedStale: number;
	uuidLexicalNoncanonical: number;
	otherString: number;
	uppercase: number;
	byLength: Record<string, number>;
	byVersionNibble: Record<string, number>;
	byVariantNibble: Record<string, number>;
}

interface RawReferenceShapes {
	total: number;
	byNamespaceClass: Record<string, number>;
	bySegmentCount: Record<string, number>;
	formResolution: Record<string, number>;
	caseResolution: Record<string, number>;
	sampleDigests: string[];
}

interface BlueprintStructureShapes {
	fieldPlacement: Record<string, number>;
	formPlacement: Record<string, number>;
}

interface SearchInputReferenceShapes {
	total: number;
	resolution: Record<string, number>;
}

const UUID_LEXICAL =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasCanonicalAuthoredUuid(value: string): boolean {
	return isCanonicalAuthoredUuid(value);
}

function increment(bucket: Record<string, number>, key: string): void {
	bucket[key] = (bucket[key] ?? 0) + 1;
}

export function classifyFrozenScannerCutoverState(input: {
	readonly identitySqlType: FrozenScannerIdentitySqlType;
	readonly catalogLifecycle: FrozenObservedCatalogLifecycleResolution;
}): FrozenCutoverState {
	const catalogState = input.catalogLifecycle.state;
	if (catalogState === "drift" || catalogState === "repair-not-applicable") {
		return "drift";
	}
	if (input.identitySqlType === "text" && catalogState === "pristine") {
		return "pristine";
	}
	if (input.identitySqlType === "uuid" && catalogState === "final") {
		return "applied";
	}
	if (
		input.identitySqlType === "mixed" ||
		(input.identitySqlType === "text" && catalogState === "final") ||
		(input.identitySqlType === "uuid" && catalogState === "pristine")
	) {
		return "mixed";
	}
	return "drift";
}

export function frozenCanonicalIdentityTerminalAuditExitCode(
	report: FrozenTerminalAuditReport,
): 0 | 2 {
	return report.findingCount === 0 &&
		report.cutoverPlan.state === "applied" &&
		report.catalogLifecycle.state === "final" &&
		report.catalogLifecycle.canonicalPhase === "final" &&
		report.catalogLifecycle.privilegePhase === "post-privilege" &&
		report.catalogLifecycle.foldFamilyState === "final" &&
		report.catalogLifecycle.relationState === "valid" &&
		report.catalogLifecycle.authState === "complete" &&
		report.catalogLifecycle.casesState === "runtime-post-privilege" &&
		report.catalogLifecycle.projectForeignKeyState === "final"
		? 0
		: 2;
}

function catalogLifecycleFinding(
	lifecycle: FrozenObservedCatalogLifecycleResolution,
): CanonicalIdentityFinding | null {
	if (lifecycle.state === "pristine" || lifecycle.state === "final")
		return null;
	return {
		disposition: "block-current",
		carrierId: "catalog.lifecycle",
		code: "invalid-legacy-shape",
		path: "catalog.lifecycle",
		digest: canonicalIdentityDigest(lifecycle),
	};
}

function summarizeCatalogLifecycle(
	lifecycle: FrozenObservedCatalogLifecycleResolution,
	observedFoldObjectKeys: readonly string[],
	projectForeignKeyState: FrozenScannerCatalogSummary["projectForeignKeyState"],
): FrozenScannerCatalogSummary {
	return {
		state: lifecycle.state,
		canonicalPhase: lifecycle.canonicalPhase,
		privilegePhase: lifecycle.privilegePhase,
		foldFamilyState: lifecycle.foldFamily.state,
		relationState: lifecycle.relations.state,
		authState: lifecycle.relations.authState,
		casesState: lifecycle.relations.cases.state,
		projectForeignKeyState,
		evidenceDigest: canonicalIdentityDigest({
			lifecycle,
			observedFoldObjectKeys,
			projectForeignKeyState,
		}),
	};
}

async function classifyFrozenProjectForeignKeys(
	db: Kysely<unknown>,
	canonicalPhase: FrozenObservedCatalogLifecycleResolution["canonicalPhase"],
): Promise<FrozenScannerCatalogSummary["projectForeignKeyState"]> {
	if (canonicalPhase !== "final") return "pristine-input";
	const rows = await sql<{
		constraint_name: string;
		local_relation: string;
		local_columns: readonly string[];
		referenced_relation: string | null;
		referenced_columns: readonly string[];
		definition: string;
		validated: boolean;
		deferrable: boolean;
		initially_deferred: boolean;
		update_action: string;
		delete_action: string;
	}>`
		WITH target AS (
			SELECT
				relation.oid AS relation_id,
				relation.relname AS relation_name,
				attribute.attnum AS column_number
			FROM pg_class AS relation
			JOIN pg_namespace AS namespace
			  ON namespace.oid = relation.relnamespace
			JOIN pg_attribute AS attribute
			  ON attribute.attrelid = relation.oid
			 AND attribute.attnum > 0
			 AND NOT attribute.attisdropped
			WHERE namespace.nspname = 'public'
			  AND (
					(relation.relname = 'apps' AND attribute.attname = 'project_id')
					OR (
						relation.relname = 'app_changes'
						AND attribute.attname IN ('from_project_id', 'to_project_id')
					)
					OR (
						relation.relname = 'app_change_fold_baselines'
						AND attribute.attname = 'project_id'
					)
			  )
		)
		SELECT DISTINCT
			constraint_row.conname AS constraint_name,
			relation.relname AS local_relation,
			to_jsonb(ARRAY(
				SELECT attribute.attname
				FROM unnest(constraint_row.conkey)
					WITH ORDINALITY key(attnum, ordinal)
				JOIN pg_attribute AS attribute
				  ON attribute.attrelid = constraint_row.conrelid
				 AND attribute.attnum = key.attnum
				ORDER BY key.ordinal
			)) AS local_columns,
			referenced.relname AS referenced_relation,
			to_jsonb(ARRAY(
				SELECT attribute.attname
				FROM unnest(constraint_row.confkey)
					WITH ORDINALITY key(attnum, ordinal)
				JOIN pg_attribute AS attribute
				  ON attribute.attrelid = constraint_row.confrelid
				 AND attribute.attnum = key.attnum
				ORDER BY key.ordinal
			)) AS referenced_columns,
			pg_get_constraintdef(constraint_row.oid, true) AS definition,
			constraint_row.convalidated AS validated,
			constraint_row.condeferrable AS deferrable,
			constraint_row.condeferred AS initially_deferred,
			constraint_row.confupdtype::text AS update_action,
			constraint_row.confdeltype::text AS delete_action
		FROM target
		JOIN pg_constraint AS constraint_row
		  ON constraint_row.conrelid = target.relation_id
		 AND constraint_row.contype = 'f'
		 AND target.column_number = ANY(constraint_row.conkey)
		JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
		LEFT JOIN pg_class AS referenced
		  ON referenced.oid = constraint_row.confrelid
		ORDER BY constraint_row.conname
	`.execute(db);
	return classifyFrozenProjectForeignKeyRows(rows.rows);
}

export interface FrozenProjectForeignKeyCatalogRow {
	readonly constraint_name: string;
	readonly local_relation: string;
	readonly local_columns: readonly string[];
	readonly referenced_relation: string | null;
	readonly referenced_columns: readonly string[];
	readonly definition: string;
	readonly validated: boolean;
	readonly deferrable: boolean;
	readonly initially_deferred: boolean;
	readonly update_action: string;
	readonly delete_action: string;
}

export function classifyFrozenProjectForeignKeyRows(
	rows: readonly FrozenProjectForeignKeyCatalogRow[],
): Extract<
	FrozenScannerCatalogSummary["projectForeignKeyState"],
	"interrupted-auth-phase" | "final" | "drift"
> {
	if (rows.length === 0) return "interrupted-auth-phase";
	const expected = [
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
	];
	return canonicalIdentityDigest(rows) === canonicalIdentityDigest(expected)
		? "final"
		: "drift";
}

export function frozenProjectTenancyFindings(input: {
	readonly invalidApps: readonly {
		readonly id: string;
		readonly owner: string;
		readonly project_id: string | null;
	}[];
	readonly missingProjectTargets: readonly {
		readonly id: string;
		readonly project_id: string;
	}[];
	readonly invalidCases: readonly {
		readonly app_id: string;
		readonly case_id: string;
		readonly project_id: string | null;
		readonly app_project_id: string | null;
	}[];
	readonly appsWithoutAuthCatalog: readonly {
		readonly id: string;
		readonly project_id: string;
	}[];
}): readonly CanonicalIdentityFinding[] {
	return [
		...input.invalidApps.map(
			(row): CanonicalIdentityFinding => ({
				disposition: "block-current",
				carrierId: "apps.project-tenancy",
				code: "invalid-legacy-shape",
				path: `storage.apps.${canonicalIdentityDigest(row.id)}.project_id`,
				digest: canonicalIdentityDigest({
					projectState:
						row.project_id === null
							? "null"
							: row.project_id.trim().length === 0
								? "blank"
								: "present",
					ownerBlank: row.owner.length === 0,
				}),
			}),
		),
		...input.missingProjectTargets.map(
			(row): CanonicalIdentityFinding => ({
				disposition: "block-current",
				carrierId: "apps.project-target",
				code: "invalid-legacy-shape",
				path: `storage.apps.${canonicalIdentityDigest(row.id)}.project-target`,
				digest: canonicalIdentityDigest(row.project_id),
			}),
		),
		...input.appsWithoutAuthCatalog.map(
			(row): CanonicalIdentityFinding => ({
				disposition: "block-current",
				carrierId: "apps.project-target",
				code: "invalid-legacy-shape",
				path: `storage.apps.${canonicalIdentityDigest(row.id)}.project-target`,
				digest: canonicalIdentityDigest({
					project: row.project_id,
					authCatalog: "absent",
				}),
			}),
		),
		...input.invalidCases.map(
			(row): CanonicalIdentityFinding => ({
				disposition: "block-current",
				carrierId: "cases.project-tenancy",
				code: "invalid-legacy-shape",
				path: `storage.cases.${canonicalIdentityDigest([
					row.app_id,
					row.case_id,
				])}.project_id`,
				digest: canonicalIdentityDigest({
					project:
						row.project_id === null
							? null
							: canonicalIdentityDigest(row.project_id),
					appProject:
						row.app_project_id === null
							? null
							: canonicalIdentityDigest(row.app_project_id),
				}),
			}),
		),
	];
}

function recordOptionIdentityShape(
	report: OptionIdentityShapes,
	value: unknown,
	fieldUuid: string,
	index: number,
): void {
	report.total++;
	if (value === undefined || value === null) {
		report.missing++;
		return;
	}
	if (typeof value !== "string") {
		report.nonString++;
		return;
	}
	increment(report.byLength, String(value.length));
	if (value !== value.toLowerCase()) report.uppercase++;
	if (hasCanonicalAuthoredUuid(value)) {
		report.canonical++;
	} else if (value === `${fieldUuid}-opt-${index}`) {
		report.preCutoverPositionDerivedExact++;
	} else if (
		value.startsWith(`${fieldUuid}-opt-`) &&
		/^[0-9]+$/.test(value.slice(fieldUuid.length + 5))
	) {
		report.preCutoverPositionDerivedStale++;
	} else if (UUID_LEXICAL.test(value)) {
		report.uuidLexicalNoncanonical++;
	} else {
		report.otherString++;
	}
	if (UUID_LEXICAL.test(value)) {
		increment(report.byVersionNibble, value[14] ?? "missing");
		increment(report.byVariantNibble, value[19] ?? "missing");
	}
}

function recordLegacyReferenceShapes(
	value: unknown,
	report: RawReferenceShapes,
	path: string,
	visit?: (reference: Record<string, unknown>) => void,
): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) {
			recordLegacyReferenceShapes(child, report, `${path}[${index}]`, visit);
		}
		return;
	}
	const record = value as Record<string, unknown>;
	if (record.kind === "raw-ref") {
		report.total++;
		if (report.sampleDigests.length < 25) {
			report.sampleDigests.push(canonicalIdentityDigest(path));
		}
		visit?.(record);
		const namespaceClass =
			record.namespace === "form"
				? "form"
				: record.namespace === "user"
					? "user"
					: record.namespace === "case"
						? "case"
						: "case-type-or-unknown";
		increment(report.byNamespaceClass, namespaceClass);
		increment(
			report.bySegmentCount,
			Array.isArray(record.segments)
				? String(record.segments.length)
				: "invalid-shape",
		);
	}
	for (const [key, child] of Object.entries(record)) {
		recordLegacyReferenceShapes(child, report, `${path}.${key}`, visit);
	}
}

function locateLegacyField(
	fieldUuid: string,
	rowsByUuid: ReadonlyMap<string, LegacyEntityRow>,
): {
	formUuid?: string;
	path: string[];
	reason:
		| "placed"
		| "null-parent"
		| "missing-parent"
		| "invalid-parent"
		| "cycle";
} {
	const path: string[] = [];
	const visited = new Set<string>();
	let current = rowsByUuid.get(fieldUuid);
	while (current?.kind === "field" && !visited.has(current.uuid)) {
		visited.add(current.uuid);
		if (typeof current.data.id === "string") path.unshift(current.data.id);
		if (current.parentUuid === null) return { path, reason: "null-parent" };
		const parent = rowsByUuid.get(current.parentUuid);
		if (parent === undefined) return { path, reason: "missing-parent" };
		if (parent.kind === "form") {
			return { formUuid: parent.uuid, path, reason: "placed" };
		}
		if (parent.kind !== "field") return { path, reason: "invalid-parent" };
		current = parent;
	}
	return {
		path,
		reason:
			current?.kind === "field" && visited.has(current.uuid)
				? "cycle"
				: "invalid-parent",
	};
}

function recordLegacyReferenceResolution(
	row: LegacyEntityRow,
	reference: Record<string, unknown>,
	rowsByUuid: ReadonlyMap<string, LegacyEntityRow>,
	fieldPathsByForm: ReadonlyMap<string, readonly string[][]>,
	caseTypeParent: ReadonlyMap<string, string | undefined>,
	report: RawReferenceShapes,
): void {
	const namespace = reference.namespace;
	const segments = reference.segments;
	if (typeof namespace !== "string" || !Array.isArray(segments)) return;
	const stringSegments = segments.filter(
		(segment): segment is string => typeof segment === "string",
	);
	if (stringSegments.length !== segments.length) return;
	if (namespace === "form") {
		const formUuid = locateLegacyField(row.uuid, rowsByUuid).formUuid;
		if (formUuid === undefined) {
			increment(report.formResolution, "owner-has-no-form");
			return;
		}
		const paths = fieldPathsByForm.get(formUuid) ?? [];
		const exact = paths.filter(
			(path) => path.join("/") === stringSegments.join("/"),
		).length;
		if (exact === 1) {
			increment(report.formResolution, "exact");
			return;
		}
		if (exact > 1) {
			increment(report.formResolution, "ambiguous-exact");
			return;
		}
		const leaf = stringSegments.at(-1);
		const sameLeaf =
			leaf === undefined
				? 0
				: paths.filter((path) => path.at(-1) === leaf).length;
		increment(
			report.formResolution,
			sameLeaf === 0
				? "no-candidate"
				: sameLeaf === 1
					? "one-same-form-leaf-candidate"
					: "multiple-same-form-leaf-candidates",
		);
		return;
	}
	if (namespace !== "case") return;
	let current: LegacyEntityRow | undefined = row;
	while (current?.kind === "field" && current.parentUuid !== null) {
		current = rowsByUuid.get(current.parentUuid);
	}
	const form =
		current?.kind === "form" ? current : rowsByUuid.get(row.parentUuid ?? "");
	const module =
		form?.kind === "form" && form.parentUuid !== null
			? rowsByUuid.get(form.parentUuid)
			: undefined;
	let caseType =
		module?.kind === "module" && typeof module.data.caseType === "string"
			? module.data.caseType
			: undefined;
	if (caseType === undefined) {
		increment(report.caseResolution, "owner-has-no-case-type");
		return;
	}
	const remaining = [...stringSegments];
	while (remaining[0] === "parent") {
		caseType = caseTypeParent.get(caseType);
		remaining.shift();
		if (caseType === undefined) {
			increment(report.caseResolution, "missing-parent-type");
			return;
		}
	}
	increment(
		report.caseResolution,
		remaining.length === 1 ? "contextual" : "invalid-segment-count",
	);
}

function recordSearchInputReferenceShapes(
	value: unknown,
	row: LegacyEntityRow,
	rowsByUuid: ReadonlyMap<string, LegacyEntityRow>,
	searchInputNamesByModule: ReadonlyMap<
		string,
		ReadonlyMap<string, readonly string[]>
	>,
	report: SearchInputReferenceShapes,
): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const child of value) {
			recordSearchInputReferenceShapes(
				child,
				row,
				rowsByUuid,
				searchInputNamesByModule,
				report,
			);
		}
		return;
	}
	const record = value as Record<string, unknown>;
	if (record.kind === "input" && typeof record.name === "string") {
		report.total++;
		const formUuid =
			row.kind === "field"
				? locateLegacyField(row.uuid, rowsByUuid).formUuid
				: row.kind === "form"
					? row.uuid
					: undefined;
		const form = formUuid === undefined ? undefined : rowsByUuid.get(formUuid);
		const moduleUuid =
			row.kind === "module"
				? row.uuid
				: form?.kind === "form"
					? (form.parentUuid ?? undefined)
					: undefined;
		if (moduleUuid === undefined) {
			increment(report.resolution, "owner-has-no-module");
		} else {
			const matches =
				searchInputNamesByModule.get(moduleUuid)?.get(record.name) ?? [];
			increment(
				report.resolution,
				matches.length === 1
					? "exact"
					: matches.length === 0
						? "missing"
						: "ambiguous",
			);
		}
	}
	for (const child of Object.values(record)) {
		recordSearchInputReferenceShapes(
			child,
			row,
			rowsByUuid,
			searchInputNamesByModule,
			report,
		);
	}
}

function summarizeFindings(
	findings: readonly CanonicalIdentityFinding[],
): Record<string, FindingSummary> {
	const out: Record<string, FindingSummary> = {};
	for (const finding of findings) {
		const prior = out[finding.code] ?? { count: 0, sampleDigests: [] };
		out[finding.code] = {
			count: prior.count + 1,
			sampleDigests:
				prior.sampleDigests.length >= 25
					? prior.sampleDigests
					: [...prior.sampleDigests, canonicalIdentityDigest(finding.path)],
		};
	}
	return out;
}

async function tableCountBytes<DB>(
	tx: Kysely<DB>,
	schema: string,
	table: string,
): Promise<CountBytes> {
	const result = await sql<CountBytes>`
		SELECT count(*)::text AS count,
		       coalesce(sum(pg_column_size(row_value)), 0)::text AS bytes
		FROM ${sql.id(schema, table)} AS row_value
	`.execute(tx);
	return result.rows[0] ?? { count: "0", bytes: "0" };
}

async function tableContentDigest<DB>(
	tx: Kysely<DB>,
	schema: string,
	table: string,
): Promise<string> {
	const result = await sql<{ row_text: string }>`
		SELECT to_jsonb(row_value)::text AS row_text
		FROM ${sql.id(schema, table)} AS row_value
		ORDER BY convert_to(to_jsonb(row_value)::text, 'UTF8')
	`.execute(tx);
	return frozenExactTextSequenceDigest(result.rows.map((row) => row.row_text));
}

function appCaseTypesCarrierId(appId: string): string {
	return `apps.case_types:${canonicalIdentityDigest(appId)}`;
}

function entityDataCarrierId(appId: string, uuid: string): string {
	return `blueprint_entities.data:${canonicalIdentityDigest([appId, uuid])}`;
}

function baselineSnapshotCarrierId(appId: string): string {
	return `app_change_fold_baselines.snapshot:${canonicalIdentityDigest(appId)}`;
}

function suffixMutationsCarrierId(appId: string, seq: string): string {
	return `app_changes.mutations:${canonicalIdentityDigest([appId, seq])}`;
}

function isFrozenCarrierDataError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		/^Frozen JSON carrier .+ \([0-9a-f]{64}\)\.$/.test(error.message)
	);
}

function verifiedJsonAt(
	values: ReadonlyMap<string, FrozenVerifiedJson>,
	id: string,
): FrozenVerifiedJson {
	const value = values.get(id);
	if (value === undefined) {
		throw new Error(`Verified frozen JSON carrier ${id} disappeared.`);
	}
	return value;
}

function materializeScannerJson<T>(
	value: FrozenVerifiedJson,
	family: string,
	allowSqlNull = false,
): T | null {
	const materialized = materializeFrozenBlueprintJson<T>(value, {
		id: `${family}:${value.sourceDigest}`,
	});
	if (materialized.kind === "sql-null") {
		if (!allowSqlNull) {
			throw new Error(`Frozen scanner ${family} carrier is SQL NULL.`);
		}
		return null;
	}
	return materialized.value;
}

function materializeNonNullScannerJson<T>(
	value: FrozenVerifiedJson,
	family: string,
): T {
	const materialized = materializeScannerJson<T>(value, family);
	if (materialized === null) {
		throw new Error(`Frozen scanner ${family} carrier is SQL NULL.`);
	}
	return materialized;
}

async function databaseCanonicalJsonDigest<DB>(
	tx: Kysely<DB>,
	value: unknown,
): Promise<string> {
	const candidateText = JSON.stringify(value);
	if (candidateText === undefined) {
		throw new Error("Post-horizon replay did not produce materializable JSON.");
	}
	const result = await sql<{ digest: string }>`
		SELECT encode(
			sha256(convert_to((${candidateText}::jsonb)::text, 'UTF8')),
			'hex'
		) AS digest
	`.execute(tx);
	const digest = result.rows[0]?.digest;
	if (digest === undefined) {
		throw new Error("PostgreSQL did not return the replay snapshot digest.");
	}
	return digest;
}

async function assertCompleteFrozenScanPlan<DB>(
	tx: Kysely<DB>,
	app: {
		readonly id: string;
		readonly app_name: string;
		readonly connect_type: string | null;
		readonly logo: string | null;
		readonly mutation_seq: string | number;
	},
	plan: CanonicalAppPlan,
	lookupContext: FrozenLookupValidationContext,
): Promise<void> {
	const candidates = [
		{
			id: `scan_app.case_types:${canonicalIdentityDigest(plan.appId)}`,
			candidate_text:
				plan.caseTypes === null ? null : JSON.stringify(plan.caseTypes),
		},
		...plan.rows.map((row) => ({
			id: `scan_entity.data:${canonicalIdentityDigest([plan.appId, row.uuid])}`,
			candidate_text: JSON.stringify(row.data),
		})),
	];
	const canonical = await sql<{ id: string; source_text: string | null }>`
		SELECT id, candidate_text::jsonb::text AS source_text
		FROM jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb)
			AS value(id text, candidate_text text)
		ORDER BY id
	`.execute(tx);
	const verified = await verifyFrozenJsonCarriers(
		tx,
		canonical.rows.map((row) => ({
			id: row.id,
			sourceText: row.source_text,
		})),
	);
	decodeFrozenStoredApp(
		{
			id: app.id,
			appName: app.app_name,
			connectType: app.connect_type,
			caseTypes: verifiedJsonAt(
				verified,
				`scan_app.case_types:${canonicalIdentityDigest(plan.appId)}`,
			),
			logo: app.logo,
			mutationSeq: app.mutation_seq,
		},
		plan.rows.map((row) => ({
			appId: row.appId,
			uuid: row.uuid,
			kind: row.kind,
			parentUuid: row.parentUuid,
			ordinal: row.ordinal,
			data: verifiedJsonAt(
				verified,
				`scan_entity.data:${canonicalIdentityDigest([plan.appId, row.uuid])}`,
			),
		})),
		lookupContext,
	);
}

export async function scanFrozenCanonicalIdentityFoundation<DB>(
	db: Kysely<DB>,
	options: FrozenCanonicalIdentityScanOptions = {},
) {
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.execute(async (tx) => {
			await sql`SET LOCAL lock_timeout = '15s'`.execute(tx);
			await sql`SET LOCAL statement_timeout = '960s'`.execute(tx);
			await sql`
				SET LOCAL idle_in_transaction_session_timeout = '990s'
			`.execute(tx);
			const findings: CanonicalIdentityFinding[] = [];
			const appCountText = (
				await sql<{ count: string }>`
					SELECT count(*)::text AS count
					FROM public.apps
				`.execute(tx)
			).rows[0]?.count;
			if (
				appCountText === undefined ||
				!/^(?:0|[1-9][0-9]*)$/.test(appCountText)
			) {
				throw new Error("Frozen scanner app count is unavailable.");
			}
			const observedRelations = (
				await sql<{ schema_name: string; table_name: string }>`
					SELECT namespace.nspname AS schema_name,
					       class.relname AS table_name
					FROM pg_catalog.pg_class AS class
					JOIN pg_catalog.pg_namespace AS namespace
					  ON namespace.oid = class.relnamespace
					WHERE class.relkind IN ('r', 'p')
					  AND (namespace.nspname, class.relname) IN (
						${sql.join(
							FROZEN_RELATION_CANDIDATE_PHYSICAL_RELATIONS.map(
								(relation) => sql`(${relation.schema}, ${relation.table})`,
							),
						)}
					  )
					ORDER BY
						convert_to(namespace.nspname, 'UTF8'),
						convert_to(class.relname, 'UTF8')
				`.execute(tx)
			).rows.map(
				(row): FrozenPhysicalRelation => ({
					schema: row.schema_name,
					table: row.table_name,
				}),
			);
			const frozenCatalogDb = tx as unknown as Kysely<unknown>;
			const observedFoldObjectKeys =
				await readFrozenFoldFamilyObjectKeys(frozenCatalogDb);
			const authoredSqlType = (
				await sql<{ data_type: string }>`
					SELECT data_type
					FROM information_schema.columns
					WHERE table_schema = 'public'
					  AND table_name = 'blueprint_entities'
					  AND column_name = 'uuid'
				`.execute(tx)
			).rows[0]?.data_type;
			const identitySqlType: FrozenScannerIdentitySqlType =
				authoredSqlType === "text" || authoredSqlType === "uuid"
					? authoredSqlType
					: "other";
			const catalogLifecycle = classifyFrozenObservedCatalogLifecycle({
				purpose: "migration-or-scan",
				appCount: appCountText,
				observedRelations,
				observedFoldObjectKeys,
			});
			const projectForeignKeyState = await classifyFrozenProjectForeignKeys(
				frozenCatalogDb,
				catalogLifecycle.canonicalPhase,
			);
			const catalogFinding = catalogLifecycleFinding(catalogLifecycle);
			if (catalogFinding !== null) findings.push(catalogFinding);
			if (
				catalogLifecycle.canonicalPhase === "final" &&
				projectForeignKeyState !== "final"
			) {
				findings.push({
					disposition: "block-current",
					carrierId: "catalog.project-foreign-keys",
					code: "invalid-legacy-shape",
					path: "catalog.project-foreign-keys",
					digest: canonicalIdentityDigest(projectForeignKeyState),
				});
			}
			const cutoverState = classifyFrozenScannerCutoverState({
				identitySqlType,
				catalogLifecycle,
			});
			if (options.deployedFoldSecurity !== undefined) {
				try {
					await assertFrozenFoldBaselineCatalog(frozenCatalogDb, {
						phase: "deployed",
						...options.deployedFoldSecurity,
					});
					await assertFrozenMediaReferenceCatalog(frozenCatalogDb, {
						phase: "deployed",
						...options.deployedFoldSecurity,
					});
					await assertFrozenSqlIdentityStructuralCatalog(
						frozenCatalogDb,
						"uuid",
					);
				} catch (error) {
					findings.push({
						disposition: "block-current",
						carrierId: "catalog.terminal-structure-and-security",
						code: "invalid-legacy-shape",
						path: "catalog.terminal-structure-and-security",
						digest: canonicalIdentityDigest(
							error instanceof Error ? error.message : "unknown",
						),
					});
				}
				if (
					catalogLifecycle.state !== "drift" &&
					catalogLifecycle.state !== "repair-not-applicable" &&
					(cutoverState !== "applied" ||
						catalogLifecycle.state !== "final" ||
						catalogLifecycle.canonicalPhase !== "final" ||
						catalogLifecycle.privilegePhase !== "post-privilege" ||
						catalogLifecycle.foldFamily.state !== "final" ||
						catalogLifecycle.relations.authState !== "complete" ||
						projectForeignKeyState !== "final" ||
						catalogLifecycle.relations.cases.state !== "runtime-post-privilege")
				) {
					findings.push({
						disposition: "block-current",
						carrierId: "terminal-audit-state",
						code: "invalid-legacy-shape",
						path: "catalog.terminal-audit-state",
						digest: canonicalIdentityDigest(cutoverState),
					});
				}
			}
			const catalogLifecycleSummary = summarizeCatalogLifecycle(
				catalogLifecycle,
				observedFoldObjectKeys,
				projectForeignKeyState,
			);
			const resolvedCasesRelation = catalogLifecycle.relations.cases.relation;
			if (
				resolvedCasesRelation?.schema !== "public" &&
				resolvedCasesRelation?.schema !== "nova_case_runtime"
			) {
				return {
					version: CANONICAL_IDENTITY_MIGRATION_VERSION,
					mode: options.locked ? "locked" : "advisory",
					complete: false as const,
					catalogLifecycle: catalogLifecycleSummary,
					findings: summarizeFindings(findings),
					findingCount: findings.length,
					cutoverPlan: {
						state: "drift" as const,
					},
				};
			}
			const casesSchema = resolvedCasesRelation.schema;
			const existingFrozenRelations =
				catalogLifecycle.relations.lockableRelations.map((relation) => ({
					schema_name: relation.schema,
					table_name: relation.table,
				}));
			const existingOccurrenceTables = new Set(
				observedRelations
					.filter((relation) => relation.schema === "public")
					.map((relation) => relation.table),
			);
			if (options.locked && existingFrozenRelations.length > 0) {
				await sql`
						LOCK TABLE ${sql.join(
							existingFrozenRelations.map((relation) =>
								sql.id(relation.schema_name, relation.table_name),
							),
						)} IN SHARE ROW EXCLUSIVE MODE
				`.execute(tx);
			}
			const catalogEvidence = await captureFrozenCutoverCatalogEvidence(
				tx,
				casesSchema,
			);
			const storageSnapshot = await captureFrozenStorageSnapshot(tx);
			const occurrenceProjections =
				dispatchFrozenStorageOccurrences(storageSnapshot);
			const baselineRows =
				catalogLifecycle.foldFamily.state === "final"
					? (
							await sql<{
								app_id: string;
								seq: string;
								project_id: string;
								snapshot_text: string;
								snapshot_digest: string;
								computed_snapshot_digest: string;
								current_snapshot_digest: string;
								batch_id: string;
								run_id: string | null;
								actor_id: string;
								kind: string;
								marker_mutations_are_empty: boolean;
								from_project_id: string | null;
								to_project_id: string | null;
								app_owner: string;
							}>`
							SELECT DISTINCT ON (convert_to(baseline.app_id, 'UTF8'))
								baseline.app_id,
								baseline.seq::text,
								baseline.project_id,
								baseline.snapshot::text AS snapshot_text,
								baseline.snapshot_digest,
								encode(
									sha256(convert_to(baseline.snapshot::text, 'UTF8')),
									'hex'
								) AS computed_snapshot_digest,
								encode(
									sha256(
										convert_to(
											nova_current_app_change_fold_snapshot(
												baseline.app_id
											)::text,
											'UTF8'
										)
									),
									'hex'
								) AS current_snapshot_digest,
								marker.batch_id,
								marker.run_id,
								marker.actor_id,
								marker.kind,
								marker.mutations = '[]'::jsonb
									AS marker_mutations_are_empty,
								marker.from_project_id,
								marker.to_project_id,
								app.owner AS app_owner
							FROM app_change_fold_baselines AS baseline
							JOIN app_changes AS marker
							  ON marker.app_id = baseline.app_id
							 AND marker.seq = baseline.seq
							JOIN apps AS app ON app.id = baseline.app_id
							ORDER BY
								convert_to(baseline.app_id, 'UTF8'),
								baseline.seq DESC
						`.execute(tx)
						).rows
					: [];
			const baselineByApp = new Map(
				baselineRows.map((row) => [row.app_id, row] as const),
			);
			const suffixRows =
				catalogLifecycle.foldFamily.state === "final"
					? (
							await sql<{
								app_id: string;
								seq: string;
								batch_id: string;
								run_id: string | null;
								actor_id: string;
								kind: string;
								mutations_text: string;
								from_project_id: string | null;
								to_project_id: string | null;
							}>`
							WITH latest AS (
								SELECT DISTINCT ON (convert_to(app_id, 'UTF8'))
									app_id, seq
								FROM app_change_fold_baselines
								ORDER BY convert_to(app_id, 'UTF8'), seq DESC
							)
							SELECT mutation.app_id, mutation.seq::text,
							       mutation.batch_id, mutation.run_id,
							       mutation.actor_id, mutation.kind,
							       mutation.mutations::text AS mutations_text,
							       mutation.from_project_id,
							       mutation.to_project_id
							FROM app_changes AS mutation
							JOIN latest
							  ON latest.app_id = mutation.app_id
							 AND mutation.seq > latest.seq
							ORDER BY convert_to(mutation.app_id, 'UTF8'), mutation.seq
						`.execute(tx)
						).rows
					: [];
			const suffixByApp = new Map<string, typeof suffixRows>();
			for (const row of suffixRows) {
				const rows = suffixByApp.get(row.app_id) ?? [];
				rows.push(row);
				suffixByApp.set(row.app_id, rows);
			}

			const appRows = (
				await sql<{
					id: string;
					project_id: string | null;
					app_name: string;
					connect_type: string | null;
					case_types_text: string | null;
					logo: string | null;
					mutation_seq: string;
				}>`
					SELECT id, project_id, app_name, connect_type,
					       case_types::text AS case_types_text,
					       logo::text, mutation_seq::text
					FROM apps
					ORDER BY convert_to(id, 'UTF8')
				`.execute(tx)
			).rows;
			const invalidProjectApps = await sql<{
				id: string;
				owner: string;
				project_id: string | null;
			}>`
				SELECT id, owner, project_id
				FROM public.apps
				WHERE project_id IS NULL OR btrim(project_id) = ''
				ORDER BY convert_to(id, 'UTF8')
			`.execute(tx);
			const authOrganizationPresent = observedRelations.some(
				(relation) =>
					relation.schema === "public" &&
					relation.table === "auth_organization",
			);
			const missingProjectTargets = authOrganizationPresent
				? await sql<{
						id: string;
						project_id: string;
					}>`
						SELECT app.id, app.project_id
						FROM public.apps AS app
						LEFT JOIN public.auth_organization AS project
						  ON project.id = app.project_id
						WHERE app.project_id IS NOT NULL
						  AND btrim(app.project_id) <> ''
						  AND project.id IS NULL
						ORDER BY convert_to(app.id, 'UTF8')
					`.execute(tx)
				: { rows: [] };
			const appsWithoutAuthCatalog = authOrganizationPresent
				? []
				: appRows.flatMap((app) =>
						app.project_id !== null && app.project_id.trim().length > 0
							? [{ id: app.id, project_id: app.project_id }]
							: [],
					);
			const invalidProjectCases = await sql<{
				app_id: string;
				case_id: string;
				project_id: string | null;
				app_project_id: string | null;
			}>`
				SELECT
					case_row.app_id,
					case_row.case_id::text,
					case_row.project_id,
					app.project_id AS app_project_id
				FROM ${sql.id(casesSchema, "cases")} AS case_row
				LEFT JOIN public.apps AS app ON app.id = case_row.app_id
				WHERE case_row.project_id IS NULL
				   OR btrim(case_row.project_id) = ''
				   OR app.id IS NULL
				   OR app.project_id IS NULL
				   OR btrim(app.project_id) = ''
				   OR case_row.project_id <> app.project_id
				ORDER BY
					convert_to(case_row.app_id, 'UTF8'),
					convert_to(case_row.case_id::text, 'UTF8')
			`.execute(tx);
			findings.push(
				...frozenProjectTenancyFindings({
					invalidApps: invalidProjectApps.rows,
					missingProjectTargets: missingProjectTargets.rows,
					invalidCases: invalidProjectCases.rows,
					appsWithoutAuthCatalog,
				}),
			);
			let exactFrozenProjectOrphan = false;
			let frozenProjectOrphanSummary: FrozenProjectOrphanSummary | null = null;
			if (invalidProjectApps.rows.length === 1) {
				const candidate = invalidProjectApps.rows[0];
				if (candidate !== undefined) {
					try {
						const summary = summarizeFrozenProjectOrphanInventory(
							candidate.id,
							await captureFrozenProjectOrphanInventory(
								tx,
								candidate.id,
								candidate.owner,
								candidate.project_id,
							),
						);
						assertFrozenProjectOrphanSummary(summary);
						exactFrozenProjectOrphan = true;
						frozenProjectOrphanSummary = summary;
					} catch {
						// The content-free counts and digests below preserve the
						// evidence needed to distinguish source drift.
					}
				}
			}
			const entityRows = (
				await sql<{
					app_id: string;
					uuid: string;
					kind: string;
					parent_uuid: string | null;
					ordinal: number;
					data_text: string;
				}>`
					SELECT app_id, uuid::text, kind, parent_uuid::text,
					       ordinal, data::text AS data_text
					FROM blueprint_entities
					ORDER BY
						convert_to(app_id, 'UTF8'),
						convert_to(kind, 'UTF8'),
						convert_to(parent_uuid::text, 'UTF8') NULLS FIRST,
						ordinal,
						convert_to(uuid::text, 'UTF8')
				`.execute(tx)
			).rows;
			let verifiedJson: ReadonlyMap<string, FrozenVerifiedJson> | undefined;
			try {
				verifiedJson = await verifyFrozenJsonCarriers(tx, [
					...appRows.map((row) => ({
						id: appCaseTypesCarrierId(row.id),
						sourceText: row.case_types_text,
					})),
					...entityRows.map((row) => ({
						id: entityDataCarrierId(row.app_id, row.uuid),
						sourceText: row.data_text,
					})),
					...baselineRows.map((row) => ({
						id: baselineSnapshotCarrierId(row.app_id),
						sourceText: row.snapshot_text,
					})),
					...suffixRows.map((row) => ({
						id: suffixMutationsCarrierId(row.app_id, row.seq),
						sourceText: row.mutations_text,
					})),
				]);
			} catch (error) {
				if (!isFrozenCarrierDataError(error)) throw error;
				findings.push({
					disposition: "block-current",
					carrierId: "storage.jsonb-round-trip",
					code: "invalid-legacy-shape",
					path: "storage.jsonb-round-trip",
					digest: canonicalIdentityDigest(error.message),
				});
			}
			const lookupTables = (
				await sql<{ project_id: string; id: string }>`
					SELECT project_id, id::text AS id
					FROM lookup_tables
					ORDER BY project_id, id
				`.execute(tx)
			).rows;
			const byApp = new Map<string, typeof entityRows>();
			for (const row of entityRows) {
				const values = byApp.get(row.app_id) ?? [];
				values.push(row);
				byApp.set(row.app_id, values);
			}

			for (const occurrence of occurrenceProjections) {
				if (
					occurrence.disposition !== "block-current" ||
					occurrence.rowCount === 0
				) {
					continue;
				}
				findings.push({
					disposition: "block-current",
					carrierId: occurrence.id,
					code: "invalid-legacy-shape",
					path: `storage.${occurrence.id}`,
					digest: occurrence.digest,
				});
			}
			const optionIdentityShapes: OptionIdentityShapes = {
				total: 0,
				missing: 0,
				nonString: 0,
				canonical: 0,
				preCutoverPositionDerivedExact: 0,
				preCutoverPositionDerivedStale: 0,
				uuidLexicalNoncanonical: 0,
				otherString: 0,
				uppercase: 0,
				byLength: {},
				byVersionNibble: {},
				byVariantNibble: {},
			};
			const rawReferenceShapes: RawReferenceShapes = {
				total: 0,
				byNamespaceClass: {},
				bySegmentCount: {},
				formResolution: {},
				caseResolution: {},
				sampleDigests: [],
			};
			const blueprintStructureShapes: BlueprintStructureShapes = {
				fieldPlacement: {},
				formPlacement: {},
			};
			const searchInputReferenceShapes: SearchInputReferenceShapes = {
				total: 0,
				resolution: {},
			};
			const rewriteTotals = {
				proseTemplates: 0,
				xpathExpressions: 0,
				pathRefs: 0,
				rawRefs: 0,
				searchInputRefs: 0,
				selectSources: 0,
				optionUuids: 0,
				standardPropertyReferences: 0,
				catalogProperties: 0,
				connectEmptyDeletes: 0,
				datePatterns: 0,
				postSubmitDestinations: 0,
				caseWriteBindings: 0,
			};
			const appDigests: string[] = [];
			const canonicalPlans: CanonicalAppPlan[] = [];
			const cutoverApps: FrozenCutoverAppDisposition[] = [];
			const cutoverLookupContexts = new Map<
				string,
				FrozenCutoverLookupContextEvidence
			>();
			const latestHorizons: Array<{
				app: string;
				seq: string;
				kind: string | null;
			}> = [];

			for (const app of appRows) {
				if (verifiedJson === undefined) continue;
				const appCaseTypes = materializeScannerJson<unknown>(
					verifiedJsonAt(verifiedJson, appCaseTypesCarrierId(app.id)),
					"scanner_app",
					true,
				);
				let lookupContext: FrozenLookupValidationContext | undefined;
				if (app.project_id !== null) {
					try {
						lookupContext = await readFrozenProjectLookupContext(
							tx,
							app.project_id,
						);
						const projectDigest = canonicalIdentityDigest(app.project_id);
						cutoverLookupContexts.set(projectDigest, {
							projectDigest,
							tableCount: lookupContext.definitions.length.toString(),
							columnCount: lookupContext.definitions
								.reduce(
									(total, definition) =>
										total + BigInt(definition.columns.length),
									BigInt(0),
								)
								.toString(),
							contextDigest: canonicalIdentityDigest(lookupContext),
						});
					} catch {
						// The identity inventory below reports malformed definitions.
						// Keep every full gate fail-closed instead of fabricating context.
						lookupContext = undefined;
					}
				}
				const appEntityRows = (byApp.get(app.id) ?? []).map((row) => ({
					appId: row.app_id,
					uuid: row.uuid,
					kind: row.kind as LegacyEntityKind,
					parentUuid: row.parent_uuid,
					ordinal: row.ordinal,
					data: materializeNonNullScannerJson<Record<string, unknown>>(
						verifiedJsonAt(
							verifiedJson,
							entityDataCarrierId(row.app_id, row.uuid),
						),
						"scanner_entity",
					),
				}));
				const rowsByUuid = new Map(
					appEntityRows.map((row) => [row.uuid, row] as const),
				);
				const searchInputNamesByModule = new Map<
					string,
					Map<string, string[]>
				>();
				for (const row of appEntityRows) {
					if (row.kind !== "module") continue;
					const config =
						row.data.caseListConfig &&
						typeof row.data.caseListConfig === "object" &&
						!Array.isArray(row.data.caseListConfig)
							? (row.data.caseListConfig as Record<string, unknown>)
							: undefined;
					const byName = new Map<string, string[]>();
					for (const input of Array.isArray(config?.searchInputs)
						? config.searchInputs
						: []) {
						if (!input || typeof input !== "object" || Array.isArray(input)) {
							continue;
						}
						const record = input as Record<string, unknown>;
						if (
							typeof record.name !== "string" ||
							typeof record.uuid !== "string"
						) {
							continue;
						}
						const matches = byName.get(record.name) ?? [];
						matches.push(record.uuid);
						byName.set(record.name, matches);
					}
					searchInputNamesByModule.set(row.uuid, byName);
				}
				const fieldPathsByForm = new Map<string, string[][]>();
				for (const row of appEntityRows) {
					if (row.kind !== "field") continue;
					const located = locateLegacyField(row.uuid, rowsByUuid);
					increment(blueprintStructureShapes.fieldPlacement, located.reason);
					if (located.formUuid === undefined) continue;
					const paths = fieldPathsByForm.get(located.formUuid) ?? [];
					paths.push(located.path);
					fieldPathsByForm.set(located.formUuid, paths);
				}
				for (const row of appEntityRows) {
					if (row.kind !== "form") continue;
					const parent =
						row.parentUuid === null
							? undefined
							: rowsByUuid.get(row.parentUuid);
					increment(
						blueprintStructureShapes.formPlacement,
						row.parentUuid === null
							? "null-parent"
							: parent === undefined
								? "missing-parent"
								: parent.kind === "module"
									? "placed"
									: "invalid-parent",
					);
				}
				const caseTypeParent = new Map<string, string | undefined>();
				if (Array.isArray(appCaseTypes)) {
					for (const value of appCaseTypes) {
						if (
							value &&
							typeof value === "object" &&
							!Array.isArray(value) &&
							typeof (value as Record<string, unknown>).name === "string"
						) {
							const record = value as Record<string, unknown>;
							caseTypeParent.set(
								record.name as string,
								typeof record.parent_type === "string"
									? record.parent_type
									: undefined,
							);
						}
					}
				}
				for (const row of appEntityRows) {
					recordLegacyReferenceShapes(
						row.data,
						rawReferenceShapes,
						`entities.${row.kind}.${row.uuid}`,
						(reference) =>
							recordLegacyReferenceResolution(
								row,
								reference,
								rowsByUuid,
								fieldPathsByForm,
								caseTypeParent,
								rawReferenceShapes,
							),
					);
					recordSearchInputReferenceShapes(
						row.data,
						row,
						rowsByUuid,
						searchInputNamesByModule,
						searchInputReferenceShapes,
					);
					if (row.kind !== "field") continue;
					const legacyOptions = Array.isArray(row.data.options)
						? row.data.options
						: undefined;
					const source =
						row.data.optionsSource &&
						typeof row.data.optionsSource === "object" &&
						!Array.isArray(row.data.optionsSource)
							? (row.data.optionsSource as Record<string, unknown>)
							: undefined;
					const sourceOptions =
						source?.kind === "inline" && Array.isArray(source.options)
							? source.options
							: undefined;
					for (const [index, option] of (
						sourceOptions ??
						legacyOptions ??
						[]
					).entries()) {
						recordOptionIdentityShape(
							optionIdentityShapes,
							option && typeof option === "object"
								? (option as Record<string, unknown>).uuid
								: undefined,
							row.uuid,
							index,
						);
					}
				}
				recordLegacyReferenceShapes(
					appCaseTypes,
					rawReferenceShapes,
					"apps.case_types",
				);
				const snapshot: LegacyAppSnapshot = {
					appId: app.id,
					appName: app.app_name,
					connectType: app.connect_type,
					caseTypes: appCaseTypes,
					logo: app.logo,
					mutationSeq: app.mutation_seq,
					rows: appEntityRows,
				};
				const plan = planCanonicalAppMigration(snapshot);
				canonicalPlans.push(plan);
				try {
					if (lookupContext === undefined) {
						throw new Error("exact Project lookup context is unavailable");
					}
					await assertCompleteFrozenScanPlan(tx, app, plan, lookupContext);
				} catch (error) {
					findings.push({
						disposition: "block-current",
						carrierId: "complete-frozen-blueprint",
						code: "invalid-legacy-shape",
						path: `apps.${canonicalIdentityDigest(app.id)}.completeBlueprint`,
						digest: canonicalIdentityDigest(
							error instanceof Error ? error.message : "unknown",
						),
					});
				}
				findings.push(
					...plan.findings.map((finding) => ({
						...finding,
						path: `apps.${canonicalIdentityDigest(app.id)}.${finding.path}`,
					})),
				);
				for (const key of Object.keys(rewriteTotals) as Array<
					keyof typeof rewriteTotals
				>) {
					rewriteTotals[key] += plan.rewrites[key];
				}
				// FROZEN_COMPLETE_BLUEPRINT_DECODER_INTEGRATION:
				// Decode the complete frozen persistable snapshot here after the
				// exact JSON carrier proof and before accepting a scanner-clean plan.
				const appDigest = canonicalIdentityDigest(app.id);
				const baseline = baselineByApp.get(app.id);
				if (authoredSqlType === "uuid" && baseline === undefined) {
					findings.push({
						disposition: "block-current",
						carrierId: "app-change-fold-baseline",
						code: "invalid-fold-baseline",
						path: `apps.${appDigest}.appChangeFoldBaseline`,
						digest: canonicalIdentityDigest("missing"),
					});
				}
				if (baseline !== undefined) {
					const markerIsExact =
						baseline.kind === "fold-baseline" &&
						baseline.marker_mutations_are_empty &&
						baseline.from_project_id === null &&
						baseline.to_project_id === null &&
						((baseline.batch_id ===
							"fold-baseline:canonical-identity-foundation" &&
							baseline.run_id === null &&
							baseline.actor_id === "system:canonical-identity-foundation") ||
							(baseline.seq === "1" &&
								baseline.batch_id === `genesis:${baseline.app_id}` &&
								baseline.actor_id === baseline.app_owner &&
								typeof baseline.run_id === "string" &&
								baseline.run_id.length > 0));
					if (
						!markerIsExact ||
						baseline.snapshot_digest !== baseline.computed_snapshot_digest
					) {
						findings.push({
							disposition: "block-current",
							carrierId: "app-change-fold-baseline",
							code: "invalid-fold-baseline",
							path: `apps.${appDigest}.appChangeFoldBaseline`,
							digest: canonicalIdentityDigest({
								markerIsExact,
								digestMatches:
									baseline.snapshot_digest ===
									baseline.computed_snapshot_digest,
							}),
						});
					} else {
						try {
							if (lookupContext === undefined) {
								throw new Error("exact Project lookup context is unavailable");
							}
							verifiedJsonAt(verifiedJson, baselineSnapshotCarrierId(app.id));
							const suffix = (suffixByApp.get(app.id) ?? []).map((row) => ({
								seq: row.seq,
								batch_id: row.batch_id,
								run_id: row.run_id,
								actor_id: row.actor_id,
								kind: row.kind,
								from_project_id: row.from_project_id,
								to_project_id: row.to_project_id,
								mutationsText: row.mutations_text,
							}));
							if (suffix.length === 0) {
								if (
									app.mutation_seq !== baseline.seq ||
									baseline.snapshot_digest !== baseline.current_snapshot_digest
								) {
									throw new Error("app-change fold mismatch");
								}
							} else {
								const replayed = replayFrozenCanonicalAppChangeSuffix({
									baselineSnapshotText: baseline.snapshot_text,
									baselineSeq: baseline.seq,
									baselineProjectId: baseline.project_id,
									expectedHeadSeq: app.mutation_seq,
									expectedFinalProjectId: app.project_id ?? "",
									suffix,
									finalLookupContext: lookupContext,
								});
								if (
									(await databaseCanonicalJsonDigest(tx, replayed.snapshot)) !==
									baseline.current_snapshot_digest
								) {
									throw new Error("app-change fold mismatch");
								}
							}
						} catch (error) {
							findings.push({
								disposition: "block-current",
								carrierId: "app-change-suffix",
								code: "app-change-replay-mismatch",
								path: `apps.${appDigest}.appChangeSuffix`,
								digest: canonicalIdentityDigest(
									error instanceof Error ? error.message : "unknown",
								),
							});
						}
					}
				}
				appDigests.push(
					canonicalIdentityDigest({
						app: canonicalIdentityDigest(app.id),
						before: plan.beforeDigest,
						after: plan.afterDigest,
					}),
				);
				cutoverApps.push({
					appDigest,
					projectDigest:
						app.project_id === null
							? null
							: canonicalIdentityDigest(app.project_id),
					sourceDigest: plan.beforeDigest,
					canonicalDigest: plan.afterDigest,
					sequence: app.mutation_seq,
					disposition:
						plan.findings.length > 0
							? "block"
							: plan.beforeDigest === plan.afterDigest
								? "preserve"
								: "rewrite",
					lookupContextDigest:
						lookupContext === undefined
							? null
							: canonicalIdentityDigest(lookupContext),
					referenceIndexDigest: canonicalIdentityDigest({
						app: appDigest,
						candidate: plan.afterDigest,
						family: "reference-index",
					}),
					schemaDefinitionDigest: canonicalIdentityDigest({
						app: appDigest,
						candidate: plan.afterDigest,
						family: "case-schema",
					}),
					findingsDigest: canonicalIdentityDigest(plan.findings),
				});
			}

			const lookupColumns = (
				await sql<{ project_id: string; table_id: string; id: string }>`
					SELECT project_id, table_id::text AS table_id, id::text AS id
					FROM lookup_columns
					ORDER BY project_id, table_id, id
				`.execute(tx)
			).rows;
			const lookupRows = await sql<{
				project_id: string;
				table_id: string;
				id: string;
				values_text: string;
			}>`
				SELECT project_id, table_id, id, values::text AS values_text
				FROM lookup_rows
				ORDER BY project_id, table_id, id
			`.execute(tx);
			const lookupRowCarrierEntries = lookupRows.rows.map((row) => ({
				id: `lookup_rows.values:${canonicalIdentityDigest([
					row.project_id,
					row.table_id,
					row.id,
				])}`,
				sourceText: row.values_text,
			}));
			const lookupRowCarriers = await verifyFrozenJsonCarriers(
				tx,
				lookupRowCarrierEntries,
			);
			findings.push(
				...scanLookupIdentities({
					tables: lookupTables.map((row) => ({
						projectId: row.project_id,
						id: row.id,
					})),
					columns: lookupColumns.map((row) => ({
						projectId: row.project_id,
						tableId: row.table_id,
						id: row.id,
					})),
					rows: lookupRows.rows.map((row, index) => ({
						projectId: row.project_id,
						tableId: row.table_id,
						id: row.id,
						values: materializeNonNullScannerJson(
							verifiedJsonAt(
								lookupRowCarriers,
								lookupRowCarrierEntries[index]?.id ?? "",
							),
							"scanner_lookup",
						),
					})),
				}),
			);

			const mediaRows = await sql<{
				id: string;
				project_id: string;
				status: string;
				kind: string;
			}>`
				SELECT id::text AS id, project_id, status, kind
				FROM media_assets
				ORDER BY id
			`.execute(tx);
			const mediaById = new Map(
				mediaRows.rows.map((row) => [row.id, row] as const),
			);
			for (const row of mediaRows.rows) {
				if (!isCanonicalAuthoredUuid(row.id)) {
					findings.push({
						disposition: "block-current",
						carrierId: "media-asset",
						code: "invalid-authored-uuid",
						path: `media_assets.${canonicalIdentityDigest(row.id)}.id`,
						digest: canonicalIdentityDigest(row.id),
					});
				}
			}
			const blueprintMediaApps = appRows.flatMap((app) =>
				app.project_id === null || app.project_id.trim().length === 0
					? []
					: [
							{
								id: app.id,
								project_id: app.project_id,
								logo: app.logo,
							},
						],
			);
			const blueprintMediaAppIds = new Set(
				blueprintMediaApps.map((app) => app.id),
			);
			try {
				frozenBlueprintMediaReferenceEdges(
					blueprintMediaApps,
					canonicalPlans.filter((plan) => blueprintMediaAppIds.has(plan.appId)),
					mediaRows.rows,
				);
			} catch (error) {
				findings.push({
					disposition: "block-current",
					carrierId: "blueprint-media-reference",
					code: "invalid-legacy-shape",
					path: "blueprint.media.exact-authored-slot-kinds",
					digest: canonicalIdentityDigest(
						error instanceof Error ? error.message : "unknown",
					),
				});
			}
			for (const row of (
				await sql<{
					attempt_asset_id: string;
					canonical_asset_id: string;
				}>`
					SELECT
						attempt_asset_id::text AS attempt_asset_id,
						canonical_asset_id::text AS canonical_asset_id
					FROM media_upload_aliases
					ORDER BY attempt_asset_id, canonical_asset_id
				`.execute(tx)
			).rows) {
				for (const [key, value] of Object.entries(row)) {
					if (!isCanonicalAuthoredUuid(value)) {
						findings.push({
							disposition: "block-current",
							carrierId: "media-upload-alias",
							code: "invalid-authored-uuid",
							path: `media_upload_aliases.${canonicalIdentityDigest(row)}.${key}`,
							digest: canonicalIdentityDigest(value),
						});
					}
				}
			}
			for (const row of (
				await sql<{ asset_id: string }>`
					SELECT asset_id::text AS asset_id
					FROM media_asset_refs
					ORDER BY asset_id
				`.execute(tx)
			).rows) {
				if (!isCanonicalAuthoredUuid(row.asset_id)) {
					findings.push({
						disposition: "block-current",
						carrierId: "media-asset-reference",
						code: "invalid-authored-uuid",
						path: `media_asset_refs.${canonicalIdentityDigest(row)}.asset_id`,
						digest: canonicalIdentityDigest(row.asset_id),
					});
				}
			}
			const intentRows = await sql<{
				form_uuid: string;
				result_text: string | null;
				operation_index: string | null;
				operation_uuid: string | null;
			}>`
				SELECT
					intent.form_uuid::text AS form_uuid,
					intent.result::text AS result_text,
					(operation.ordinality - 1)::text AS operation_index,
					operation.value ->> 'operationUuid' AS operation_uuid
				FROM form_submission_intents AS intent
				LEFT JOIN LATERAL jsonb_array_elements(
					CASE
						WHEN jsonb_typeof(intent.result -> 'operations') = 'array'
						THEN intent.result -> 'operations'
						ELSE '[]'::jsonb
					END
				) WITH ORDINALITY AS operation(value, ordinality) ON TRUE
				ORDER BY intent.form_uuid::text, intent.result::text, operation.ordinality
			`.execute(tx);
			for (const row of intentRows.rows) {
				const rowDigest = canonicalIdentityDigest([
					row.form_uuid,
					row.result_text,
				]);
				if (!isCanonicalAuthoredUuid(row.form_uuid)) {
					findings.push({
						disposition: "block-current",
						carrierId: "form-submission-intent",
						code: "invalid-authored-uuid",
						path: `form_submission_intents.${rowDigest}.form_uuid`,
						digest: canonicalIdentityDigest(row.form_uuid),
					});
				}
				if (
					row.operation_index !== null &&
					!isCanonicalAuthoredUuid(row.operation_uuid)
				) {
					findings.push({
						disposition: "block-current",
						carrierId: "form-submission-operation",
						code: "invalid-authored-uuid",
						path: `form_submission_intents.${rowDigest}.result.operations[${row.operation_index}].operationUuid`,
						digest: canonicalIdentityDigest(row.operation_uuid),
					});
				}
			}
			for (const row of (
				await sql<{ field_uuid: string }>`
					SELECT field_uuid::text AS field_uuid
					FROM form_attachments
					ORDER BY field_uuid
				`.execute(tx)
			).rows) {
				if (!isCanonicalAuthoredUuid(row.field_uuid)) {
					findings.push({
						disposition: "block-current",
						carrierId: "form-attachment",
						code: "invalid-authored-uuid",
						path: `form_attachments.${canonicalIdentityDigest(row)}.field_uuid`,
						digest: canonicalIdentityDigest(row.field_uuid),
					});
				}
			}

			const eventStats = await sql<{
				mutation_rows: string;
				attachment_refs: string;
				receipt_rows: string;
				event_bytes: string;
			}>`
				SELECT
					count(*) FILTER (WHERE kind = 'mutation')::text AS mutation_rows,
					COALESCE(sum(
						CASE
							WHEN jsonb_typeof(event -> 'payload' -> 'attachments') = 'array'
							THEN jsonb_array_length(event -> 'payload' -> 'attachments')
							ELSE 0
						END
					), 0)::text AS attachment_refs,
					count(*) FILTER (
						WHERE kind = 'conversation'
						  AND event #>> '{payload,type}' IN ('tool-call', 'tool-result')
					)::text AS receipt_rows,
					COALESCE(sum(octet_length(event::text)), 0)::text AS event_bytes
				FROM events
			`.execute(tx);
			const eventStat = eventStats.rows[0];
			const eventMutationRows = eventStat?.mutation_rows ?? "0";
			const eventAttachmentRefs = eventStat?.attachment_refs ?? "0";
			const eventReceiptRows = eventStat?.receipt_rows ?? "0";
			const eventBytes = eventStat?.event_bytes ?? "0";
			const eventAttachments = await sql<{
				event_digest: string;
				attachment_index: string;
				asset_id: string | null;
			}>`
				SELECT
					encode(
						sha256(convert_to(event_row.id::text, 'UTF8')),
						'hex'
					) AS event_digest,
					(attachment.ordinality - 1)::text AS attachment_index,
					attachment.value ->> 'assetId' AS asset_id
				FROM events AS event_row
				CROSS JOIN LATERAL jsonb_array_elements(
					CASE
						WHEN jsonb_typeof(event_row.event -> 'payload' -> 'attachments')
							= 'array'
						THEN event_row.event -> 'payload' -> 'attachments'
						ELSE '[]'::jsonb
					END
				) WITH ORDINALITY AS attachment(value, ordinality)
				ORDER BY event_row.id, attachment.ordinality
			`.execute(tx);
			for (const attachment of eventAttachments.rows) {
				if (!isCanonicalAuthoredUuid(attachment.asset_id)) {
					findings.push({
						disposition: "block-current",
						carrierId: "event-attachment",
						code: "invalid-authored-uuid",
						path: `events.${attachment.event_digest}.event.payload.attachments[${attachment.attachment_index}].assetId`,
						digest: canonicalIdentityDigest(attachment.asset_id),
					});
				}
			}

			const threadRows = await sql<{
				app_id: string;
				thread_digest: string;
				project_id: string;
				messages: unknown;
			}>`
				SELECT
					thread_row.app_id,
					encode(
						sha256(convert_to(thread_row.thread_id, 'UTF8')),
						'hex'
					) AS thread_digest,
					app.project_id,
					thread_row.messages
				FROM threads AS thread_row
				JOIN apps AS app ON app.id = thread_row.app_id
				ORDER BY thread_row.thread_id
			`.execute(tx);
			let threadAttachmentRefs = 0;
			for (const thread of threadRows.rows) {
				const inventory = frozenThreadAttachmentInventory(thread.messages);
				threadAttachmentRefs += inventory.occurrences.length;
				if (!inventory.shapeExact) {
					findings.push({
						disposition: "block-current",
						carrierId: "thread-attachment",
						code: "invalid-legacy-shape",
						path: `threads.${thread.thread_digest}.messages`,
						digest: canonicalIdentityDigest("malformed-attachment-metadata"),
					});
				}
				for (const occurrence of inventory.occurrences) {
					const asset =
						occurrence.assetId === null
							? undefined
							: mediaById.get(occurrence.assetId);
					if (
						!occurrence.exact ||
						!isCanonicalAuthoredUuid(occurrence.assetId) ||
						asset?.project_id !== thread.project_id ||
						asset.status !== "ready" ||
						asset.kind !== occurrence.kind
					) {
						findings.push({
							disposition: "block-current",
							carrierId: "thread-attachment",
							code: !isCanonicalAuthoredUuid(occurrence.assetId)
								? "invalid-authored-uuid"
								: "invalid-legacy-shape",
							path: `threads.${thread.thread_digest}.messages[${occurrence.messageIndex}].metadata.attachments[${occurrence.attachmentIndex}].assetId`,
							digest: canonicalIdentityDigest({
								assetId: occurrence.assetId,
								exact: occurrence.exact,
								resolution:
									asset === undefined
										? "missing"
										: asset.project_id !== thread.project_id
											? "foreign-project"
											: asset.kind !== occurrence.kind
												? "kind-mismatch"
												: asset.status,
							}),
						});
					}
				}
			}
			if (cutoverState === "applied") {
				try {
					const mediaApps = appRows.map((app) => {
						if (app.project_id === null || app.project_id.trim().length === 0) {
							throw new Error("a final app has no nonblank Project");
						}
						return {
							id: app.id,
							project_id: app.project_id,
							logo: app.logo,
						};
					});
					const expectedMediaEdges = await frozenExpectedMediaReferenceEdges(
						tx as unknown as Kysely<unknown>,
						mediaApps,
						canonicalPlans,
					);
					await assertFrozenMediaReferenceRows(
						tx as unknown as Kysely<unknown>,
						expectedMediaEdges,
					);
				} catch (error) {
					findings.push({
						disposition: "block-current",
						carrierId: "media-reference-index",
						code: "invalid-legacy-shape",
						path: "media_asset_refs.exact-authored-edge-set",
						digest: canonicalIdentityDigest(
							error instanceof Error ? error.message : "unknown",
						),
					});
				}
			}

			const latestByApp =
				catalogLifecycle.foldFamily.state === "final"
					? new Map(
							(
								await sql<{ app_id: string; seq: string; kind: string }>`
								SELECT DISTINCT ON (baseline.app_id)
									baseline.app_id,
									baseline.seq::text,
									marker.kind
								FROM app_change_fold_baselines AS baseline
								JOIN app_changes AS marker
								  ON marker.app_id = baseline.app_id
								 AND marker.seq = baseline.seq
								ORDER BY baseline.app_id, baseline.seq DESC
							`.execute(tx)
							).rows.map((row) => [row.app_id, row] as const),
						)
					: new Map<string, { app_id: string; seq: string; kind: string }>();
			for (const app of appRows) {
				const latest = latestByApp.get(app.id);
				latestHorizons.push({
					app: canonicalIdentityDigest(app.id),
					seq: String(latest?.seq ?? 0),
					kind: latest?.kind ?? null,
				});
			}

			const tableSizes: Record<string, CountBytes> = {};
			const tableDigests: Record<string, string> = {};
			for (const { schema, table } of FROZEN_OCCURRENCE_RELATIONS) {
				const resolvedSchema = table === "cases" ? casesSchema : schema;
				const physicalTable =
					table === "app_changes" &&
					catalogLifecycle.canonicalPhase === "pristine"
						? "accepted_mutations"
						: table;
				if (
					!existingFrozenRelations.some(
						(relation) =>
							relation.schema_name === resolvedSchema &&
							relation.table_name === physicalTable,
					)
				) {
					tableSizes[table] = { count: "0", bytes: "0" };
					tableDigests[table] = canonicalIdentityDigest({
						table,
						state: "planned-ddl-absent",
					});
					continue;
				}
				tableSizes[table] = await tableCountBytes(
					tx,
					resolvedSchema,
					physicalTable,
				);
				tableDigests[table] = await tableContentDigest(
					tx,
					resolvedSchema,
					physicalTable,
				);
			}
			const schemaDependencies = await sql<{
				table_name: string;
				index_count: string;
				constraint_count: string;
			}>`
				SELECT c.relname AS table_name,
				       count(DISTINCT i.indexrelid)::text AS index_count,
				       count(DISTINCT con.oid)::text AS constraint_count
				FROM pg_class c
				LEFT JOIN pg_index i ON i.indrelid = c.oid
				LEFT JOIN pg_constraint con ON con.conrelid = c.oid
				WHERE c.relname = ANY(${sql.val([...existingOccurrenceTables])})
				GROUP BY c.relname
				ORDER BY c.relname
			`.execute(tx);
			const chunks = (
				await sql<{ count: string; unterminated: string }>`
					SELECT
						count(*)::text AS count,
						count(*) FILTER (WHERE terminal = false)::text AS unterminated
					FROM chat_stream_chunks
				`.execute(tx)
			).rows[0] ?? { count: "0", unterminated: "0" };
			const leaseState = await captureFrozenCutoverLeaseState(tx);
			if (options.locked) {
				if (leaseState.appLeaseBlockers !== "0") {
					findings.push({
						disposition: "block-current",
						carrierId: "quiescence-apps",
						code: "invalid-legacy-shape",
						path: "quiescence.apps",
						digest: canonicalIdentityDigest({
							count: leaseState.appLeaseBlockers,
						}),
					});
				}
				if (
					leaseState.activeThreadHolders !== "0" ||
					leaseState.unterminatedChunks !== "0" ||
					leaseState.presenceSessions !== "0"
				) {
					findings.push({
						disposition: "block-current",
						carrierId: "quiescence-streams",
						code: "invalid-legacy-shape",
						path: "quiescence.streams",
						digest: canonicalIdentityDigest({
							activeStreams: leaseState.activeThreadHolders,
							unterminatedChunks: leaseState.unterminatedChunks,
							presenceSessions: leaseState.presenceSessions,
						}),
					});
				}
			}

			const rewriteBytes = Object.entries(tableSizes)
				.filter(([table]) =>
					[
						"apps",
						"blueprint_entities",
						"events",
						"form_submission_intents",
					].includes(table),
				)
				.reduce((sum, [, value]) => sum + BigInt(value.bytes), BigInt(0))
				.toString();
			const cutoverFindings = findings.map((finding) => ({
				carrierId: finding.carrierId,
				code: finding.code,
				pathDigest: canonicalIdentityDigest(finding.path),
				contentDigest: finding.digest,
			}));
			const rawCarriers = frozenRawCarrierEvidence(storageSnapshot);
			const cutoverPlan = createFrozenCutoverPlan({
				mode: options.locked ? "locked" : "advisory",
				state: cutoverState,
				lockRelations: existingFrozenRelations.map(
					(relation) => `${relation.schema_name}.${relation.table_name}`,
				),
				apps: cutoverApps,
				rawCarriers,
				leaseState,
				lookupContexts: [...cutoverLookupContexts.values()],
				referenceIndexDigest: canonicalIdentityDigest({
					tables: tableDigests.lookup_table_references,
					columns: tableDigests.lookup_column_references,
					media: tableDigests.media_asset_refs,
				}),
				schemaDefinitionDigest: catalogEvidence.schemaDefinitionDigest,
				baselineCatalogDigest: canonicalIdentityDigest({
					catalogLifecycle,
					observedFoldObjectKeys,
				}),
				dependencyCatalogDigest: catalogEvidence.dependencyCatalogDigest,
				relationAndIndexAclDigest: catalogEvidence.relationAndIndexAclDigest,
				functionCatalogDigest: catalogEvidence.functionCatalogDigest,
				capacity: reviewedFrozenCapacity({
					apps: appRows.length.toString(),
					entities: entityRows.length.toString(),
					sourceBytes: rawCarriers.map((carrier) => carrier.bytes),
					rewriteBytes,
				}),
				findings: cutoverFindings,
			});

			return {
				version: CANONICAL_IDENTITY_MIGRATION_VERSION,
				mode: options.locked ? "locked" : "advisory",
				complete: true as const,
				catalogLifecycle: catalogLifecycleSummary,
				occurrenceManifestDigest: canonicalIdentityDigest({
					root: FROZEN_ROOT_OCCURRENCES,
					entity: FROZEN_ENTITY_OCCURRENCES,
					storage: FROZEN_STORAGE_OCCURRENCES,
					mutationKinds: FROZEN_FINAL_MUTATION_KINDS,
				}),
				occurrenceProjectionDigest: canonicalIdentityDigest(
					occurrenceProjections,
				),
				occurrencePlan: occurrenceProjections.map(
					({ id, disposition, rowCount, bytes, digest }) => ({
						id,
						disposition,
						rowCount,
						bytes,
						digest,
					}),
				),
				snapshotDigest: canonicalIdentityDigest({
					appDigests,
					tableDigests,
				}),
				counts: {
					apps: appRows.length.toString(),
					entities: entityRows.length.toString(),
					eventMutationRows,
					eventAttachmentRefs,
					eventReceiptRows,
					eventBytes,
					threadAttachmentRefs: threadAttachmentRefs.toString(),
					chunks: chunks.count,
					unterminatedChunks: leaseState.unterminatedChunks,
					activeStreams: leaseState.activeThreadHolders,
					leaseBlockers: leaseState.appLeaseBlockers,
					presence: leaseState.presenceSessions,
				},
				projectTenancy: {
					invalidAppCount: invalidProjectApps.rows.length,
					missingProjectTargetCount: missingProjectTargets.rows.length,
					invalidCaseCount: invalidProjectCases.rows.length,
					exactFrozenProjectOrphan,
					frozenProjectOrphanSummary,
					invalidAppsDigest: canonicalIdentityDigest(
						invalidProjectApps.rows.map((row) => ({
							app: canonicalIdentityDigest(row.id),
							projectState:
								row.project_id === null
									? "null"
									: row.project_id.trim().length === 0
										? "blank"
										: "present",
							ownerBlank: row.owner.length === 0,
						})),
					),
					missingProjectTargetsDigest: canonicalIdentityDigest(
						missingProjectTargets.rows.map((row) => ({
							app: canonicalIdentityDigest(row.id),
							project: canonicalIdentityDigest(row.project_id),
						})),
					),
					invalidCasesDigest: canonicalIdentityDigest(
						invalidProjectCases.rows.map((row) => ({
							app: canonicalIdentityDigest(row.app_id),
							case: canonicalIdentityDigest(row.case_id),
							project:
								row.project_id === null
									? null
									: canonicalIdentityDigest(row.project_id),
							appProject:
								row.app_project_id === null
									? null
									: canonicalIdentityDigest(row.app_project_id),
						})),
					),
				},
				rewriteTotals,
				preCutoverShapes: {
					optionIdentities: optionIdentityShapes,
					rawReferences: rawReferenceShapes,
					blueprintStructure: blueprintStructureShapes,
					searchInputReferences: searchInputReferenceShapes,
				},
				findings: summarizeFindings(findings),
				findingCount: findings.length,
				tableSizes,
				tableDigests,
				schemaDependencies: schemaDependencies.rows,
				estimatedRewriteBytes: rewriteBytes,
				estimatedWalBytes: (BigInt(rewriteBytes) * BigInt(2)).toString(),
				latestHorizons,
				cutoverPlan,
			};
		});
}
