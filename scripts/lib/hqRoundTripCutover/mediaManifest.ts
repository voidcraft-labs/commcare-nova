/**
 * The plan-time media manifest: one map per Project, the same map the genesis
 * writer hands export readiness (`lib/db/appGenesis.ts::
 * writePreparedGenesisInTransaction`), built once over every target document
 * of the Project.
 *
 * The rows are read with one plain `SELECT` by id. `getAssetsInTransaction`
 * locks each row `FOR SHARE`, which the scan's read-only identity cannot do,
 * and the plan decides nothing a lock would protect: the writer admits every
 * app's media references again under its own locks.
 */

import type { Transaction } from "kysely";
import {
	type MediaAssetRecord,
	mediaAssetRecordFromRow,
} from "@/lib/db/mediaAssets";
import type { AppDatabase } from "@/lib/db/pg";
import type { BlueprintDoc } from "@/lib/domain";
import type { IconRef } from "@/lib/domain/builtinIcons";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	builtinAssetRows,
	partitionAssetRefs,
} from "@/lib/media/builtinIconAssets";

/** Media assets by id, as `exportReadinessFindings` reads them. */
export type ProjectMediaManifest = ReadonlyMap<string, MediaAssetRecord>;

/**
 * Every asset the Project's target documents reference that the Project
 * holds, plus the built-in icons they name. An id another Project holds is
 * left out, so it reads as not found, as it would at a commit.
 */
export async function readProjectMediaManifest(
	tx: Transaction<AppDatabase>,
	projectId: string,
	targets: readonly BlueprintDoc[],
): Promise<ProjectMediaManifest> {
	const refs = new Set<IconRef>();
	for (const target of targets) {
		for (const ref of collectAssetRefs(target)) refs.add(ref);
	}
	const { realIds, builtinSlugs } = partitionAssetRefs([...refs]);
	const unique = [...new Set(realIds)].sort();
	const rows =
		unique.length === 0
			? []
			: await tx
					.selectFrom("media_assets")
					.selectAll()
					.where("id", "in", unique)
					.orderBy("id")
					.execute();
	return new Map(
		[
			...rows
				.map(mediaAssetRecordFromRow)
				.filter((record) => record.project_id === projectId),
			...builtinAssetRows(builtinSlugs),
		].map((record) => [record.id as string, record]),
	);
}
