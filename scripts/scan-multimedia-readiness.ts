/**
 * Read-only diagnostic: real multimedia readiness per app.
 *
 * For every media reference a blueprint holds (field message-slot
 * media, select-option media, module/form icon + audio label, app
 * logo, image-map column rows), this resolves the referenced asset's
 * stored state and classifies the reference as `ready`, `pending`,
 * `missing`, or `kind-mismatch`. It then reports, per app, the broken
 * references with their carrier location + reason, and per Project the
 * `ready` library assets nothing references (uploaded but never
 * attached).
 *
 * Why this exists: a raw "carrier count" only says an app COULD carry
 * media. It doesn't say whether the media is actually attached, fully
 * uploaded, of the right kind, or still owned. An operator needs the
 * USEFUL version — actual usage plus asset state — to answer "which
 * apps would fail a media-ON upload, and why."
 *
 * Reuse points (this script re-derives none of them):
 *   - `walkAssetRefs(doc)` (`lib/domain/mediaRefs`) — the single
 *     carrier walk that yields every reference site with its
 *     `slotKind` + `location`.
 *   - `loadAssetsByIds(ids, projectId)` (`lib/db/mediaAssets`) — bulk,
 *     Project-filtered load returning ready AND pending rows, so a
 *     pending reference is distinguishable from a missing one.
 *   - `listReadyAssetsForProject(projectId)` (`lib/db/mediaAssets`) — the
 *     library-list path; its full set minus the union of referenced
 *     ids gives the orphaned-but-uploaded assets.
 *   - `describeLocation(location)` (`lib/commcare/validator/rules/
 *     media/shared`) — the validator's own carrier-phrasing helper, so
 *     this report's location strings stay in lockstep with the media
 *     validator's error messages.
 *
 * The classification mirrors the three media validator rules
 * (`lib/commcare/validator/rules/media/{mediaAssetExists,
 * mediaAssetReady,mediaKindMatches}`): a reference is `missing` when
 * the Project-filtered load has no row for it, `pending` when the row's
 * `status` isn't `ready`, `kind-mismatch` when the resolved row's
 * frozen `kind` disagrees with the carrier slot's expected kind, and
 * `ready` otherwise.
 *
 * STRICTLY READ-ONLY. It calls only loaders + plain app-state reads —
 * never `createPendingAsset`, `confirmAssetReady`, `deleteAsset`, or
 * any blueprint/app write. It mutates nothing and deletes nothing in GCS.
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL`
 * locally, the Cloud SQL connector in the migrate-job image); `--prod`
 * targets the production instance over its public IP (see
 * `./lib/prodDb.ts`). Run with `--help` for the flag reference.
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { describeLocation } from "@/lib/commcare/validator/rules/media/shared";
import { loadApp } from "@/lib/db/apps";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	listReadyAssetsForProject,
	loadAssetsByIds,
} from "@/lib/db/mediaAssets";
import { getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { AssetRef, MediaSlotKind } from "@/lib/domain/mediaRefs";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import { printHeader, printKV, printSection } from "./lib/format";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import type { BlueprintDoc } from "./lib/types";

// ── CLI argument parsing ────────────────────────────────────────────

/**
 * Scope flags. Exactly one of `--project` / `--app` selects the unit of
 * analysis; they are mutually exclusive. Orphan analysis (req 4) is
 * inherently Project-level — it needs the union of references across ALL
 * of a Project's apps — so it only runs in `--project` mode. `--app`
 * derives its Project from the app doc (for the Project-filtered asset
 * load) but reports per-app readiness only, noting that orphans are
 * Project-scoped.
 */
