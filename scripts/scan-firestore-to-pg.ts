/**
 * READ-ONLY pre-flight for the Firestore→Postgres data cutover.
 *
 * Enumerates every collection the old Firestore layout carries, decodes each
 * document over the REST API (no firebase SDK), and reports what the migrate
 * script will face — WITHOUT writing anywhere (not to Firestore, not to
 * Postgres). It answers three questions the operator needs before running the
 * writer:
 *
 *   1. How many documents live in each collection, and how many fail to decode
 *      (a value type the REST decoder doesn't understand) — with sample paths.
 *   2. Does every app's blueprint survive the entity-row projection? Each app's
 *      stored blueprint is hydrated, stripped to `PersistableDoc`, legacy-
 *      normalized (`lib/normalizeLegacyBlueprint.ts` — the same lossless
 *      projection the migrate applies), decomposed to entity rows, and
 *      reassembled; a byte-difference (stable-stringified) means the migration
 *      would not round-trip that app, so it's reported.
 *   3. Do the event + thread documents still parse against today's schemas
 *      (`eventSchema` / `threadDocSchema`)? A drifted row is counted + sampled.
 *
 * `--project <gcp-project>` is required (the prod project is `commcare-nova`).
 * Uses Application Default Credentials — `gcloud auth application-default
 * login` locally, the metadata server on Cloud Run.
 *
 * One-off: deleted in a follow-up commit once the production cutover has run,
 * alongside `migrate-firestore-to-pg.ts` and `scripts/lib/firestoreRest.ts`.
 */
import "dotenv/config";
import { Command } from "commander";
import { z } from "zod";
import {
	assembleBlueprint,
	blueprintScalars,
	decomposeBlueprint,
} from "@/lib/db/blueprintRows";
import { runSummaryDocSchema, threadDocSchema } from "@/lib/db/types";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";
import { eventSchema } from "@/lib/log/types";
import {
	batchesFromAcceptedMutations,
	foldReproducesSnapshot,
} from "./lib/blueprintFold";
import {
	createFirestoreRest,
	decodeDocument,
	docIdFromName,
	type FirestoreDocument,
	type FirestoreRest,
	segmentsFromName,
	shortPath,
	stableStringify,
} from "./lib/firestoreRest";
import { printHeader, printSection, printTable } from "./lib/format";
import { runMain } from "./lib/main";
import {
	normalizationSummary,
	normalizeLegacyBlueprint,
} from "./lib/normalizeLegacyBlueprint";

// ── CLI ─────────────────────────────────────────────────────────────

const program = new Command();
program
	.name("scan-firestore-to-pg")
	.description(
		"Read-only inventory + integrity scan of the Firestore data the PG cutover migrates. Writes nothing.",
	)
	.requiredOption(
		"--project <gcp-project>",
		"GCP project holding the source Firestore (prod: commcare-nova)",
	)
	.option("--page-size <n>", "documents per REST page (default 300)", (v) =>
		Number.parseInt(v, 10),
	)
	.option(
		"--fold-sample <n>",
		"apps to fold-check (replay accepted_mutations == entity snapshot); 0 disables (default 25)",
		(v) => Number.parseInt(v, 10),
	)
	.addHelpText(
		"after",
		"\nExamples:\n  $ npx tsx scripts/scan-firestore-to-pg.ts --project commcare-nova\n",
	);
program.parse();
const opts = program.opts<{
	project: string;
	pageSize?: number;
	foldSample?: number;
}>();

// ── Per-collection accumulator ──────────────────────────────────────

const SAMPLE_LIMIT = 5;

interface CollectionStat {
	name: string;
	count: number;
	undecodable: number;
	undecodableSamples: string[];
	/** Schema-parse or blueprint-round-trip failures (0 for count-only collections). */
	invalid: number;
	invalidSamples: string[];
	note?: string;
}

function newStat(name: string, note?: string): CollectionStat {
	return {
		name,
		count: 0,
		undecodable: 0,
		undecodableSamples: [],
		invalid: 0,
		invalidSamples: [],
		note,
	};
}

