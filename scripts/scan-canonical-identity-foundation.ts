/**
 * READ ONLY — advisory/locked scan for the canonical identity cutover.
 *
 * Output is deliberately content-free: counts, byte sizes, digests, rewrite
 * totals, and structural paths only. App names, authored prose/values,
 * filenames, chat text, and tool receipts are never printed.
 */

import "dotenv/config";
import { Command } from "commander";
import { sql } from "kysely";
import { frozenPersistableSnapshot } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenDatabaseMigration";
import {
	captureFrozenStorageSnapshot,
	dispatchFrozenStorageOccurrences,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher";
import {
	FROZEN_ENTITY_OCCURRENCES,
	FROZEN_FINAL_MUTATION_KINDS,
	FROZEN_OCCURRENCE_TABLES,
	FROZEN_ROOT_OCCURRENCES,
	FROZEN_STORAGE_OCCURRENCES,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenOccurrenceManifest";
import {
	CANONICAL_IDENTITY_MIGRATION_VERSION,
	type CanonicalIdentityFinding,
	canonicalIdentityDigest,
	isCanonicalAuthoredUuid,
	type LegacyAppSnapshot,
	type LegacyEntityKind,
	type LegacyEntityRow,
	planCanonicalAppMigration,
	scanLookupIdentities,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenTransform";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { replayCanonicalMutationSuffix } from "@/lib/db/canonicalMutationFold";
import { getAppDb } from "@/lib/db/pg";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	prod?: boolean;
	json?: boolean;
	locked?: boolean;
}

const program = new Command();
program
	.name("scan-canonical-identity-foundation")
	.description(
		"Read-only, content-free inventory for the canonical authored-identity maintenance cutover.",
	)
	.option("--prod", "scan production through the operator IAM connection")
	.option("--json", "emit the report as one JSON object")
	.option(
		"--locked",
		"require a quiescent database and take the same table locks the migration uses",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod) targetProdDb();

interface CountBytes {
	count: string | number;
	bytes: string | number;
}

interface FindingSummary {
	readonly count: number;
	readonly samplePaths: readonly string[];
}

interface OptionIdentityShapes {
	total: number;
	missing: number;
	nonString: number;
	canonical: number;
	legacyPositionDerivedExact: number;
	legacyPositionDerivedStale: number;
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
	samplePaths: string[];
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
		report.legacyPositionDerivedExact++;
	} else if (
		value.startsWith(`${fieldUuid}-opt-`) &&
		/^[0-9]+$/.test(value.slice(fieldUuid.length + 5))
	) {
		report.legacyPositionDerivedStale++;
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
		if (report.samplePaths.length < 25) report.samplePaths.push(path);
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
		const prior = out[finding.code] ?? { count: 0, samplePaths: [] };
		out[finding.code] = {
			count: prior.count + 1,
			samplePaths:
				prior.samplePaths.length >= 25
					? prior.samplePaths
					: [...prior.samplePaths, finding.path],
		};
	}
	return out;
}

function walkTypedAttachmentIds(
	value: unknown,
	visit: (assetId: unknown, path: string) => void,
	path: string,
): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		value.forEach((child, index) => {
			walkTypedAttachmentIds(child, visit, `${path}[${index}]`);
		});
		return;
	}
	const record = value as Record<string, unknown>;
	const metadata = record.metadata;
	if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
		const attachments = (metadata as Record<string, unknown>).attachments;
		if (Array.isArray(attachments)) {
			attachments.forEach((attachment, index) => {
				const assetId =
					attachment && typeof attachment === "object"
						? (attachment as Record<string, unknown>).assetId
						: undefined;
				visit(assetId, `${path}.metadata.attachments[${index}].assetId`);
			});
		}
	}
	for (const [key, child] of Object.entries(record)) {
		walkTypedAttachmentIds(child, visit, `${path}.${key}`);
	}
}

async function tableCountBytes(
	tx: Awaited<ReturnType<typeof getAppDb>>,
	table: string,
): Promise<CountBytes> {
	const result = await sql<CountBytes>`
		SELECT count(*)::text AS count,
		       coalesce(sum(pg_column_size(row_value)), 0)::text AS bytes
		FROM ${sql.table(table)} AS row_value
	`.execute(tx);
	return result.rows[0] ?? { count: "0", bytes: "0" };
}

