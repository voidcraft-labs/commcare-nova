/**
 * External read sets — the exact mutable non-Blueprint observations a staged
 * step depends on, captured automatically by the change-set workspace and
 * re-judged at diagnostics and commit time.
 *
 * Capture is workspace-owned (tools declare nothing extra):
 *
 *   - lookup reads ride the wrapped `lookupDefinitions`/`lookupCatalog`
 *     readers, recording each table's definition revision;
 *   - the organization revision rides the write's
 *     `expectedOrganizationRevision` policy;
 *   - media-asset identities ride the staged batch's authored-asset-ref
 *     delta, digesting each asset's identity-bearing metadata;
 *   - Project scope is the change-set row's `base_project_id`, not a
 *     per-step entry.
 *
 * Commit policy per kind: `organization` fences its exact revision through
 * the kernel; lookup and media deps re-resolve under the kernel's fresh
 * locked verdicts, so their currency here is advisory diagnostics.
 */

import { sql } from "kysely";
import { getAppDb } from "@/lib/db/pg";
import type { MediaAssetId } from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import type { LookupDefinitionsSnapshot } from "@/lib/lookup/types";
import { parseOrganizationRevision } from "@/lib/organization/schema";
import { canonicalJsonDigest, canonicalJsonText } from "./digest";
import type { ExternalReadDependency } from "./schemas";

/** Dedupe + code-point-sort dependencies so digests and stored sets are
 *  order-independent of capture order. */
export function normalizeReadSet(
	entries: readonly ExternalReadDependency[],
): ExternalReadDependency[] {
	const byText = new Map<string, ExternalReadDependency>();
	for (const entry of entries) byText.set(canonicalJsonText(entry), entry);
	return [...byText.keys()].sort().map((key) => {
		const entry = byText.get(key);
		if (entry === undefined) throw new Error("unreachable: key from map");
		return entry;
	});
}

/** The digest binding one snapshot's captured external context. */
export function externalContextDigest(
	entries: readonly ExternalReadDependency[],
): string {
	return canonicalJsonDigest(normalizeReadSet(entries));
}

/** Record lookup-definition dependencies off one definitions snapshot. */
export function lookupSnapshotDependencies(
	snapshot: LookupDefinitionsSnapshot,
): ExternalReadDependency[] {
	return snapshot.definitions.map((definition) => ({
		kind: "lookup-definition",
		projectId: snapshot.projectId,
		tableId: definition.id,
		definitionRevision: String(definition.definitionRevision),
	}));
}

/** The identity-bearing metadata a media dependency digests. */
export function mediaAssetMetadataDigest(row: {
	readonly projectId: string;
	readonly kind: string;
	readonly status: string;
}): string {
	return canonicalJsonDigest({
		projectId: row.projectId,
		kind: row.kind,
		status: row.status,
	});
}

/**
 * Capture media-asset dependencies for newly referenced asset ids. Missing
 * rows still capture (with an all-zero digest they can never re-prove), so
 * the staged step's dependence is durable even when the asset vanished
 * between the tool's verdict and this read.
 */
export async function mediaAssetDependencies(
	projectId: string,
	assetIds: readonly string[],
): Promise<ExternalReadDependency[]> {
	if (assetIds.length === 0) return [];
	const brandedIds = assetIds.map((assetId) => asMediaAssetId(assetId));
	const db = await getAppDb();
	const rows = await db
		.selectFrom("media_assets")
		.select(["id", "project_id", "kind", "status"])
		.where("id", "in", brandedIds)
		.execute();
	const byId = new Map<string, (typeof rows)[number]>(
		rows.map((row) => [row.id, row]),
	);
	return brandedIds.map((assetId) => {
		const row = byId.get(assetId);
		return {
			kind: "media-asset",
			projectId,
			assetId,
			metadataDigest:
				row === undefined || row.project_id !== projectId
					? "0".repeat(64)
					: mediaAssetMetadataDigest({
							projectId: row.project_id,
							kind: row.kind,
							status: row.status,
						}),
		};
	});
}

export interface ReadSetStatus {
	readonly dependency: ExternalReadDependency;
	readonly state: "current" | "stale" | "unavailable";
}

/**
 * Judge each captured dependency against CURRENT external state — the
 * diagnostics read (`canCommit` keys on it). Advisory: the commit re-proves
 * everything under its own locks.
 */
export async function evaluateReadSetCurrency(args: {
	readonly appId: string | null;
	readonly dependencies: readonly ExternalReadDependency[];
}): Promise<ReadSetStatus[]> {
	const db = await getAppDb();
	const statuses: ReadSetStatus[] = [];
	const lookupTableIds = new Set<LookupTableId>();
	const mediaAssetIds = new Set<MediaAssetId>();
	for (const dependency of args.dependencies) {
		if (
			dependency.kind === "lookup-definition" ||
			dependency.kind === "lookup-column"
		) {
			lookupTableIds.add(dependency.tableId);
		} else if (dependency.kind === "media-asset") {
			mediaAssetIds.add(dependency.assetId);
		}
	}
	const [lookupRows, mediaRows, organizationRow] = await Promise.all([
		lookupTableIds.size === 0
			? Promise.resolve([])
			: db
					.selectFrom("lookup_tables")
					.select(["id", "project_id"])
					.select(
						sql<string>`${sql.ref("lookup_tables.definition_revision")}::text`.as(
							"definition_revision_text",
						),
					)
					.where("id", "in", [...lookupTableIds])
					.execute(),
		mediaAssetIds.size === 0
			? Promise.resolve([])
			: db
					.selectFrom("media_assets")
					.select(["id", "project_id", "kind", "status"])
					.where("id", "in", [...mediaAssetIds])
					.execute(),
		args.appId === null
			? Promise.resolve(undefined)
			: db
					.selectFrom("app_organization_state")
					.select("revision")
					.where("app_id", "=", args.appId)
					.executeTakeFirst(),
	]);
	const lookupById = new Map(lookupRows.map((row) => [row.id, row]));
	const mediaById = new Map(mediaRows.map((row) => [row.id, row]));
	const currentOrganizationRevision =
		organizationRow === undefined
			? "0"
			: parseOrganizationRevision(organizationRow.revision);

	for (const dependency of args.dependencies) {
		switch (dependency.kind) {
			case "organization": {
				statuses.push({
					dependency,
					state:
						dependency.revision === currentOrganizationRevision
							? "current"
							: "stale",
				});
				break;
			}
			case "lookup-definition":
			case "lookup-column": {
				const row = lookupById.get(dependency.tableId);
				if (row === undefined || row.project_id !== dependency.projectId) {
					statuses.push({ dependency, state: "unavailable" });
					break;
				}
				statuses.push({
					dependency,
					state:
						row.definition_revision_text === dependency.definitionRevision
							? "current"
							: "stale",
				});
				break;
			}
			case "media-asset": {
				const row = mediaById.get(dependency.assetId);
				if (row === undefined || row.project_id !== dependency.projectId) {
					statuses.push({ dependency, state: "unavailable" });
					break;
				}
				statuses.push({
					dependency,
					state:
						mediaAssetMetadataDigest({
							projectId: row.project_id,
							kind: row.kind,
							status: row.status,
						}) === dependency.metadataDigest
							? "current"
							: "stale",
				});
				break;
			}
			case "project-scope": {
				// Row-level base_project_id is the authority; a per-step entry is
				// informational and always judged current here (the commit's
				// expected-Project check is the real fence).
				statuses.push({ dependency, state: "current" });
				break;
			}
		}
	}
	return statuses;
}