function addSample(samples: string[], value: string): void {
	if (samples.length < SAMPLE_LIMIT) samples.push(value);
}

/** Decode a document, tallying an undecodable failure against `stat`. Returns
 *  the decoded body, or `null` if it couldn't be decoded. */
function decodeInto(
	stat: CollectionStat,
	doc: FirestoreDocument,
): Record<string, unknown> | null {
	try {
		return decodeDocument(doc);
	} catch (err) {
		stat.undecodable++;
		addSample(
			stat.undecodableSamples,
			`${shortPath(doc.name)} (${messageOf(err)})`,
		);
		return null;
	}
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The minimal shape the migrate REQUIRES of an `acceptedMutations` doc: its
 * natural-key fields (`seq` PK, `batchId` UNIQUE) present and well-formed, plus
 * the payload + timestamp. The migrate THROWS on a violation (never coerces a
 * missing key into "" / 0), so this scan flags the same docs up-front. `ts`
 * decodes to an ISO string (Firestore Timestamp).
 */
const acceptedMutationMinimalSchema = z.object({
	seq: z.number().int().positive(),
	batchId: z.string().min(1),
	mutations: z.array(z.unknown()),
	ts: z.string().min(1),
});

// ── Scans ───────────────────────────────────────────────────────────

interface FoldStats {
	sampled: number;
	verified: number;
	incomplete: number;
	errors: string[];
}

async function scanApps(
	fs: FirestoreRest,
	foldSample: number,
): Promise<{ apps: CollectionStat; fold: FoldStats; normalized: string[] }> {
	const stat = newStat("apps", "blueprint round-trip checked");
	const fold: FoldStats = {
		sampled: 0,
		verified: 0,
		incomplete: 0,
		errors: [],
	};
	const normalized: string[] = [];
	for await (const doc of fs.scanRootCollection("apps")) {
		stat.count++;
		const data = decodeInto(stat, doc);
		if (!data) continue;
		const appId = docIdFromName(doc.name);
		const expectedStable = checkBlueprintRoundTrip(
			stat,
			appId,
			data.blueprint,
			normalized,
		);
		// Fold-validity sampling: replay the first `foldSample` apps'
		// accepted_mutations from empty genesis (an extra subcollection read each).
		if (expectedStable !== null && fold.sampled < foldSample) {
			await foldCheckApp(fs, appId, expectedStable, fold);
		}
	}
	return { apps: stat, fold, normalized };
}

/**
 * Hydrate → persistable → legacy-normalize → decompose → assemble and assert
 * stable-equality with the pre-assemble (normalized) persistable. A mismatch
 * (or a throw from the Zod `assembleBlueprint` parse) is the migration-risk
 * signal this scan exists to surface. Normalization actions (the migrate
 * script applies the same ones) are collected into `normalized`, one line per
 * touched app. Returns the reassembled blueprint's stable string (the fold
 * check's expected snapshot) on a clean assembly, else `null`.
 */
function checkBlueprintRoundTrip(
	stat: CollectionStat,
	appId: string,
	blueprint: unknown,
	normalized: string[],
): string | null {
	if (!blueprint || typeof blueprint !== "object") {
		stat.invalid++;
		addSample(stat.invalidSamples, `${appId} (no blueprint field)`);
		return null;
	}
	try {
		const { doc: persistable, report } = normalizeLegacyBlueprint(
			toPersistableDoc(hydratePersistedBlueprint(blueprint as PersistableDoc)),
		);
		const summary = normalizationSummary(report);
		if (summary !== null) normalized.push(`${appId}: ${summary}`);
		const before = stableStringify(persistable);
		const reassembled = stableStringify(
			assembleBlueprint(
				persistable.appId,
				blueprintScalars(persistable),
				decomposeBlueprint(persistable),
			),
		);
		if (before !== reassembled) {
			stat.invalid++;
			addSample(stat.invalidSamples, `${appId} (round-trip differs)`);
		}
		return reassembled;
	} catch (err) {
		stat.invalid++;
		addSample(stat.invalidSamples, `${appId} (${messageOf(err)})`);
		return null;
	}
}

/** Load one app's accepted_mutations and classify the fold against its
 *  entity-row snapshot (verified / incomplete / error). */
async function foldCheckApp(
	fs: FirestoreRest,
	appId: string,
	expectedStable: string,
	fold: FoldStats,
): Promise<void> {
	fold.sampled++;
	const decoded: Array<{ data: Record<string, unknown> }> = [];
	for await (const doc of fs.scanSubcollection(
		`apps/${appId}`,
		"acceptedMutations",
	)) {
		try {
			decoded.push({ data: decodeDocument(doc) });
		} catch {
			// An undecodable batch is already surfaced by the acceptedMutations
			// collection scan; skip it here.
		}
	}
	const outcome = foldReproducesSnapshot(
		appId,
		batchesFromAcceptedMutations(decoded),
		expectedStable,
	);
	if (outcome.kind === "verified") fold.verified++;
	else if (outcome.kind === "incomplete") fold.incomplete++;
	else fold.errors.push(`${appId} (${outcome.message})`);
}

/** Count-only scan of a collection group / root collection. */
async function scanCountOnly(
	docs: AsyncGenerator<FirestoreDocument>,
	stat: CollectionStat,
): Promise<CollectionStat> {
	for await (const doc of docs) {
		stat.count++;
		decodeInto(stat, doc);
	}
	return stat;
}

/** Scan a collection group, validating each decoded doc against `schema`. */
async function scanValidated(
	docs: AsyncGenerator<FirestoreDocument>,
	stat: CollectionStat,
	schema: { safeParse: (v: unknown) => { success: boolean } },
): Promise<CollectionStat> {
	for await (const doc of docs) {
		stat.count++;
		const data = decodeInto(stat, doc);
		if (!data) continue;
		if (!schema.safeParse(data).success) {
			stat.invalid++;
			addSample(stat.invalidSamples, shortPath(doc.name));
		}
	}
	return stat;
}

/**
 * The `months` subcollection id is shared by `usage/{u}/months` and
 * `credits/{u}/months`, so one collection-group scan feeds two stats, routed by
 * the document's root collection segment.
 */
async function scanMonths(
	fs: FirestoreRest,
	usage: CollectionStat,
	credits: CollectionStat,
): Promise<void> {
	for await (const doc of fs.scanCollectionGroup("months")) {
		const root = segmentsFromName(doc.name)[0];
		const stat = root === "usage" ? usage : root === "credits" ? credits : null;
		if (!stat) continue; // unknown parent — not one of ours
		stat.count++;
		decodeInto(stat, doc);
	}
}

// ── Report ──────────────────────────────────────────────────────────

function printStats(title: string, stats: CollectionStat[]): void {
	printSection(title);
	printTable(
		[
			{ header: "Collection" },
			{ header: "Docs", align: "right" },
			{ header: "Undecodable", align: "right" },
			{ header: "Invalid", align: "right" },
			{ header: "Note" },
		],
		stats.map((s) => [
			s.name,
			String(s.count),
			String(s.undecodable),
			String(s.invalid),
			s.note ?? "",
		]),
	);
	for (const s of stats) {
		if (s.undecodableSamples.length > 0) {
			console.log(`\n  ${s.name} — undecodable samples:`);
			for (const p of s.undecodableSamples) console.log(`    • ${p}`);
		}
		if (s.invalidSamples.length > 0) {
			console.log(`\n  ${s.name} — invalid samples:`);
			for (const p of s.invalidSamples) console.log(`    • ${p}`);
		}
	}
}

async function main(): Promise<void> {
	const fs = await createFirestoreRest(opts.project, opts.pageSize);
	printHeader(`Firestore → Postgres cutover scan · ${opts.project}`);
	console.log("  READ-ONLY — no writes to Firestore or Postgres.\n");

	// Migrated collections.
	const foldSample = opts.foldSample ?? 25;
	const { apps, fold, normalized } = await scanApps(fs, foldSample);
	const acceptedMutations = await scanValidated(
		fs.scanCollectionGroup("acceptedMutations"),
		newStat("acceptedMutations", "natural-key shape checked"),
		acceptedMutationMinimalSchema,
	);
	const runs = await scanValidated(
		fs.scanCollectionGroup("runs"),
		newStat("runs", "runSummaryDocSchema checked"),
		runSummaryDocSchema,
	);
	const threads = await scanValidated(
		fs.scanCollectionGroup("threads"),
		newStat("threads", "threadDocSchema checked"),
		threadDocSchema,
	);
	const events = await scanValidated(
		fs.scanCollectionGroup("events"),
		newStat("events", "eventSchema checked"),
		eventSchema,
	);
	const usageMonths = newStat("usage/months");
	const creditMonths = newStat("credits/months");
	await scanMonths(fs, usageMonths, creditMonths);
	const creditGrants = await scanCountOnly(
		fs.scanCollectionGroup("grants"),
		newStat("credits/grants"),
	);
	const userSettings = await scanCountOnly(
		fs.scanRootCollection("user_settings"),
		newStat("user_settings"),
	);
	const mediaAssets = await scanCountOnly(
		fs.scanRootCollection("mediaAssets"),
		newStat("mediaAssets"),
	);

	// Intentionally-dropped collections — inventoried so the operator can
	// confirm what the migration leaves behind.
	const batchDedup = await scanCountOnly(
		fs.scanCollectionGroup("batchDedup"),
		newStat("batchDedup", "DROPPED — replaced by UNIQUE(app_id, batch_id)"),
	);
	const presence = await scanCountOnly(
		fs.scanCollectionGroup("presence"),
		newStat("presence", "DROPPED — ephemeral"),
	);

	printStats("Migrated collections", [
		apps,
		acceptedMutations,
		runs,
		threads,
		events,
		usageMonths,
		creditMonths,
		creditGrants,
		userSettings,
		mediaAssets,
	]);
	printStats("Dropped collections (not migrated)", [batchDedup, presence]);
	console.log(
		"\n  Note: the subcollection counts above (acceptedMutations / runs / threads /\n" +
			"  events) are collection-group totals and may EXCEED the migrate's per-app row\n" +
			"  counts — the migrate enumerates subcollections per surviving app, so docs\n" +
			"  orphaned under a hard-deleted app parent are counted here but not migrated.",
	);

	printSection("Legacy normalization (the migrate applies the same rules)");
	if (normalized.length === 0) {
		console.log("  no app needed normalization");
	} else {
		console.log(`  ${normalized.length} app(s) normalized:`);
		for (const line of normalized) console.log(`    • ${line}`);
	}

	printSection(
		"Fold tripwire (sampled) — accepted_mutations replay == entity snapshot",
	);
	if (foldSample <= 0) {
		console.log("  (disabled via --fold-sample 0)");
	} else {
		console.log(`  sampled apps: ${fold.sampled}`);
		console.log(
			`    verified (complete history from empty genesis): ${fold.verified}`,
		);
		console.log(
			`    incomplete (pruned ring or seeded genesis — tolerated): ${fold.incomplete}`,
		);
		console.log(
			`    errors (reducer threw — unreplayable stored mutations): ${fold.errors.length}`,
		);
		for (const s of fold.errors) console.log(`      • ${s}`);
	}

	const allMigrated = [
		apps,
		acceptedMutations,
		runs,
		threads,
		events,
		usageMonths,
		creditMonths,
		creditGrants,
		userSettings,
		mediaAssets,
	];
	const totalUndecodable = allMigrated.reduce((n, s) => n + s.undecodable, 0);
	const totalInvalid = allMigrated.reduce((n, s) => n + s.invalid, 0);

	printSection("Verdict");
	if (
		totalUndecodable === 0 &&
		totalInvalid === 0 &&
		fold.errors.length === 0
	) {
		console.log("  ✓ Clean — every migrated document decoded, every blueprint");
		console.log(
			"    round-trips, every event/thread parses, and no fold errors.\n",
		);
	} else {
		console.log(
			`  ⚠ ${totalUndecodable} undecodable + ${totalInvalid} invalid + ${fold.errors.length} fold-error document(s) across migrated collections.`,
		);
		console.log(
			"    Review the samples above before running the migrate script.\n",
		);
	}
}

runMain(main);
