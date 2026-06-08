/**
 * Read-only diagnostic: real multimedia readiness per app.
 *
 * For every media reference a blueprint holds (field message-slot
 * media, select-option media, module/form icon + audio label, app
 * logo, image-map column rows), this resolves the referenced asset's
 * stored state and classifies the reference as `ready`, `pending`,
 * `missing`, or `kind-mismatch`. It then reports, per app, the broken
 * references with their carrier location + reason, and per owner the
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
 *   - `loadAssetsByIds(owner, ids)` (`lib/db/mediaAssets`) — bulk,
 *     owner-filtered load returning ready AND pending rows, so a
 *     pending reference is distinguishable from a missing one.
 *   - `listReadyAssetsForOwner(owner)` (`lib/db/mediaAssets`) — the
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
 * the owner-filtered load has no row for it, `pending` when the row's
 * `status` isn't `ready`, `kind-mismatch` when the resolved row's
 * frozen `kind` disagrees with the carrier slot's expected kind, and
 * `ready` otherwise.
 *
 * STRICTLY READ-ONLY. It calls only loaders + plain Firestore reads —
 * never `createPendingAsset`, `confirmAssetReady`, `deleteAsset`, or
 * any blueprint/app write. It mutates nothing in Firestore and deletes
 * nothing in GCS. Run with `--help` for the flag reference.
 */
import { Command } from "commander";
import { describeLocation } from "@/lib/commcare/validator/rules/media/shared";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { listReadyAssetsForOwner, loadAssetsByIds } from "@/lib/db/mediaAssets";
import type { AssetRef, MediaSlotKind } from "@/lib/domain/mediaRefs";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import { db, hydrateBlueprint } from "./lib/firestore";
import { printHeader, printKV, printSection } from "./lib/format";
import { runMain } from "./lib/main";
import type { BlueprintDoc } from "./lib/types";

// ── CLI argument parsing ────────────────────────────────────────────

/**
 * Scope flags. Exactly one of `--owner` / `--app` selects the unit of
 * analysis; they are mutually exclusive. Orphan analysis (req 4) is
 * inherently owner-level — it needs the union of references across ALL
 * of an owner's apps — so it only runs in `--owner` mode. `--app`
 * derives its owner from the app doc (for the owner-filtered asset
 * load) but reports per-app readiness only, noting that orphans are
 * owner-scoped.
 */
interface ScanOptions {
	owner?: string;
	app?: string;
}

const program = new Command();
program
	.name("scan-multimedia-readiness")
	.description(
		"Read-only diagnostic of real multimedia readiness: actual media references per app, each referenced asset's resolved state (ready / pending / missing / kind-mismatch), and the owner's uploaded-but-unreferenced assets. Writes nothing.",
	)
	.option(
		"--owner <userId>",
		"scan every app owned by this user (Better Auth user id) + report orphaned uploaded assets",
	)
	.option(
		"--app <appId>",
		"scan a single app by id (owner derived from the app doc); orphan analysis is owner-scoped and skipped in this mode",
	)
	.addHelpText(
		"after",
		"\nScoping:\n" +
			"  Pass --owner OR --app (not both). There is no all-database scan:\n" +
			"  the orphaned-asset analysis needs an owner context (the union of\n" +
			"  references across every one of that owner's apps), so a scope is\n" +
			"  required rather than iterating the whole apps collection blindly.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-multimedia-readiness.ts --owner <userId>\n" +
			"  $ npx tsx scripts/scan-multimedia-readiness.ts --app <appId>\n",
	);

program.parse();

const opts = program.opts<ScanOptions>();

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
 * Classify one reference against the owner-filtered asset map.
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
			return "no asset row under this owner — deleted or foreign-owned";
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
 * Project a raw Firestore app doc to a `LoadedApp`, or `null` when the
 * doc carries no blueprint. The hydration attaches the derived
 * `fieldParent` index the domain walkers expect (mirrors the app's
 * load-time hydration), the same step `inspect-app` performs.
 */
function loadApp(appId: string, data: FirebaseFirestoreData): LoadedApp | null {
	if (data.blueprint === undefined) return null;
	return {
		appId,
		appName: typeof data.app_name === "string" ? data.app_name : "(unnamed)",
		doc: hydrateBlueprint(data.blueprint),
	};
}

/**
 * The loosely-typed shape a script-side Firestore read returns. Scripts
 * read documents directly (no schema converter), so the fields this
 * scan touches are narrowed at use rather than trusted from a typed
 * converter.
 */
type FirebaseFirestoreData = {
	app_name?: unknown;
	owner?: unknown;
	blueprint?: unknown;
};

/**
 * Load every app owned by `owner`. Unlike `inspect-usage`'s app list,
 * this fetches the FULL doc (no `.select()`) and is unbounded (no
 * `.limit()`): orphan analysis subtracts the union of references across
 * EVERY owned app from the ready-asset set, so a truncated or
 * field-projected read would under-count references and mislabel real
 * references as orphans.
 */
