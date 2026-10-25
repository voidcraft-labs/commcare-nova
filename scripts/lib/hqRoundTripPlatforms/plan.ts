/**
 * The platforms cutover's plan: what the fleet transaction will write,
 * decided from Nova's database and media bucket alone, and the digest that
 * pins it (part 09 §6).
 *
 * Pure: `./source.ts` reads the fleet, `./media.ts` classifies the media
 * (the scan classifies nothing), and `planFleet` runs each app's transform
 * and assembles the plan, its targets and the records the writer and the
 * report read beside it.
 *
 * The digest covers everything the writer would write. Nothing in it comes
 * from outside the database and the bucket, both quiescent in the window: a
 * moved digest means a document, a media row or a deployment baseline
 * moved. Holders are outside it: `planStops` and the writer's blocking scan
 * read them again. Notice entries carry authored names into it as hashed
 * bytes only.
 */

import type { Selectable } from "kysely";
import {
	type MediaAssetRecord,
	mediaAssetRecordFromRow,
} from "@/lib/db/mediaAssets";
import type { MediaAssetsTable } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { ALL_ICON_SLUGS } from "@/lib/domain/builtinIcons";
import { builtinAssetRows } from "@/lib/media/builtinIconAssets";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { HolderCensus } from "./holders";
import type { MediaClassificationStats, MediaRow } from "./media";
import type { FleetSource, SourceApp } from "./source";
import { transformApp } from "./transform";
import {
	type AppPlan,
	compareText,
	type MediaPlan,
	PLAN_FORMAT,
	type PlatformsCutoverPlan,
} from "./types";

/** The media classification a plan was built with; null in the scan. */
export interface FleetMediaClassification {
	readonly plans: readonly MediaPlan[];
	readonly stats: MediaClassificationStats;
}

/** The plan with everything the scripts, the report and the writer read beside it. */
export interface PlannedFleet {
	readonly plan: PlatformsCutoverPlan;
	/** Whether the media was classified: false in the scan, which prints no digest. */
	readonly classified: boolean;
	readonly mediaStats: MediaClassificationStats | null;
	/** Every ready image, audio and video row as read. */
	readonly mediaRows: readonly MediaRow[];
	/** The hydrated target of every app the writer writes, by app id. */
	readonly targets: ReadonlyMap<string, BlueprintDoc>;
	/** Every planned app's source, for the report's counts over the sources. */
	readonly sources: readonly SourceApp[];
	/** Each Project's lookup context, as the plan judged its targets. */
	readonly lookupContexts: ReadonlyMap<string, LookupValidationContext>;
	/** Each Project's media records with their classified formats, as the plan judged export readiness. */
	readonly mediaRecords: ReadonlyMap<
		string,
		ReadonlyMap<string, MediaAssetRecord>
	>;
	readonly holders: HolderCensus;
	readonly appsInFleet: number;
	readonly deletedApps: number;
	readonly fleetSeqDigest: string;
	readonly databaseBytes: number;
}

/** The plan's digest: its format, every media plan and every app plan. */
export function platformsPlanDigest(
	plan: Omit<PlatformsCutoverPlan, "digest">,
): string {
	return canonicalJsonDigest({
		format: plan.format,
		media: plan.media,
		apps: plan.apps,
	});
}

/** Whether any app holds a blocker, which stops every writing mode. */
export function planHasBlockers(plan: PlatformsCutoverPlan): boolean {
	return plan.apps.some((app) => app.blockers.length > 0);
}

/**
 * A Project's media records as export readiness reads them: every row of the
 * Project with the format the classification gives a ready media row (none
 * for any other row, and none at all in the scan), and every built-in icon.
 * The stored `media_format`, which the window's ledger adds, is never read.
 */
export function projectMediaRecords(
	rows: readonly Selectable<MediaAssetsTable>[],
	plans: ReadonlyMap<string, MediaPlan> | null,
): ReadonlyMap<string, MediaAssetRecord> {
	const records = new Map<string, MediaAssetRecord>();
	for (const row of rows) {
		const plan = plans?.get(row.id);
		records.set(
			row.id,
			mediaAssetRecordFromRow({ ...row, media_format: plan?.format ?? null }),
		);
	}
	for (const record of builtinAssetRows(ALL_ICON_SLUGS)) {
		records.set(record.id as string, record);
	}
	return records;
}

/**
 * Run every app's transform over the fleet source and assemble the plan.
 * Pure. `media` is the classification of every ready media row, or null in
 * the scan, whose plan removes no media reference and holds no media plan.
 */
export function planFleet(
	source: FleetSource,
	media: FleetMediaClassification | null,
): PlannedFleet {
	const plansByProject = new Map<string, Map<string, MediaPlan>>();
	for (const plan of media?.plans ?? []) {
		const forProject = plansByProject.get(plan.projectId) ?? new Map();
		forProject.set(plan.assetId, plan);
		plansByProject.set(plan.projectId, forProject);
	}
	const lookupContexts = new Map<string, LookupValidationContext>();
	const mediaRecords = new Map<string, ReadonlyMap<string, MediaAssetRecord>>();
	for (const [projectId, project] of source.projects) {
		lookupContexts.set(projectId, project.lookupContext);
		mediaRecords.set(
			projectId,
			projectMediaRecords(
				project.mediaRows,
				media === null ? null : (plansByProject.get(projectId) ?? new Map()),
			),
		);
	}
	const targets = new Map<string, BlueprintDoc>();
	const apps = source.apps.map((app): AppPlan => {
		const lookupContext = lookupContexts.get(app.projectId);
		const records = mediaRecords.get(app.projectId);
		if (lookupContext === undefined || records === undefined) {
			throw new Error(
				`App ${app.appId} belongs to Project ${app.projectId}, which the fleet read holds no lookup definitions or media for. Build the plan again from one read.`,
			);
		}
		const projectPlans = plansByProject.get(app.projectId);
		const result = transformApp(app.doc, {
			appId: app.appId,
			projectId: app.projectId,
			lookupContext,
			formatOf: media === null ? null : (assetId) => projectPlans?.get(assetId),
			mediaRecords: records,
			deployments: app.deployments,
		});
		if (result.changed) targets.set(app.appId, result.target);
		return {
			appId: app.appId,
			projectId: app.projectId,
			deleted: app.deleted,
			baseSeq: app.baseSeq,
			baseDigest: canonicalJsonDigest(toPersistableDoc(app.doc)),
			declaration: result.declaration,
			targetDigest: result.changed
				? canonicalJsonDigest(toPersistableDoc(result.target))
				: null,
			changes: result.changes,
			notice: result.notice,
			blockers: result.blockers,
		};
	});
	const mediaPlans = [...(media?.plans ?? [])].sort((a, b) =>
		compareText(a.assetId, b.assetId),
	);
	const withoutDigest = {
		format: PLAN_FORMAT,
		media: mediaPlans,
		apps: [...apps].sort((a, b) => compareText(a.appId, b.appId)),
	} as const;
	return {
		plan: { ...withoutDigest, digest: platformsPlanDigest(withoutDigest) },
		classified: media !== null,
		mediaStats: media?.stats ?? null,
		mediaRows: source.media,
		targets,
		sources: source.apps,
		lookupContexts,
		mediaRecords,
		holders: source.holders,
		appsInFleet: source.appsInFleet,
		deletedApps: source.deletedApps,
		fleetSeqDigest: source.fleetSeqDigest,
		databaseBytes: source.databaseBytes,
	};
}
