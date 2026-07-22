/**
 * ⚠️  WRITES — repair the mechanically-repairable validator findings in
 * stored apps, so legacy pre-commit-gate apps pass the zero-tolerance
 * export boundary after the valid-by-construction merge.
 *
 * Merge choreography: `scan-legacy-findings.ts` first, then this script
 * as a dry run, review, then `--apply` (and `--apply-proposed` for the
 * proposed tier, if accepted), then the scan again — which must report
 * ZERO findings. Needs-owner findings are printed per app and never
 * auto-fixed; the owner resolves those by hand before the re-scan.
 *
 * Per app: `loadApp` assembles the stored `blueprint_entities` rows and
 * `guardedRepairApp` promotes them to the boundary view (derived
 * `fieldParent` rebuilt, expression slots round-trip-checked). Each
 * repair is a mutation batch through the REAL reducers, gated by the same
 * commit verdict every live write surface runs; after an app's repairs
 * the strictly-decreasing oracle must hold — finding count strictly down,
 * zero introduced identities (`diffIntroduced`) — or the app is reported
 * and NOT written. The judgment table (which classes are mechanical /
 * proposed / needs-owner, and why) lives in
 * `scripts/lib/legacyFindingRepairs.ts`.
 *
 * `--media` adds the media-reference arm (`scripts/lib/legacyMediaRefs.ts`):
 * each app's referenced assets resolve against the live `media_assets`
 * rows, and a PROVABLY-dead reference — row missing, or stuck pending
 * past the one-day upload window (its bytes already reaped) — is
 * cleared through the same clear-safe mutation kinds the live surfaces
 * use, gated by the same commit verdict, with its own gone-after-apply
 * oracle. Anything ambiguous (a ready asset of the wrong kind, a young
 * pending upload, a cross-account reference, an image-map row) is
 * reported needs-owner and never touched.
 *
 * The write goes through `appendSyntheticBatch` (`lib/db/apps.ts`): against
 * the exact sequence this scan loaded, it derives and persists deterministic
 * mutations and advances `mutation_seq` with `kind: "migration"`. A builder
 * tab still open across the write reloads onto the repaired row, and a stale
 * preparation rejects instead of silently replacing newer work.
 *
 * Idempotent (a repaired app re-evaluates clean, so a re-run plans
 * nothing) and resumable per app (each app loads, repairs, and writes
 * independently — a re-run after an interruption skips the finished
 * ones, and an app whose stored doc is too broken to even read is
 * reported and skipped without taking down the run).
 *
 * Writes to whatever database the env provides (`NOVA_DB_LOCAL_URL`
 * locally, the Cloud SQL connector in the migrate-job image). Run with
 * `--help` for flags.
 */
import { Command } from "commander";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { appendSyntheticBatch, loadApp } from "../lib/db/apps";
import { getAppDb } from "../lib/db/pg";
import { mutationCommitVerdict } from "../lib/doc/commitVerdicts";
import { toPersistableDoc } from "../lib/doc/fieldParent";
import { collectAssetRefs, walkAssetRefs } from "../lib/domain/mediaRefs";
import {
	guardedRepairApp,
	renderAppRepairReport,
} from "./lib/legacyFindingRepairs";
import {
	classifyMediaRefs,
	describeMediaRef,
	loadAssetRowsForScan,
	mediaRefIdentity,
	planMediaRefClears,
} from "./lib/legacyMediaRefs";
import { runMain } from "./lib/main";

interface RepairOptions {
	apply?: boolean;
	applyProposed?: boolean;
	media?: boolean;
}

const program = new Command();
program
	.name("repair-legacy-findings")
	.description(
		"Repair the mechanically-repairable validator findings in stored apps. Defaults to a dry run — pass --apply to write. " +
			"PROPOSED repairs (content-adjacent, e.g. seeding the case_name case-list column) print in every run but apply only under --apply-proposed. " +
			"--media adds the media-reference arm: provably-dead references clear; anything ambiguous is reported. " +
			"Choreography: scan-legacy-findings.ts → this (dry run → --apply) → re-scan to zero.",
	)
	.option("--apply", "actually write the repairs (default: dry run)")
	.option(
		"--apply-proposed",
		"also apply PROPOSED-tier repairs (printed-only by default)",
	)
	.option(
		"--media",
		"also clear provably-dead media references — asset row missing, or stuck pending past the one-day upload window; anything ambiguous (ready, wrong kind, cross-account, young pending) is reported, never cleared. Dry-run by default like everything else; writes only under --apply",
	)
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Repairs whatever the env points at — NOVA_DB_LOCAL_URL for a local\n" +
			"  Postgres, or the Cloud SQL connector env in the migrate-job image.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/repair-legacy-findings.ts                           # dry run\n" +
			"  $ npx tsx scripts/repair-legacy-findings.ts --apply                   # write mechanical repairs\n" +
			"  $ npx tsx scripts/repair-legacy-findings.ts --apply --apply-proposed  # include the proposed tier\n" +
			"  $ npx tsx scripts/repair-legacy-findings.ts --apply --media           # also clear dead media refs\n",
	);