async function tableContentDigest(
	tx: Awaited<ReturnType<typeof getAppDb>>,
	table: string,
): Promise<string> {
	const result = await sql<{ row_value: unknown }>`
		SELECT to_jsonb(row_value) AS row_value
		FROM ${sql.table(table)} AS row_value
		ORDER BY to_jsonb(row_value)::text
	`.execute(tx);
	return canonicalIdentityDigest(result.rows.map((row) => row.row_value));
}

async function main(): Promise<void> {
	const db = await getAppDb();
	const report = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.execute(async (tx) => {
			const existingOccurrenceTables = new Set(
				(
					await sql<{ table_name: string }>`
						SELECT class.relname AS table_name
						FROM pg_catalog.pg_class AS class
						JOIN pg_catalog.pg_namespace AS namespace
						  ON namespace.oid = class.relnamespace
						WHERE namespace.nspname = 'public'
						  AND class.relkind IN ('r', 'p')
						  AND class.relname = ANY(${sql.val([...FROZEN_OCCURRENCE_TABLES])})
						ORDER BY class.relname
					`.execute(tx)
				).rows.map((row) => row.table_name),
			);
			if (options.locked) {
				await sql`
						LOCK TABLE ${sql.join(
							[...existingOccurrenceTables].map((table) => sql.table(table)),
						)} IN SHARE MODE
				`.execute(tx);
			}
			const occurrenceProjections = dispatchFrozenStorageOccurrences(
				await captureFrozenStorageSnapshot(tx),
			);
			const authoredSqlType = (
				await sql<{ data_type: string }>`
					SELECT data_type
					FROM information_schema.columns
					WHERE table_schema = 'public'
					  AND table_name = 'blueprint_entities'
					  AND column_name = 'uuid'
				`.execute(tx)
			).rows[0]?.data_type;
			const baselineRows = existingOccurrenceTables.has(
				"mutation_fold_baselines",
			)
				? (
						await sql<{
							app_id: string;
							seq: string;
							snapshot: Record<string, unknown>;
							snapshot_digest: string;
							batch_id: string;
							run_id: string | null;
							actor_id: string;
							kind: string;
							mutations: unknown;
						}>`
							SELECT DISTINCT ON (baseline.app_id)
								baseline.app_id,
								baseline.seq::text,
								baseline.snapshot,
								baseline.snapshot_digest,
								marker.batch_id,
								marker.run_id,
								marker.actor_id,
								marker.kind,
								marker.mutations
							FROM mutation_fold_baselines AS baseline
							JOIN accepted_mutations AS marker
							  ON marker.app_id = baseline.app_id
							 AND marker.seq = baseline.seq
							ORDER BY baseline.app_id, baseline.seq DESC
						`.execute(tx)
					).rows
				: [];
			const baselineByApp = new Map(
				baselineRows.map((row) => [row.app_id, row] as const),
			);
			const suffixRows = existingOccurrenceTables.has("mutation_fold_baselines")
				? (
						await sql<{
							app_id: string;
							seq: string;
							batch_id: string;
							run_id: string | null;
							actor_id: string;
							kind: string;
							mutations: unknown;
						}>`
							WITH latest AS (
								SELECT DISTINCT ON (app_id) app_id, seq
								FROM mutation_fold_baselines
								ORDER BY app_id, seq DESC
							)
							SELECT mutation.app_id, mutation.seq::text,
							       mutation.batch_id, mutation.run_id,
							       mutation.actor_id, mutation.kind,
							       mutation.mutations
							FROM accepted_mutations AS mutation
							JOIN latest
							  ON latest.app_id = mutation.app_id
							 AND mutation.seq > latest.seq
							ORDER BY mutation.app_id, mutation.seq
						`.execute(tx)
					).rows
				: [];
			const suffixByApp = new Map<string, typeof suffixRows>();
			for (const row of suffixRows) {
				const rows = suffixByApp.get(row.app_id) ?? [];
				rows.push(row);
				suffixByApp.set(row.app_id, rows);
			}

			const appRows = await tx
				.selectFrom("apps")
				.select([
					"id",
					"app_name",
					"connect_type",
					"case_types",
					"logo",
					"mutation_seq",
				])
				.orderBy("id")
				.execute();
			const entityRows = await tx
				.selectFrom("blueprint_entities")
				.select(["app_id", "uuid", "kind", "parent_uuid", "ordinal", "data"])
				.orderBy("app_id")
				.orderBy("kind")
				.orderBy("parent_uuid")
				.orderBy("ordinal")
				.orderBy("uuid")
				.execute();
			const byApp = new Map<string, typeof entityRows>();
			for (const row of entityRows) {
				const values = byApp.get(row.app_id) ?? [];
				values.push(row);
				byApp.set(row.app_id, values);
			}

			const findings: CanonicalIdentityFinding[] = [];
			const optionIdentityShapes: OptionIdentityShapes = {
				total: 0,
				missing: 0,
				nonString: 0,
				canonical: 0,
				legacyPositionDerivedExact: 0,
				legacyPositionDerivedStale: 0,
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
				samplePaths: [],
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
			};
			const appDigests: string[] = [];
			const latestHorizons: Array<{
				app: string;
				seq: string;
				kind: string | null;
			}> = [];

			for (const app of appRows) {
				const appEntityRows = (byApp.get(app.id) ?? []).map((row) => ({
					appId: row.app_id,
					uuid: row.uuid,
					kind: row.kind as LegacyEntityKind,
					parentUuid: row.parent_uuid,
					ordinal: row.ordinal,
					data: row.data,
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
				if (Array.isArray(app.case_types)) {
					for (const value of app.case_types) {
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
					app.case_types,
					rawReferenceShapes,
					"apps.case_types",
				);
				const snapshot: LegacyAppSnapshot = {
					appId: app.id,
					appName: app.app_name,
					connectType: app.connect_type,
					caseTypes: app.case_types,
					logo: app.logo,
					mutationSeq: app.mutation_seq,
					rows: appEntityRows,
				};
				const plan = planCanonicalAppMigration(snapshot);
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
				const appDigest = canonicalIdentityDigest(app.id);
				const baseline = baselineByApp.get(app.id);
				if (authoredSqlType === "uuid" && baseline === undefined) {
					findings.push({
						code: "invalid-fold-baseline",
						path: `apps.${appDigest}.mutationFoldBaseline`,
						digest: canonicalIdentityDigest("missing"),
					});
				}
				if (baseline !== undefined) {
					const baselineDigest = canonicalIdentityDigest(baseline.snapshot);
					const markerIsExact =
						baseline.batch_id === "migration:canonical-identity-foundation" &&
						baseline.run_id === null &&
						baseline.actor_id === "system:canonical-identity-foundation" &&
						baseline.kind === "migration" &&
						Array.isArray(baseline.mutations) &&
						baseline.mutations.length === 0;
					if (!markerIsExact || baseline.snapshot_digest !== baselineDigest) {
						findings.push({
							code: "invalid-fold-baseline",
							path: `apps.${appDigest}.mutationFoldBaseline`,
							digest: canonicalIdentityDigest({
								markerIsExact,
								digestMatches: baseline.snapshot_digest === baselineDigest,
							}),
						});
					} else {
						try {
							const replayed = replayCanonicalMutationSuffix({
								baselineSnapshot: baseline.snapshot,
								baselineSeq: baseline.seq,
								expectedHeadSeq: app.mutation_seq,
								suffix: suffixByApp.get(app.id) ?? [],
							});
							const currentSnapshot = blueprintDocSchema.parse(
								frozenPersistableSnapshot(app, plan),
							);
							if (
								canonicalIdentityDigest(replayed.snapshot) !==
								canonicalIdentityDigest(currentSnapshot)
							) {
								throw new Error("post-horizon fold mismatch");
							}
						} catch (error) {
							findings.push({
								code: "post-horizon-replay-mismatch",
								path: `apps.${appDigest}.postHorizon`,
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
			}

			const lookupTables = await tx
				.selectFrom("lookup_tables")
				.select(["project_id", "id"])
				.execute();
			const lookupColumns = await tx
				.selectFrom("lookup_columns")
				.select(["project_id", "table_id", "id"])
				.execute();
			const lookupRows = await tx
				.selectFrom("lookup_rows")
				.select(["project_id", "table_id", "id", "values"])
				.execute();
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
					rows: lookupRows.map((row) => ({
						projectId: row.project_id,
						tableId: row.table_id,
						id: row.id,
						values: row.values,
					})),
				}),
			);

			for (const row of await tx
				.selectFrom("media_assets")
				.select("id")
				.execute()) {
				if (!isCanonicalAuthoredUuid(row.id)) {
					findings.push({
						code: "invalid-authored-uuid",
						path: `media_assets.${canonicalIdentityDigest(row.id)}.id`,
						digest: canonicalIdentityDigest(row.id),
					});
				}
			}
			for (const row of await tx
				.selectFrom("media_upload_aliases")
				.select(["attempt_asset_id", "canonical_asset_id"])
				.execute()) {
				for (const [key, value] of Object.entries(row)) {
					if (!isCanonicalAuthoredUuid(value)) {
						findings.push({
							code: "invalid-authored-uuid",
							path: `media_upload_aliases.${canonicalIdentityDigest(row)}.${key}`,
							digest: canonicalIdentityDigest(value),
						});
					}
				}
			}
			for (const row of await tx
				.selectFrom("media_asset_refs")
				.select("asset_id")
				.execute()) {
				if (!isCanonicalAuthoredUuid(row.asset_id)) {
					findings.push({
						code: "invalid-authored-uuid",
						path: `media_asset_refs.${canonicalIdentityDigest(row)}.asset_id`,
						digest: canonicalIdentityDigest(row.asset_id),
					});
				}
			}
			for (const row of await tx
				.selectFrom("form_submission_intents")
				.select(["form_uuid", "result"])
				.execute()) {
				if (!isCanonicalAuthoredUuid(row.form_uuid)) {
					findings.push({
						code: "invalid-authored-uuid",
						path: `form_submission_intents.${canonicalIdentityDigest(row)}.form_uuid`,
						digest: canonicalIdentityDigest(row.form_uuid),
					});
				}
				const operations =
					row.result &&
					typeof row.result === "object" &&
					Array.isArray((row.result as Record<string, unknown>).operations)
						? ((row.result as Record<string, unknown>).operations as unknown[])
						: [];
				for (const [index, operation] of operations.entries()) {
					const uuid =
						operation && typeof operation === "object"
							? (operation as Record<string, unknown>).operationUuid
							: undefined;
					if (!isCanonicalAuthoredUuid(uuid)) {
						findings.push({
							code: "invalid-authored-uuid",
							path: `form_submission_intents.${canonicalIdentityDigest(
								row,
							)}.result.operations[${index}].operationUuid`,
							digest: canonicalIdentityDigest(uuid),
						});
					}
				}
			}
			for (const row of await tx
				.selectFrom("form_attachments")
				.select("field_uuid")
				.execute()) {
				if (!isCanonicalAuthoredUuid(row.field_uuid)) {
					findings.push({
						code: "invalid-authored-uuid",
						path: `form_attachments.${canonicalIdentityDigest(row)}.field_uuid`,
						digest: canonicalIdentityDigest(row.field_uuid),
					});
				}
			}

			let eventMutationRows = 0;
			let eventAttachmentRefs = 0;
			let eventReceiptRows = 0;
			let eventBytes = 0;
			const eventRows = await tx
				.selectFrom("events")
				.select(["id", "kind", "event"])
				.execute();
			for (const row of eventRows) {
				eventBytes += Buffer.byteLength(JSON.stringify(row.event));
				if (row.kind === "mutation") eventMutationRows++;
				if (
					row.kind === "conversation" &&
					row.event.payload &&
					typeof row.event.payload === "object"
				) {
					const payload = row.event.payload as Record<string, unknown>;
					if (payload.type === "tool-call" || payload.type === "tool-result") {
						eventReceiptRows++;
					}
					if (
						payload.type === "user-message" &&
						Array.isArray(payload.attachments)
					) {
						payload.attachments.forEach((attachment, index) => {
							eventAttachmentRefs++;
							const assetId =
								attachment && typeof attachment === "object"
									? (attachment as Record<string, unknown>).assetId
									: undefined;
							if (!isCanonicalAuthoredUuid(assetId)) {
								findings.push({
									code: "invalid-authored-uuid",
									path: `events.${row.id}.event.payload.attachments[${index}].assetId`,
									digest: canonicalIdentityDigest(assetId),
								});
							}
						});
					}
				}
			}

			let threadAttachmentRefs = 0;
			const threadRows = await tx
				.selectFrom("threads")
				.select(["thread_id", "messages"])
				.execute();
			for (const row of threadRows) {
				walkTypedAttachmentIds(
					row.messages,
					(assetId, path) => {
						threadAttachmentRefs++;
						if (!isCanonicalAuthoredUuid(assetId)) {
							findings.push({
								code: "invalid-authored-uuid",
								path: `threads.${canonicalIdentityDigest(row.thread_id)}${path}`,
								digest: canonicalIdentityDigest(assetId),
							});
						}
					},
					".messages",
				);
			}

			const latestByApp = existingOccurrenceTables.has(
				"mutation_fold_baselines",
			)
				? new Map(
						(
							await sql<{ app_id: string; seq: string; kind: string }>`
								SELECT DISTINCT ON (baseline.app_id)
									baseline.app_id,
									baseline.seq::text,
									marker.kind
								FROM mutation_fold_baselines AS baseline
								JOIN accepted_mutations AS marker
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

			const tables = [...FROZEN_OCCURRENCE_TABLES];
			const tableSizes: Record<string, CountBytes> = {};
			const tableDigests: Record<string, string> = {};
			for (const table of tables) {
				if (!existingOccurrenceTables.has(table)) {
					tableSizes[table] = { count: 0, bytes: 0 };
					tableDigests[table] = canonicalIdentityDigest({
						table,
						state: "planned-ddl-absent",
					});
					continue;
				}
				tableSizes[table] = await tableCountBytes(
					tx as Awaited<ReturnType<typeof getAppDb>>,
					table,
				);
				tableDigests[table] = await tableContentDigest(
					tx as Awaited<ReturnType<typeof getAppDb>>,
					table,
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
			const chunks = await tx
				.selectFrom("chat_stream_chunks")
				.select(({ fn }) => [
					fn.countAll<string>().as("count"),
					fn
						.count<string>("stream_id")
						.filterWhere("terminal", "=", false)
						.as("unterminated"),
				])
				.executeTakeFirstOrThrow();
			const activeStreams = await tx
				.selectFrom("threads")
				.select(({ fn }) => fn.countAll<string>().as("count"))
				.where("active_stream_id", "is not", null)
				.executeTakeFirstOrThrow();
			const presence = await tx
				.selectFrom("presence")
				.select(({ fn }) => fn.countAll<string>().as("count"))
				.executeTakeFirstOrThrow();
			const leaseBlockers = await sql<{ count: string }>`
				SELECT count(*)::text AS count
				FROM apps
				WHERE
					status = 'generating'
					OR awaiting_input
					OR lock_run_id IS NOT NULL
					OR lock_actor_user_id IS NOT NULL
					OR lock_expire_at IS NOT NULL
					OR NOT (
						(
							res_period IS NULL
							AND res_reserved IS NULL
							AND res_settled IS NULL
							AND res_user_id IS NULL
							AND res_run_id IS NULL
						)
						OR (
							res_period IS NOT NULL
							AND res_reserved IS NOT NULL
							AND res_settled IS TRUE
							AND res_user_id IS NOT NULL
						)
					)
			`.execute(tx);
			if (options.locked) {
				if (Number(leaseBlockers.rows[0]?.count ?? 0) !== 0) {
					findings.push({
						code: "invalid-legacy-shape",
						path: "quiescence.apps",
						digest: canonicalIdentityDigest({
							count: leaseBlockers.rows[0]?.count ?? "unknown",
						}),
					});
				}
				if (
					Number(activeStreams.count) !== 0 ||
					Number(chunks.unterminated) !== 0 ||
					Number(presence.count) !== 0
				) {
					findings.push({
						code: "invalid-legacy-shape",
						path: "quiescence.streams",
						digest: canonicalIdentityDigest({
							activeStreams: activeStreams.count,
							unterminatedChunks: chunks.unterminated,
							presenceSessions: presence.count,
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
						"lookup_rows",
						"form_submission_intents",
					].includes(table),
				)
				.reduce((sum, [, value]) => sum + Number(value.bytes), 0);

			return {
				version: CANONICAL_IDENTITY_MIGRATION_VERSION,
				mode: options.locked ? "locked" : "advisory",
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
					apps: appRows.length,
					entities: entityRows.length,
					eventMutationRows,
					eventAttachmentRefs,
					eventReceiptRows,
					eventBytes,
					threadAttachmentRefs,
					chunks: Number(chunks.count),
					unterminatedChunks: Number(chunks.unterminated),
					activeStreams: Number(activeStreams.count),
					leaseBlockers: Number(leaseBlockers.rows[0]?.count ?? 0),
					presence: Number(presence.count),
				},
				rewriteTotals,
				legacyShapes: {
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
				estimatedWalBytes: rewriteBytes * 2,
				latestHorizons,
			};
		});

	if (options.json) {
		console.log(JSON.stringify(report));
	} else {
		console.log(JSON.stringify(report, null, 2));
	}
	await closeCaseStoreDatabase();
	if (report.findingCount > 0) process.exitCode = 2;
}

runMain(main);