async function loadOwnerApps(owner: string): Promise<LoadedApp[]> {
	const snap = await db.collection("apps").where("owner", "==", owner).get();
	const apps: LoadedApp[] = [];
	for (const doc of snap.docs) {
		const loaded = loadApp(doc.id, doc.data() as FirebaseFirestoreData);
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
 * — rather than a per-app load — avoids an N+1 read; the loader already
 * chunks the id list at Firestore's 30-value `in` cap internally.
 */
async function scanOwner(owner: string): Promise<void> {
	printHeader("MULTIMEDIA READINESS — OWNER (read-only)");
	printKV([["Owner", owner]]);

	const apps = await loadOwnerApps(owner);
	if (apps.length === 0) {
		console.log("\n  This owner has no apps with a blueprint.");
		// Still report orphans — an owner can hold uploaded library assets
		// with no apps at all, and every one of those is an orphan.
		await printOrphans(owner, new Set<string>());
		return;
	}

	// Union of every referenced asset id across all the owner's apps —
	// the input to the single batched load AND the referenced-set the
	// orphan analysis subtracts from the ready library list.
	const referencedIds = new Set<string>();
	for (const app of apps) {
		for (const ref of walkAssetRefs(app.doc)) referencedIds.add(ref.assetId);
	}

	// One owner-filtered load resolves ready + pending rows for every
	// referenced id; a foreign-owned or deleted id simply isn't returned
	// (→ classified `missing`), so the load doubles as the privacy gate.
	const rows =
		referencedIds.size === 0
			? []
			: await loadAssetsByIds(owner, [...referencedIds]);
	const assetsById = new Map(rows.map((row) => [row.id as string, row]));

	const readiness = apps.map((app) =>
		classifyApp(app.appId, app.appName, app.doc, assetsById),
	);
	for (const app of readiness) printAppBlock(app);

	printOwnerTotals(readiness);
	await printOrphans(owner, referencedIds);
}

/**
 * Final owner-level totals across every app: reference count by kind
 * and the aggregate not-ready count split by reason. Gives the
 * operator a one-glance "how much media, how much broken" summary
 * after the per-app blocks.
 */
function printOwnerTotals(readiness: readonly AppReadiness[]): void {
	const allRefs = readiness.flatMap((app) => app.classified);
	const byKind = countByKind(allRefs.map((c) => c.ref.slotKind));
	const pending = allRefs.filter((c) => c.state === "pending").length;
	const missing = allRefs.filter((c) => c.state === "missing").length;
	const mismatch = allRefs.filter((c) => c.state === "kind-mismatch").length;

	printSection("Owner Totals");
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
 * Report the owner's `ready` library assets that no app references.
 * Pages through `listReadyAssetsForOwner` to completion (the library
 * list is cursor-paginated at 50/page — stopping early would mislabel
 * later-page assets as referenced or silently omit orphans) and
 * subtracts the `referencedIds` union.
 */
async function printOrphans(
	owner: string,
	referencedIds: ReadonlySet<string>,
): Promise<void> {
	const readyAssets = await loadAllReadyAssets(owner);
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
 * Drain `listReadyAssetsForOwner` across every page into one list.
 * Reading to a null cursor is mandatory for orphan correctness — the
 * orphan set is `all ready assets − referenced`, so a partial page
 * would under-report the ready set and hide real orphans.
 */
async function loadAllReadyAssets(owner: string): Promise<MediaAssetRecord[]> {
	const all: MediaAssetRecord[] = [];
	let cursor: string | undefined;
	do {
		const page = await listReadyAssetsForOwner(owner, { cursor });
		all.push(...page.assets);
		cursor = page.nextCursor ?? undefined;
	} while (cursor !== undefined);
	return all;
}

// ── Single-app scan (req 1–3) ───────────────────────────────────────

/**
 * Run the single-app scan: load the app, derive its owner from the
 * doc, resolve only this app's referenced assets, and report per-app
 * readiness. Orphan analysis is owner-scoped (it spans every app the
 * owner holds) and is intentionally skipped here with a one-line note
 * rather than faked from a single app.
 */
async function scanApp(appId: string): Promise<void> {
	printHeader("MULTIMEDIA READINESS — APP (read-only)");

	const snap = await db.collection("apps").doc(appId).get();
	if (!snap.exists) {
		console.error(
			`Couldn't find an app with id "${appId}". Check the id against the apps collection, or pass --owner to scan a whole owner.`,
		);
		process.exit(1);
	}

	const data = snap.data() as FirebaseFirestoreData;
	const owner = typeof data.owner === "string" ? data.owner : undefined;
	if (!owner) {
		console.error(
			`App "${appId}" has no owner field, so its media assets can't be resolved (every asset read is owner-filtered). The app doc looks malformed — inspect it with scripts/inspect-app.ts.`,
		);
		process.exit(1);
	}

	printKV([
		["App ID", appId],
		["Owner", owner],
	]);

	const loaded = loadApp(appId, data);
	if (!loaded) {
		console.log("\n  App has no blueprint — nothing to scan.");
		return;
	}

	const referencedIds = new Set<string>();
	for (const ref of walkAssetRefs(loaded.doc)) referencedIds.add(ref.assetId);

	const rows =
		referencedIds.size === 0
			? []
			: await loadAssetsByIds(owner, [...referencedIds]);
	const assetsById = new Map(rows.map((row) => [row.id as string, row]));

	const readiness = classifyApp(appId, loaded.appName, loaded.doc, assetsById);
	printAppBlock(readiness);

	printSection("Orphan Analysis");
	console.log(
		"  Skipped — orphaned-asset analysis is owner-scoped (it spans every\n" +
			`  app the owner holds). Re-run with --owner ${owner} for it.`,
	);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Exactly one scope is required. Both-or-neither is an Elm-shape
	// usage error: it names what was tried, the expected condition, and
	// what to do next.
	if (opts.owner && opts.app) {
		console.error(
			"Both --owner and --app were passed, but they're mutually exclusive: --owner scans an owner's whole app set (with orphan analysis), --app scans one app. Pass just one.",
		);
		process.exit(1);
	}
	if (!opts.owner && !opts.app) {
		console.error(
			"No scope given. Pass --owner <userId> to scan an owner's apps (with orphan analysis), or --app <appId> to scan one app. There's no all-database scan because the orphaned-asset analysis needs an owner context.",
		);
		process.exit(1);
	}

	if (opts.owner) {
		await scanOwner(opts.owner);
	} else if (opts.app) {
		await scanApp(opts.app);
	}
}

runMain(main);
