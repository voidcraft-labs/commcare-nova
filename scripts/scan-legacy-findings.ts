/**
 * READ-ONLY — find every standing validator finding in stored apps,
 * the pre-commit-gate debris the zero-tolerance export boundary would
 * refuse after the valid-by-construction merge.
 *
 * One-time merge choreography: the owner runs this against production
 * first, then `repair-legacy-findings.ts` (dry-run, then `--apply`),
 * then this scan again — which must report ZERO findings before the
 * expression-AST scan/migrate pair runs.
 *
 * How each app is read: production blueprints may still be
 * STRING-expression shaped (written before the expression-AST
 * migration), so the scan loads them the way `migrate-expression-asts`
 * does — raw cast + the shared round-trip-gated converter on a CLONE —
 * never the strict runtime Zod gate, which rejects string slots. The
 * converted clone is the exact shape the deployed code reads.
 *
 * What is evaluated: the full validator at full scope — the same
 * evaluation `collectBoundaryViolations` performs MINUS the media-asset
 * manifest arm (asset existence / readiness / kind and the export byte
 * budget). Asset state is environment, not blueprint content, and media
 * readiness is being fixed at its own source. Two further carve-outs,
 * both by design: an EMPTY app keeps its birth findings (reported as a
 * note, never counted — an empty app is at rest and its export refusal
 * is intentional), and CONNECT_FORM_MISSING_BLOCK is annotated
 * RULE-RETIRING (Connect's ingestion skips blockless forms, the rule is
 * being removed from the validator, the findings vanish with no data
 * change).
 *
 * Exits non-zero when any findings exist. Run with `--help` for flags.
 */
import { Firestore } from "@google-cloud/firestore";
import { Command } from "commander";
import type {
	ValidationError,
	ValidationErrorCode,
} from "../lib/commcare/validator/errors";
import { VALIDITY_CLASS_BY_CODE } from "../lib/commcare/validator/gate";
import {
	describeFindingLocation,
	evaluateLegacyFindings,
	judgmentFor,
	toLegacyBlueprintView,
} from "./lib/legacyFindingRepairs";
import { runMain } from "./lib/main";

interface ScanOptions {
	project: string;
}

const program = new Command();
program
	.name("scan-legacy-findings")
	.description(
		"Report every standing validator finding in stored apps (read-only) — the legacy debris the zero-tolerance export boundary would refuse. " +
			"One-time: run against production before repair-legacy-findings.ts, and again after it (the re-scan must report zero findings). " +
			"Evaluates the export boundary's full validation MINUS the media-asset manifest arm (asset state is environment, not blueprint content; media readiness is fixed at its own source).",
	)
	.requiredOption(
		"--project <id>",
		'GCP project to scan (e.g. "commcare-nova-dev") — explicit so a scan can never land on an unintended project',
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-legacy-findings.ts --project commcare-nova-dev\n",
	);

program.parse();
const { project } = program.opts<ScanOptions>();

const JUDGMENT_LABEL = {
	mechanical: "REPAIRABLE",
	proposed: "PROPOSED",
	"needs-owner": "NEEDS OWNER",
	"rule-retiring": "RULE RETIRING",
} as const;

function findingLine(err: ValidationError): string {
	const cls = VALIDITY_CLASS_BY_CODE[err.code] ?? "soundness";
	return (
		`  [${cls}] ${err.code} — ${describeFindingLocation(err)}\n` +
		`      ${err.message}`
	);
}

async function main() {
	const db = new Firestore({ projectId: project, preferRest: true });
	console.log(`Scanning apps in project "${project}"…\n`);

	const apps = await db.collection("apps").get();
	let appsWithFindings = 0;
	let emptyApps = 0;
	let blueprintless = 0;
	let conversionFailures = 0;
	const tally = new Map<ValidationErrorCode, number>();

	for (const appSnap of apps.docs) {
		const data = appSnap.data();
		const label = `${appSnap.id} (${data.app_name ?? "unnamed"})`;

		const blueprint = data.blueprint;
		if (!blueprint) {
			blueprintless++;
			continue;
		}

		const { doc, conversion } = toLegacyBlueprintView(blueprint);
		for (const failure of conversion.failures) {
			conversionFailures++;
			console.log(
				`${label}\n  EXPRESSION ROUND-TRIP FAIL [${failure.slot} on ${failure.entityUuid}] — ` +
					"a parser/printer bug, owned by scan-expression-asts.ts; this scan evaluated the slot as stored.\n" +
					`      stored:  ${JSON.stringify(failure.text)}\n` +
					`      printed: ${JSON.stringify(failure.printed)}`,
			);
		}

		const { findings, birth } = evaluateLegacyFindings(doc);
		if (findings.length === 0) {
			if (birth.length > 0) emptyApps++;
			continue;
		}

		appsWithFindings++;
		console.log(`${label} — ${findings.length} finding(s)`);
		for (const err of findings) {
			tally.set(err.code, (tally.get(err.code) ?? 0) + 1);
			console.log(findingLine(err));
		}
		if (birth.length > 0) {
			console.log(
				"  (plus the empty-app birth state — by design, not counted)",
			);
		}
		console.log("");
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
		`${apps.size} app(s) scanned; ${appsWithFindings} with findings; ` +
			`${emptyApps} empty (birth state, by design); ${blueprintless} with no stored blueprint; ` +
			`${conversionFailures} expression round-trip failure(s).`,
	);
	if (appsWithFindings > 0) {
		console.log(
			`\nRepair with: npx tsx scripts/repair-legacy-findings.ts --project ${project} (dry run; add --apply to write, --apply-proposed for the proposed tier)`,
		);
		process.exitCode = 1;
	} else {
		console.log(
			"\nNo legacy findings — every stored app passes the export boundary's blueprint checks.",
		);
	}
}

runMain(main);
