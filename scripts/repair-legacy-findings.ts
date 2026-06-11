/**
 * ⚠️  WRITES — repair the mechanically-repairable validator findings in
 * stored apps, so legacy pre-commit-gate apps pass the zero-tolerance
 * export boundary after the valid-by-construction merge.
 *
 * One-time merge choreography: `scan-legacy-findings.ts` first, then
 * this script as a dry run, review, then `--apply` (and
 * `--apply-proposed` for the proposed tier, if accepted), then the scan
 * again — which must report ZERO findings. Needs-owner findings are
 * printed per app and never auto-fixed; the owner resolves those by
 * hand before the re-scan.
 *
 * Per app: the stored blueprint loads the way `migrate-expression-asts`
 * reads it (raw cast + the shared round-trip-gated string→AST converter
 * on a clone — prod docs may predate the AST migration, and repairs
 * MUST run on the AST view because the current reducers track renames
 * through identity leaves, not text rewriting). Each repair is a
 * mutation batch through the REAL reducers, gated by the same commit
 * verdict every live write surface runs; after an app's repairs the
 * strictly-decreasing oracle must hold — finding count strictly down,
 * zero introduced identities (`diffIntroduced`) — or the app is
 * reported and NOT written. The judgment table (which classes are
 * mechanical / proposed / needs-owner / rule-retiring, and why) lives
 * in `scripts/lib/legacyFindingRepairs.ts`.
 *
 * A written blueprint lands in the expression-AST shape (the converter
 * runs as part of the load) — `migrate-expression-asts.ts` later reads
 * those slots as already current; event logs are untouched here and
 * convert in that script.
 *
 * Idempotent (a repaired app re-evaluates clean, so a re-run plans
 * nothing) and resumable per app (each app loads, repairs, and writes
 * independently — a re-run after an interruption skips the finished
 * ones). Run with `--help` for flags.
 */
import { Firestore } from "@google-cloud/firestore";
import { Command } from "commander";
import { toPersistableDoc } from "../lib/doc/fieldParent";
import {
	describeFindingLocation,
	evaluateLegacyFindings,
	type FindingReport,
	judgmentFor,
	repairApp,
	toLegacyBlueprintView,
} from "./lib/legacyFindingRepairs";
import { runMain } from "./lib/main";

interface RepairOptions {
	project: string;
	apply?: boolean;
	applyProposed?: boolean;
}

const program = new Command();
program
	.name("repair-legacy-findings")
	.description(
		"Repair the mechanically-repairable validator findings in stored apps. Defaults to a dry run — pass --apply to write. " +
			"PROPOSED repairs (content-adjacent, e.g. seeding the case_name case-list column) print in every run but apply only under --apply-proposed. " +
			"One-time: scan-legacy-findings.ts → this (dry run → --apply) → re-scan to zero, before the expression-AST migration pair.",
	)
	.requiredOption(
		"--project <id>",
		'GCP project to repair (e.g. "commcare-nova-dev") — explicit so a write can never land on an unintended project',
	)
	.option("--apply", "actually write the repairs (default: dry run)")
	.option(
		"--apply-proposed",
		"also apply PROPOSED-tier repairs (printed-only by default)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/repair-legacy-findings.ts --project commcare-nova-dev                           # dry run\n" +
			"  $ npx tsx scripts/repair-legacy-findings.ts --project commcare-nova-dev --apply                   # write mechanical repairs\n" +
			"  $ npx tsx scripts/repair-legacy-findings.ts --project commcare-nova-dev --apply --apply-proposed  # include the proposed tier\n",
	);

program.parse();
const { project, apply, applyProposed } = program.opts<RepairOptions>();

function printReports(prefix: string, reports: readonly FindingReport[]): void {
	for (const { finding, description } of reports) {
		console.log(
			`  ${prefix} ${finding.code} — ${describeFindingLocation(finding)}`,
		);
		console.log(`      ${description}`);
	}
}

async function main() {
	// `ignoreUndefinedProperties` matches the app's own Firestore client:
	// the drop-this-config repairs (close conditions, post-submit) clear
	// their slot with an in-memory `undefined`, which the write must strip
	// rather than throw on.
	const db = new Firestore({
		projectId: project,
		preferRest: true,
		ignoreUndefinedProperties: true,
	});
	console.log(
		`${apply ? "REPAIRING" : "Dry run over"} apps in project "${project}"` +
			`${applyProposed ? " (proposed tier included)" : ""}…\n`,
	);

	const apps = await db.collection("apps").get();
	let appsRepaired = 0;
	let findingsCleared = 0;
	let proposedWithheld = 0;
	let needsOwnerTotal = 0;
	const oracleFailures: string[] = [];

	for (const appSnap of apps.docs) {
		const data = appSnap.data();
		const label = `${appSnap.id} (${data.app_name ?? "unnamed"})`;
		const blueprint = data.blueprint;
		if (!blueprint) continue;

		const { doc } = toLegacyBlueprintView(blueprint);
		if (evaluateLegacyFindings(doc).findings.length === 0) continue;

		const outcome = repairApp(doc, { applyProposed: applyProposed ?? false });
		console.log(
			`${label} — ${outcome.before.length} finding(s) → ${outcome.after.length}` +
				(outcome.proposed.length > 0
					? ` (${outcome.after.length - outcome.proposed.length} with --apply-proposed)`
					: ""),
		);
		printReports(apply ? "REPAIRED" : "WOULD REPAIR", outcome.applied);
		printReports("PROPOSED (needs --apply-proposed)", outcome.proposed);
		for (const { finding, description, introduced } of outcome.rejected) {
			console.log(
				`  GATE-REFUSED ${finding.code} — ${describeFindingLocation(finding)}\n` +
					`      the planned repair (${description}) would itself introduce:\n` +
					introduced.map((e) => `        - ${e.message}`).join("\n"),
			);
		}
		printReports("DID NOT CLEAR", outcome.uncleared);
		for (const finding of outcome.after) {
			const judgment = judgmentFor(finding.code);
			if (judgment.kind === "mechanical" || judgment.kind === "proposed") {
				continue; // already reported above as proposed/rejected/uncleared
			}
			needsOwnerTotal++;
			const tag =
				judgment.kind === "rule-retiring" ? "RULE-RETIRING" : "NEEDS OWNER";
			console.log(
				`  ${tag} ${finding.code} — ${describeFindingLocation(finding)}\n` +
					`      ${finding.message}\n` +
					`      (${judgment.reason})`,
			);
		}

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

		if (outcome.changed) {
			appsRepaired++;
			findingsCleared += outcome.applied.length;
			if (apply) {
				await appSnap.ref.update({
					blueprint: toPersistableDoc(outcome.doc),
				});
			}
		}
		proposedWithheld += outcome.proposed.length;
		console.log("");
	}

	console.log(
		`${apply ? "Repaired" : "Would repair"} ${findingsCleared} finding(s) across ${appsRepaired} app(s) ` +
			`of ${apps.size} scanned. ${proposedWithheld} proposed repair(s) withheld; ` +
			`${needsOwnerTotal} finding(s) need the owner.`,
	);
	if (oracleFailures.length > 0) {
		console.log(
			`\n✗ The strictly-decreasing oracle FAILED for ${oracleFailures.length} app(s) — nothing was written for them:\n` +
				oracleFailures.map((entry) => `  - ${entry}`).join("\n"),
		);
		process.exitCode = 1;
	}
	if (!apply) {
		console.log("Re-run with --apply to write.");
	} else {
		console.log(
			`Verify with: npx tsx scripts/scan-legacy-findings.ts --project ${project}`,
		);
	}
}

runMain(main);
