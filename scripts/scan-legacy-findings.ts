/**
 * READ-ONLY — find every standing validator finding in stored apps,
 * the pre-commit-gate debris the zero-tolerance export boundary would
 * refuse after the valid-by-construction merge.
 *
 * Merge choreography: the owner runs this first, then
 * `repair-legacy-findings.ts` (dry-run, then `--apply`), then this scan
 * again — which must report ZERO findings.
 *
 * How each app is read: `loadApp` assembles the stored `blueprint_entities`
 * rows into a `PersistableDoc`, and `guardedLegacyEvaluation` promotes it to
 * the boundary view (derived `fieldParent` rebuilt, expression slots
 * round-trip-checked). This is the exact shape the deployed code reads.
 *
 * What is evaluated: the full validator at full scope — the same
 * evaluation `collectExportBoundaryViolations` performs MINUS the media-asset
 * manifest arm (asset existence / readiness / kind and the export byte
 * budget). Asset state is environment, not blueprint content, so the
 * media arm runs as its own opt-in pass: `--media` resolves each app's
 * referenced assets against the live `media_assets` rows and reports
 * dead references (row missing, or stuck pending past the one-day
 * upload window — `scripts/lib/legacyMediaRefs.ts` owns the judgment)
 * and the ambiguous ones the owner must decide. One further carve-out,
 * by design: an EMPTY app keeps its birth findings (reported as a note,
 * never counted — an empty app is at rest and its export refusal is
 * intentional).
 *
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL`
 * locally, the Cloud SQL connector in the migrate-job image); `--prod`
 * targets the production instance over its public IP (see
 * `./lib/prodDb.ts`). Exits non-zero when any findings exist. Run with
 * `--help` for flags.
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import type {
	ValidationError,
	ValidationErrorCode,
} from "../lib/commcare/validator/errors";
import { VALIDITY_CLASS_BY_CODE } from "../lib/commcare/validator/gate";
import { loadApp } from "../lib/db/apps";
import { getAppDb } from "../lib/db/pg";
import { collectAssetRefs } from "../lib/domain/mediaRefs";
import {
	describeFindingLocation,
	guardedLegacyEvaluation,
	judgmentFor,
} from "./lib/legacyFindingRepairs";
import {
	classifyMediaRefs,
	describeMediaRef,
	loadAssetRowsForScan,
	type MediaRefReport,
} from "./lib/legacyMediaRefs";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	media?: boolean;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-legacy-findings")
	.description(
		"Report every standing validator finding in stored apps (read-only) — the legacy debris the zero-tolerance export boundary would refuse. " +
			"Run before repair-legacy-findings.ts, and again after it (the re-scan must report zero findings). " +
			"Evaluates the export boundary's full validation MINUS the media-asset manifest arm (asset state is environment, not blueprint content); " +
			"--media runs that arm as its own reference scan.",
	)
	.option(
		"--media",
		"also resolve each app's referenced media assets and report dead references — asset row missing, or stuck pending past the one-day upload window (reads the media_assets rows; still read-only)",
	)
	.option(
		"--prod",
		"scan the production Cloud SQL instance (public IP + your gcloud IAM identity)",
	)
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Scans whatever the env points at — NOVA_DB_LOCAL_URL for a local\n" +
			"  Postgres, or the Cloud SQL connector env. --prod is the shorthand\n" +
			"  for the per-developer prod-read setup (see scripts/lib/prodDb.ts).\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-legacy-findings.ts\n" +
			"  $ npx tsx scripts/scan-legacy-findings.ts --media\n" +
			"  $ npx tsx scripts/scan-legacy-findings.ts --prod\n",
	);

program.parse();
const { media, prod } = program.opts<ScanOptions>();
if (prod === true) {
	targetProdDb();
}

const JUDGMENT_LABEL = {
	mechanical: "REPAIRABLE",
	proposed: "PROPOSED",
	"needs-owner": "NEEDS OWNER",
} as const;

function findingLine(err: ValidationError): string {
	const cls = VALIDITY_CLASS_BY_CODE[err.code] ?? "soundness";
	return (
		`  [${cls}] ${err.code} — ${describeFindingLocation(err)}\n` +
		`      ${err.message}`
	);
}

async function main() {
	const db = await getAppDb();
	console.log("Scanning apps…\n");

	const appRows = await db.selectFrom("apps").select("id").execute();
	let appsWithFindings = 0;
	let emptyApps = 0;
	let conversionFailures = 0;
	let deadRefTotal = 0;
	let ambiguousRefTotal = 0;
	let refTotal = 0;
	const failedApps: string[] = [];
	const tally = new Map<ValidationErrorCode, number>();

	for (const { id } of appRows) {
		// Assembly itself can throw on a stored doc broken enough that the
		// entity rows won't reassemble into a valid `PersistableDoc` — that is
		// this app's "too broken to scan" arm, isolated per app.
		const appDoc = await loadApp(id).catch((err: unknown) => {
			failedApps.push(id);
			console.log(
				`${id}\n  ✗ COULDN'T SCAN — the stored blueprint couldn't be assembled from its rows:\n` +
					`      ${err instanceof Error ? err.message : String(err)}\n` +
					"      Fix this app by hand (scripts/recover-app.ts), then re-scan; every other app was scanned normally.\n",
			);
			return null;
		});
		if (!appDoc) continue;
		const label = `${id} (${appDoc.app_name || "unnamed"})`;
		const blueprint = appDoc.blueprint;

		// Per-app fault isolation: a stored doc broken enough to throw out
		// of the loader/validator (a dangling moduleOrder uuid a rule
		// dereferences) costs THIS app's report, never the run — the scan
		// covers every app the owner is bringing inside the invariant.
		try {
			const guarded = guardedLegacyEvaluation(blueprint);
			if (!guarded.ok) {
				failedApps.push(label);
				console.log(
					`${label}\n  ✗ COULDN'T SCAN — the stored blueprint is broken in a way the validator can't even read:\n` +
						`      ${guarded.error}\n` +
						"      Fix this app by hand (scripts/recover-app.ts), then re-scan; every other app was scanned normally.\n",
				);
				continue;
			}
			const { doc, conversion } = guarded.value.view;
			for (const failure of conversion.failures) {
				conversionFailures++;
				console.log(
					`${label}\n  EXPRESSION ROUND-TRIP FAIL [${failure.slot} on ${failure.entityUuid}] — ` +
						"a parser/printer bug; this scan evaluated the slot as stored.\n" +
						`      stored:  ${JSON.stringify(failure.text)}\n` +
						`      printed: ${JSON.stringify(failure.printed)}`,
				);
			}

			const { findings, birth } = guarded.value.evaluation;

			// The --media arm: resolve every referenced asset and judge each
			// reference. Independent of the blueprint findings — an app can be
			// clean on one axis and not the other.
			let mediaReport: MediaRefReport | undefined;
			if (media) {
				const ids = [...collectAssetRefs(doc)];
				const rows =
					ids.length === 0 ? new Map() : await loadAssetRowsForScan(db, ids);
				mediaReport = classifyMediaRefs(doc, appDoc.owner, rows, {
					nowMs: Date.now(),
				});
				refTotal += mediaReport.total;
				deadRefTotal += mediaReport.dead.length;
				ambiguousRefTotal += mediaReport.needsOwner.length;
			}
			const mediaFindingCount = mediaReport
				? mediaReport.dead.length + mediaReport.needsOwner.length
				: 0;

			if (findings.length === 0 && mediaFindingCount === 0) {
				if (birth.length > 0) emptyApps++;
				continue;
			}

			appsWithFindings++;
			console.log(
				`${label} — ${findings.length} finding(s)` +
					(mediaFindingCount > 0
						? ` + ${mediaFindingCount} media reference(s)`
						: ""),
			);
			for (const err of findings) {
				tally.set(err.code, (tally.get(err.code) ?? 0) + 1);
				console.log(findingLine(err));
			}
			if (mediaReport) {
				for (const entry of mediaReport.dead) {
					console.log(
						`  [media] DEAD ${describeMediaRef(entry)}\n      REPAIRABLE — repair-legacy-findings.ts --media clears it.`,
					);
				}
				for (const entry of mediaReport.needsOwner) {
					console.log(`  [media] NEEDS OWNER ${describeMediaRef(entry)}`);
				}
			}
			if (birth.length > 0) {
				console.log(
					"  (plus the empty-app birth state — by design, not counted)",
				);
			}
			console.log("");
		} catch (err) {
			failedApps.push(label);
			console.log(
				`${label}\n  ✗ COULDN'T SCAN — this app threw mid-scan:\n` +
					`      ${err instanceof Error ? err.message : String(err)}\n` +
					"      Fix this app by hand (scripts/recover-app.ts), then re-scan; every other app was scanned normally.\n",
			);
		}
	}

	// ── Per-class tally with the repair judgment ─────────────────────
	if (tally.size > 0) {
		console.log("Findings by class:");
		const codeWidth = Math.max(...[...tally.keys()].map((c) => c.length));
		for (const [code, count] of [...tally.entries()].sort(
			(a, b) => b[1] - a[1],
		)) {
			const judgment = judgmentFor(code);
			console.log(
				`  ${code.padEnd(codeWidth)}  ${String(count).padStart(4)}  ${JUDGMENT_LABEL[judgment.kind]} — ${judgment.reason}`,
			);
		}
		console.log("");
	}

	console.log(
		`${appRows.length} app(s) scanned; ${appsWithFindings} with findings; ` +
			`${emptyApps} empty (birth state, by design); ` +
			`${conversionFailures} expression round-trip failure(s).`,
	);
	if (media) {
		console.log(
			`Media references: ${refTotal} walked; ${deadRefTotal} dead (repairable); ${ambiguousRefTotal} need the owner.`,
		);
	}
	if (failedApps.length > 0) {
		console.log(
			`\n✗ ${failedApps.length} app(s) couldn't be scanned (stored doc too broken to read — see the per-app reports above) and need the owner:\n` +
				failedApps.map((entry) => `  - ${entry}`).join("\n"),
		);
		process.exitCode = 1;
	}
	if (appsWithFindings > 0) {
		console.log(
			"\nRepair with: npx tsx scripts/repair-legacy-findings.ts (dry run; add --apply to write, --apply-proposed for the proposed tier" +
				(deadRefTotal > 0 ? ", --media for the dead media references" : "") +
				")",
		);
		process.exitCode = 1;
	} else {
		console.log(
			"\nNo legacy findings — every stored app passes the export boundary's blueprint checks" +
				(media ? " and every media reference resolves" : "") +
				".",
		);
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