interface ScanOptions {
	project?: string;
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-multimedia-readiness")
	.description(
		"Read-only diagnostic of real multimedia readiness: actual media references per app, each referenced asset's resolved state (ready / pending / missing / kind-mismatch), and the Project's uploaded-but-unreferenced assets. Writes nothing.",
	)
	.option(
		"--project <projectId>",
		"scan every app in this Project (Better Auth organization id) + report orphaned uploaded assets",
	)
	.option(
		"--app <appId>",
		"scan a single app by id (Project derived from the app doc); orphan analysis is Project-scoped and skipped in this mode",
	)
	.option(
		"--prod",
		"scan the production Cloud SQL instance (public IP + your gcloud IAM identity)",
	)
	.addHelpText(
		"after",
		"\nScoping:\n" +
			"  Pass --project OR --app (not both). There is no all-database scan:\n" +
			"  the orphaned-asset analysis needs a Project context (the union of\n" +
			"  references across every one of that Project's apps), so a scope is\n" +
			"  required rather than iterating the whole apps collection blindly.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-multimedia-readiness.ts --project <projectId>\n" +
			"  $ npx tsx scripts/scan-multimedia-readiness.ts --app <appId> --prod\n",
	);

program.parse();

const opts = program.opts<ScanOptions>();
if (opts.prod === true) {
	targetProdDb();
}

// ── Reference classification ────────────────────────────────────────

/**
 * The four states a media reference can resolve to. `ready` is the
 * only shippable state; the other three each map to one of the media
 * validator rules and would block a media-ON upload.
 */
type RefState = "ready" | "pending" | "missing" | "kind-mismatch";

/**
 * One classified reference: the raw `AssetRef` (carrier location +
 * expected slot kind), the resolved state, and the resolved row when
 * one was found. `record` is `undefined` only for `missing` refs —
 * every other state implies a row.
 */
interface ClassifiedRef {
	readonly ref: AssetRef;
	readonly state: RefState;
	readonly record: MediaAssetRecord | undefined;
}

/**
 * Classify one reference against the Project-filtered asset map.
 *
 * Precedence is deliberate and matches the "fix this first" order the
 * validator rules imply: `missing` (no row at all) → `pending` (row
 * present but bytes unvalidated) → `kind-mismatch` (a ready row of the
 * wrong kind) → `ready`. A pending row can ALSO carry a mismatched
 * kind (the kind is set from the claim at create time), but pending is
 * the more fundamental blocker, so it wins the bucket.
 *
 * The comparison reads `record.kind` directly — the frozen,
 * sniff-derived kind the row carries — exactly as `mediaKindMatches`
 * does. No MIME re-partitioning happens here; the row already settled
 * its kind at upload-confirm.
 */
function classifyRef(
	ref: AssetRef,
	assetsById: ReadonlyMap<string, MediaAssetRecord>,
): ClassifiedRef {
	const record = assetsById.get(ref.assetId);
	if (!record) return { ref, state: "missing", record: undefined };
	if (record.status !== "ready") return { ref, state: "pending", record };
	if (record.kind !== ref.slotKind) {
		return { ref, state: "kind-mismatch", record };
	}
	return { ref, state: "ready", record };
}

/**
 * Human reason fragment for a non-ready reference, embedded after the
 * carrier location in the per-app problem list. Mirrors the vocabulary
 * the matching validator rule uses ("still uploading", "no asset row",
 * "kind mismatch") so an operator reading this report and a user
 * reading the validator error see the same diagnosis.
 */
function reasonFor(classified: ClassifiedRef): string {
	const { state, record, ref } = classified;
	switch (state) {
		case "ready":
			return "ready";
		case "pending":
			// `record` is always present for a pending ref; the status is
			// surfaced verbatim in case a future status beyond `pending`
			// lands without this script being updated.
			return `still uploading (status: ${record?.status ?? "unknown"})`;
		case "missing":
			return "no asset row in this Project — deleted or in another Project";
		case "kind-mismatch":
			return `kind mismatch — slot expects ${ref.slotKind} but asset is ${record?.kind ?? "unknown"} (${record?.mimeType ?? "unknown mime"})`;
	}
}

// ── Per-app readiness ───────────────────────────────────────────────

/**
 * One app's readiness picture: every classified reference (in walk
 * order), plus the app's display name and id for the report block.
 */
interface AppReadiness {
	readonly appId: string;
	readonly appName: string;
	readonly classified: readonly ClassifiedRef[];
}

/**
 * Walk one app's references and classify each against the shared
 * owner-asset map. Pure projection over `walkAssetRefs` — the carrier
 * walk is never re-derived here.
 */
function classifyApp(
	appId: string,
	appName: string,
	doc: BlueprintDoc,
	assetsById: ReadonlyMap<string, MediaAssetRecord>,
): AppReadiness {
	const classified: ClassifiedRef[] = [];
	for (const ref of walkAssetRefs(doc)) {
		classified.push(classifyRef(ref, assetsById));
	}
	return { appId, appName, classified };
}

/**
 * Render one app's readiness block in three parts:
 *
 *   1. A per-kind reference tally + the not-ready count (the at-a-glance
 *      summary).
 *   2. Every reference, grouped by media kind, each line carrying its
 *      carrier location, target asset id, and resolved state — the full
 *      "actual usage + asset state" picture an operator reads to see
 *      WHERE the media lives, not just how much.
 *   3. The not-ready subset re-listed with its fix reason — the
 *      actionable "what would block a media-ON upload" view.
 *
 * Parts 2 and 3 are deliberately separate surfaces: part 2 is the
 * inventory (always shown when refs exist), part 3 is the triage list
 * (shown only when something is broken).
 */
function printAppBlock(app: AppReadiness): void {
	const total = app.classified.length;
	const byKind = countByKind(app.classified.map((c) => c.ref.slotKind));
	const notReady = app.classified.filter((c) => c.state !== "ready");

	printSection(`App ${app.appId.slice(0, 8)}… — ${app.appName}`);
	printKV([
		["App ID", app.appId],
		["Total media refs", String(total)],
		["  image", String(byKind.image)],
		["  audio", String(byKind.audio)],
		["  video", String(byKind.video)],
		["Not-ready refs", String(notReady.length)],
	]);

	if (total === 0) {
		console.log("\n  (no media references)");
		return;
	}

	// Part 2 — every reference, grouped by kind, with carrier location +
	// resolved state. `MEDIA_KIND_ORDER` fixes a stable image→audio→video
	// reading order regardless of walk order.
	for (const kind of MEDIA_KIND_ORDER) {
		const refsOfKind = app.classified.filter((c) => c.ref.slotKind === kind);
		if (refsOfKind.length === 0) continue;
		console.log(`\n  ${kind} references (${refsOfKind.length}):`);
		for (const classified of refsOfKind) {
			// `describeLocation` is the validator's own carrier phrasing, so
			// these lines read identically to the media validator messages a
			// user would see for the same reference.
			console.log(
				`    - ${describeLocation(classified.ref.location)} → asset ${classified.ref.assetId} [${classified.state}]`,
			);
		}
	}

	// Part 3 — the actionable triage list. A ready app skips it entirely.
	if (notReady.length === 0) {
		console.log("\n  All media references are ready.");
		return;
	}

	console.log(`\n  ${notReady.length} broken media reference(s):`);
	for (const classified of notReady) {
		console.log(
			`    - ${describeLocation(classified.ref.location)} → asset ${classified.ref.assetId} (${reasonFor(classified)})`,
		);
	}
}

/**
 * Stable display order for the per-kind reference listing — fixed so
 * an app's block reads image → audio → video regardless of the order
 * `walkAssetRefs` happened to surface the references in.
 */
const MEDIA_KIND_ORDER: readonly MediaSlotKind[] = ["image", "audio", "video"];

/** Per-kind reference counts for one app's reference list. */
interface KindCounts {
	image: number;
	audio: number;
	video: number;
}

/** Tally a list of slot kinds into the three media-kind buckets. */
function countByKind(kinds: readonly MediaSlotKind[]): KindCounts {
	const counts: KindCounts = { image: 0, audio: 0, video: 0 };
	for (const kind of kinds) counts[kind] += 1;
	return counts;
}

// ── App loading ─────────────────────────────────────────────────────

/**
 * A loaded app reduced to what the scan needs: its id, display name,
 * and hydrated blueprint. Apps with no blueprint (failed or
 * never-generated) are dropped at load — they hold zero references and
 * would otherwise crash the walker.
 */
interface LoadedApp {
	readonly appId: string;
	readonly appName: string;
	readonly doc: BlueprintDoc;
}

/**
 * Load one app and reduce it to a `LoadedApp`. The hydration attaches the
 * derived `fieldParent` index the domain walkers expect (mirrors the app's
 * load-time hydration), the same step `inspect-app` performs.
 */
async function loadOne(appId: string): Promise<LoadedApp | null> {
	const app = await loadApp(appId);
	if (!app) return null;
	return {
		appId,
		appName: app.app_name || "(unnamed)",
		doc: hydratePersistedBlueprint(app.blueprint),
	};
}

/**
 * Load every app in `projectId` — INCLUDING soft-deleted apps: orphan
 * analysis subtracts the union of references across EVERY app in the
 * Project from the ready-asset set, so dropping any app would under-count
 * references and mislabel real references as orphans. An empty app carries
 * zero references, so it costs nothing to include.
 */
async function loadProjectApps(projectId: string): Promise<LoadedApp[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("apps")
		.select("id")
		.where("project_id", "=", projectId)
		.execute();
	const apps: LoadedApp[] = [];
	for (const { id } of rows) {
		const loaded = await loadOne(id);
		if (loaded) apps.push(loaded);
	}
	return apps;
}

// ── Owner-level scan (req 1–4) ──────────────────────────────────────

/**
 * Run the full owner-level scan: load every owned app, batch-resolve
 * the union of referenced assets in one owner-filtered load, classify
 * each app's references, and finally compute the orphaned-but-uploaded
 * assets (ready library assets nothing references).
 *
 * The single batched `loadAssetsByIds` over the de-duplicated id union
 * — rather than a per-app load — resolves every referenced asset in one
 * query, avoiding an N+1 read.
 */
async function scanProject(projectId: string): Promise<void> {
	printHeader("MULTIMEDIA READINESS — PROJECT (read-only)");
	printKV([["Project", projectId]]);

	const apps = await loadProjectApps(projectId);
	if (apps.length === 0) {
		console.log("\n  This Project has no apps with a blueprint.");
		// Still report orphans — a Project can hold uploaded library assets
		// with no apps at all, and every one of those is an orphan.
		await printOrphans(projectId, new Set<string>());
		return;
	}

	// Union of every referenced asset id across all the Project's apps —
	// the input to the single batched load AND the referenced-set the
	// orphan analysis subtracts from the ready library list.
	const referencedIds = new Set<string>();
	for (const app of apps) {
		for (const ref of walkAssetRefs(app.doc)) referencedIds.add(ref.assetId);
	}

	// One Project-filtered load resolves ready + pending rows for every
	// referenced id; a foreign-Project or deleted id simply isn't returned
	// (→ classified `missing`), so the load doubles as the tenant gate.
	const rows =
		referencedIds.size === 0
			? []
			: await loadAssetsByIds([...referencedIds], projectId);
	const assetsById = new Map(rows.map((row) => [row.id as string, row]));

	const readiness = apps.map((app) =>
		classifyApp(app.appId, app.appName, app.doc, assetsById),
	);
	for (const app of readiness) printAppBlock(app);

	printProjectTotals(readiness);
	await printOrphans(projectId, referencedIds);
}

/**
 * Final owner-level totals across every app: reference count by kind
 * and the aggregate not-ready count split by reason. Gives the
 * operator a one-glance "how much media, how much broken" summary
 * after the per-app blocks.
 */
function printProjectTotals(readiness: readonly AppReadiness[]): void {
	const allRefs = readiness.flatMap((app) => app.classified);
	const byKind = countByKind(allRefs.map((c) => c.ref.slotKind));
	const pending = allRefs.filter((c) => c.state === "pending").length;
	const missing = allRefs.filter((c) => c.state === "missing").length;
	const mismatch = allRefs.filter((c) => c.state === "kind-mismatch").length;

	printSection("Project Totals");
	printKV([
		["Apps scanned", String(readiness.length)],
		["Total media refs", String(allRefs.length)],
		["  image", String(byKind.image)],
		["  audio", String(byKind.audio)],
		["  video", String(byKind.video)],
		["Not ready (total)", String(pending + missing + mismatch)],
		["  pending (uploading)", String(pending)],
		["  missing (no row)", String(missing)],
		["  kind-mismatch", String(mismatch)],
	]);
}

// ── Orphaned-but-uploaded assets (req 4) ────────────────────────────

/**
 * Report the Project's `ready` library assets that no app references.
 * Pages through `listReadyAssetsForProject` to completion (the library
 * list is cursor-paginated at 50/page — stopping early would mislabel
 * later-page assets as referenced or silently omit orphans) and
 * subtracts the `referencedIds` union.
 */
async function printOrphans(
	projectId: string,
	referencedIds: ReadonlySet<string>,
): Promise<void> {
	const readyAssets = await loadAllReadyAssets(projectId);
	const orphans = readyAssets.filter(
		(asset) => !referencedIds.has(asset.id as string),
	);

	printSection("Orphaned Uploaded Assets (ready, unreferenced)");
	printKV([
		["Ready library assets", String(readyAssets.length)],
		["Referenced (any app)", String(referencedIds.size)],
		["Orphans", String(orphans.length)],
	]);

	if (orphans.length === 0) {
		console.log("\n  No orphaned assets — every uploaded asset is in use.");
		return;
	}

	console.log(`\n  ${orphans.length} uploaded asset(s) no app references:`);
	for (const orphan of orphans) {
		const label = orphan.displayName ?? orphan.originalFilename;
		console.log(
			`    - ${orphan.id} (${orphan.kind}, ${orphan.mimeType}) "${label}"`,
		);
	}
}

/**
 * Drain `listReadyAssetsForProject` across every page into one list.
 * Reading to a null cursor is mandatory for orphan correctness — the
 * orphan set is `all ready assets − referenced`, so a partial page
 * would under-report the ready set and hide real orphans.
 */
async function loadAllReadyAssets(
	projectId: string,
): Promise<MediaAssetRecord[]> {
	const all: MediaAssetRecord[] = [];
	let cursor: string | undefined;
	do {
		const page = await listReadyAssetsForProject(projectId, { cursor });
		all.push(...page.assets);
		cursor = page.nextCursor ?? undefined;
	} while (cursor !== undefined);
	return all;
}

// ── Single-app scan (req 1–3) ───────────────────────────────────────

/**
 * Run the single-app scan: load the app, derive its Project from the
 * doc, resolve only this app's referenced assets, and report per-app
 * readiness. Orphan analysis is Project-scoped (it spans every app in
 * the Project) and is intentionally skipped here with a one-line note
 * rather than faked from a single app.
 */
async function scanApp(appId: string): Promise<void> {
	printHeader("MULTIMEDIA READINESS — APP (read-only)");

	const app = await loadApp(appId);
	if (!app) {
		console.error(
			`Couldn't find an app with id "${appId}". Check the id against the apps table, or pass --project to scan a whole Project.`,
		);
		process.exit(1);
	}

	const projectId = app.project_id ?? undefined;
	if (!projectId) {
		console.error(
			`App "${appId}" has no project_id, so its media assets can't be resolved (every asset read is Project-scoped).`,
		);
		process.exit(1);
	}

	printKV([
		["App ID", appId],
		["Project", projectId],
	]);

	const loaded: LoadedApp = {
		appId,
		appName: app.app_name || "(unnamed)",
		doc: hydratePersistedBlueprint(app.blueprint),
	};

	const referencedIds = new Set<string>();
	for (const ref of walkAssetRefs(loaded.doc)) referencedIds.add(ref.assetId);

	const rows =
		referencedIds.size === 0
			? []
			: await loadAssetsByIds([...referencedIds], projectId);
	const assetsById = new Map(rows.map((row) => [row.id as string, row]));

	const readiness = classifyApp(appId, loaded.appName, loaded.doc, assetsById);
	printAppBlock(readiness);

	printSection("Orphan Analysis");
	console.log(
		"  Skipped — orphaned-asset analysis is Project-scoped (it spans every\n" +
			`  app in the Project). Re-run with --project ${projectId} for it.`,
	);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Exactly one scope is required. Both-or-neither is an Elm-shape
	// usage error: it names what was tried, the expected condition, and
	// what to do next.
	if (opts.project && opts.app) {
		console.error(
			"Both --project and --app were passed, but they're mutually exclusive: --project scans a Project's whole app set (with orphan analysis), --app scans one app. Pass just one.",
		);
		process.exit(1);
	}
	if (!opts.project && !opts.app) {
		console.error(
			"No scope given. Pass --project <projectId> to scan a Project's apps (with orphan analysis), or --app <appId> to scan one app. There's no all-database scan because the orphaned-asset analysis needs a Project context.",
		);
		process.exit(1);
	}

	if (opts.project) {
		await scanProject(opts.project);
	} else if (opts.app) {
		await scanApp(opts.app);
	}
}

// Close the shared case-store pool so the process exits promptly — an open
// pool keeps the event loop alive.
runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