program.parse();
const { apply, applyProposed, media } = program.opts<RepairOptions>();

async function main() {
	const db = await getAppDb();
	console.log(
		`${apply ? "REPAIRING" : "Dry run over"} apps` +
			`${applyProposed ? " (proposed tier included)" : ""}…\n`,
	);

	const appRows = await db.selectFrom("apps").select("id").execute();
	let appsRepaired = 0;
	let findingsCleared = 0;
	let proposedWithheld = 0;
	let needsOwnerTotal = 0;
	let deadRefsCleared = 0;
	let mediaNeedsOwnerTotal = 0;
	const oracleFailures: string[] = [];
	const failedApps: string[] = [];

	for (const { id: appId } of appRows) {
		// Assembly itself can throw on a stored doc broken enough that the
		// entity rows won't reassemble — that is this app's "too broken to
		// process" arm, isolated per app.
		const appDoc = await loadApp(appId).catch((err: unknown) => {
			failedApps.push(appId);
			console.log(
				`${appId}\n  ✗ COULDN'T PROCESS — the stored blueprint couldn't be assembled from its rows:\n` +
					`      ${err instanceof Error ? err.message : String(err)}\n` +
					"      Nothing was written for it. Fix this app by hand (scripts/recover-app.ts), then re-run; every other app was processed normally.\n",
			);
			return null;
		});
		if (!appDoc) continue;
		const label = `${appId} (${appDoc.app_name || "unnamed"})`;
		const blueprint = appDoc.blueprint;

		// Per-app fault isolation: a malformed stored doc costs THIS app's
		// report, never the run — the catch at the bottom of the loop body
		// is the backstop for the media arm + the write; the guarded repair
		// covers the load + findings stage the same way.
		try {
			const guarded = guardedRepairApp(blueprint, {
				applyProposed: applyProposed ?? false,
			});
			if (!guarded.ok) {
				failedApps.push(label);
				console.log(
					`${label}\n  ✗ COULDN'T PROCESS — the stored blueprint is broken in a way the repair can't even read:\n` +
						`      ${guarded.error}\n` +
						"      Nothing was written for it. Fix this app by hand (scripts/recover-app.ts), then re-run; every other app was processed normally.\n",
				);
				continue;
			}
			const { doc, outcome } = guarded.value;
			const hasFindings = outcome !== undefined;
			if (!hasFindings && !media) continue;

			/* The doc the write persists: the findings repairs apply first, the
			 * media clears compose on top — one write per app either way. */
			let working = doc;
			let changed = false;

			if (outcome) {
				console.log(
					`${label} — ${outcome.before.length} finding(s) → ${outcome.after.length}` +
						(outcome.proposed.length > 0
							? ` (${outcome.after.length - outcome.proposed.length} with --apply-proposed)`
							: ""),
				);
				const report = renderAppRepairReport(outcome, {
					applyLabel: apply ? "REPAIRED" : "WOULD REPAIR",
				});
				for (const line of report.lines) console.log(line);
				needsOwnerTotal += report.needsOwnerCount;

				if (!outcome.verdict.ok) {
					oracleFailures.push(label);
					console.log(
						`  ✗ ORACLE FAILED — ${outcome.before.length} finding(s) before, ${outcome.after.length} after, ` +
							`${outcome.verdict.introduced.length} introduced. Nothing was written for this app; ` +
							"the repair engine has a bug to look at before re-running.",
					);
					for (const err of outcome.verdict.introduced) {
						console.log(`      introduced: ${err.code} — ${err.message}`);
					}
					console.log("");
					continue;
				}

				working = outcome.doc;
				changed = outcome.changed;
				findingsCleared += outcome.applied.length;
				proposedWithheld += outcome.proposed.length;
			}

			let printedMediaLines = false;
			if (media) {
				const ids = [...collectAssetRefs(working)];
				const rows =
					ids.length === 0 ? new Map() : await loadAssetRowsForScan(db, ids);
				const report = classifyMediaRefs(working, appDoc.owner, rows, {
					nowMs: Date.now(),
				});
				const plan = planMediaRefClears(working, report.dead);
				const mediaIssues =
					plan.notes.length +
					report.needsOwner.length +
					plan.unclearable.length;
				if (mediaIssues > 0) {
					printedMediaLines = true;
					if (!hasFindings) {
						console.log(`${label} — ${mediaIssues} media reference issue(s)`);
					}
				}

				if (plan.mutations.length > 0) {
					/* The same commit gate every live write surface runs — a clear
					 * batch that would introduce any finding is refused whole. */
					const gate = mutationCommitVerdict(
						working,
						plan.mutations,
						LOOKUP_CONTEXT_UNAVAILABLE,
					);
					if (!gate.ok) {
						console.log(
							"  MEDIA GATE-REFUSED — the planned clears would introduce:\n" +
								gate.introduced.map((e) => `      - ${e.message}`).join("\n"),
						);
					} else {
						/* Verify every targeted reference is actually GONE from the
						 * cleared doc — the media twin of the strictly-decreasing
						 * oracle. A survivor means the clear planner has a bug; the
						 * app is reported and not written. */
						const remaining = new Set(
							[...walkAssetRefs(gate.nextDoc)].map(mediaRefIdentity),
						);
						const survivors = [...plan.clearedIdentities].filter((identity) =>
							remaining.has(identity),
						);
						if (survivors.length > 0) {
							oracleFailures.push(`${label} (media clears)`);
							console.log(
								`  ✗ MEDIA ORACLE FAILED — ${survivors.length} of ${plan.clearedIdentities.size} planned clears left their reference in place. ` +
									"Nothing was written for this app; the clear planner has a bug to look at before re-running.",
							);
							console.log("");
							continue;
						}
						for (const noteLine of plan.notes) {
							console.log(`  ${apply ? "CLEARED" : "WOULD CLEAR"} ${noteLine}`);
						}
						working = gate.nextDoc;
						changed = true;
						deadRefsCleared += plan.notes.length;
					}
				}

				for (const entry of [...report.needsOwner, ...plan.unclearable]) {
					mediaNeedsOwnerTotal++;
					console.log(`  NEEDS OWNER [media] ${describeMediaRef(entry)}`);
				}
			}

			if (changed) {
				appsRepaired++;
				if (apply) {
					/* Derives a deterministic mutation batch against the exact
					 * loaded sequence and appends it as `kind: "migration"` — a
					 * builder tab open across the write reloads onto the repaired
					 * row instead of overwriting the repairs. Repairs only remove or rename —
					 * never add an asset reference — so the writers' reverse-index
					 * sync has nothing to add for this write. */
					await appendSyntheticBatch({
						appId,
						expectedBaseSeq: appDoc.mutation_seq,
						targetDoc: toPersistableDoc(working),
						authority: {
							kind: "system",
							actorId: "system:legacy-findings-repair",
							reason: "Operator-approved legacy finding repair",
						},
					});
				}
			}
			if (hasFindings || printedMediaLines) console.log("");
		} catch (err) {
			failedApps.push(label);
			console.log(
				`${label}\n  ✗ COULDN'T PROCESS — this app threw mid-repair:\n` +
					`      ${err instanceof Error ? err.message : String(err)}\n` +
					"      Nothing was written for it. Fix this app by hand (scripts/recover-app.ts), then re-run; every other app was processed normally.\n",
			);
		}
	}

	console.log(
		`${apply ? "Repaired" : "Would repair"} ${findingsCleared} finding(s) across ${appsRepaired} app(s) ` +
			`of ${appRows.length} scanned. ${proposedWithheld} proposed repair(s) withheld; ` +
			`${needsOwnerTotal} finding(s) need the owner.` +
			(media
				? ` Media: ${apply ? "cleared" : "would clear"} ${deadRefsCleared} dead reference(s); ${mediaNeedsOwnerTotal} need the owner.`
				: ""),
	);
	if (oracleFailures.length > 0) {
		console.log(
			`\n✗ The strictly-decreasing oracle FAILED for ${oracleFailures.length} app(s) — nothing was written for them:\n` +
				oracleFailures.map((entry) => `  - ${entry}`).join("\n"),
		);
		process.exitCode = 1;
	}
	if (failedApps.length > 0) {
		console.log(
			`\n✗ ${failedApps.length} app(s) couldn't be processed (stored doc too broken to read — see the per-app reports above) and need the owner:\n` +
				failedApps.map((entry) => `  - ${entry}`).join("\n"),
		);
		process.exitCode = 1;
	}
	if (!apply) {
		console.log("Re-run with --apply to write.");
	} else {
		console.log("Verify with: npx tsx scripts/scan-legacy-findings.ts");
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
