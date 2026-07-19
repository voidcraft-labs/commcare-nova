/**
 * ONE-OFF — resolve the needs-owner validator findings the
 * scan-legacy-findings.ts prod run of 2026-07-19 reported, with the owner
 * decision recorded per app below. The repair pipeline deliberately
 * withholds these classes (`legacyFindingRepairs.ts` marks them
 * needs-owner) because the right fix is a content judgment; this script IS
 * that judgment, made after inspecting each app:
 *
 *   - Dispenser Routine Visit: declare the `household` case type. The
 *     Households module already carries `caseType: "household"` and every
 *     HH Survey field writes to it, so the absent catalog record is a
 *     historical gap, not a deliberately-retired type — declaring it
 *     restores validity with zero behavior change.
 *
 *   - Four Connect-app modules with no forms and no case list (the whole
 *     app, in three of them): seed the canonical survey-form scaffold
 *     (`formScaffoldMutations` — the exact born-valid shape the builder's
 *     own "add form" gesture creates). The authored module names
 *     ("Interview Training", "6. FLW safety briefing", …) are staged
 *     intent for content not yet written; the scaffold preserves them and
 *     unblocks export, where deletion would drop them and invented
 *     domain content would be fabrication.
 *
 * Dry-run by default; `--execute` writes through `appendSyntheticBatch`
 * (transactional whole-doc replace + reload sentinel, so a live builder
 * tab reloads instead of clobbering). Verify with
 * `scan-legacy-findings.ts` afterwards — the five apps must report zero
 * findings. Delete this script in a follow-up commit once prod converges.
 *
 * Reads/writes the database the env provides; `--prod` targets production
 * (see `./lib/prodDb.ts` — writes additionally need the impersonated
 * runtime-SA credentials, since developer IAM users are read-only).
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { appendSyntheticBatch, loadApp } from "../lib/db/apps";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "../lib/doc/fieldParent";
import { applyMutations } from "../lib/doc/mutations";
import {
	declareCaseTypeMutations,
	formScaffoldMutations,
} from "../lib/doc/scaffolds";
import type { BlueprintDoc } from "../lib/domain";
import { evaluateLegacyFindings } from "./lib/legacyFindingRepairs";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

type Decision =
	| {
			appId: string;
			appName: string;
			kind: "declare-case-type";
			caseType: string;
	  }
	| {
			appId: string;
			appName: string;
			kind: "seed-survey-form";
			moduleName: string;
			/** Also clear `connectType`. The two ACE husks are Connect-flagged
			 * apps with zero Connect content anywhere — no forms at all — so
			 * `CONNECT_NO_PARTICIPATING_FORMS` fires the moment any form
			 * exists. Fabricating a PAYABLE deliver unit (or a learn module)
			 * on a placeholder form would invent Connect semantics; clearing
			 * the flag on an empty app is the finding's own second remedy and
			 * is trivially re-enabled when real content lands. */
			disableConnect?: true;
	  };

const DECISIONS: readonly Decision[] = [
	{
		appId: "NLMGLyWVIrv974yoS9ik",
		appName: "Dispenser Routine Visit",
		kind: "declare-case-type",
		caseType: "household",
	},
	{
		appId: "59R3pGaed9GsfSM4ieha",
		appName: "ACE Interviews V1 Deliver",
		kind: "seed-survey-form",
		moduleName: "Interview Delivery",
		disableConnect: true,
	},
	{
		appId: "B8oDse4WY6Dax4axn5fH",
		appName: "Turmeric Market Survey — Learn",
		kind: "seed-survey-form",
		moduleName: "6. FLW safety briefing",
	},
	{
		appId: "F4v0ZC40PKiHH4FIdQd1",
		appName: "Bednet Spot-Check — Learn",
		kind: "seed-survey-form",
		moduleName: "Connect Basics",
	},
	{
		appId: "HLZHA0CAfa4JiUEKmQM7",
		appName: "ACE Interviews V1 Learn",
		kind: "seed-survey-form",
		moduleName: "Interview Training",
		disableConnect: true,
	},
];

const program = new Command();
program
	.name("migrate-needs-owner-findings")
	.description(
		"Apply the recorded owner decisions for the 2026-07-19 needs-owner findings (dry run by default).",
	)
	.option("--execute", "actually write the repaired docs")
	.option(
		"--prod",
		"target the production Cloud SQL instance (public IP; writes need the impersonated runtime SA)",
	);

program.parse();
const opts = program.opts<{ execute?: boolean; prod?: boolean }>();
if (opts.prod === true) {
	targetProdDb();
}

/** Apply one decision in place; returns a human line describing the change. */
function applyDecision(doc: BlueprintDoc, decision: Decision): string {
	if (decision.kind === "declare-case-type") {
		const mutations = declareCaseTypeMutations(doc, decision.caseType);
		if (mutations.length === 0) {
			throw new Error(
				`"${decision.caseType}" is already declared on ${decision.appId} — the finding this decision resolves is gone; re-scan before running.`,
			);
		}
		applyMutations(doc, mutations);
		return `declared case type "${decision.caseType}"`;
	}
	const matches = Object.values(doc.modules).filter(
		(mod) => mod.name === decision.moduleName,
	);
	const mod = matches[0];
	if (matches.length !== 1 || mod === undefined) {
		throw new Error(
			`Expected exactly one module named "${decision.moduleName}" on ${decision.appId}, found ${matches.length} — the app changed since the decision was made; re-inspect before running.`,
		);
	}
	if ((doc.formOrder[mod.uuid] ?? []).length > 0 || mod.caseListOnly === true) {
		throw new Error(
			`Module "${decision.moduleName}" on ${decision.appId} is no longer formless — the finding this decision resolves is gone; re-scan before running.`,
		);
	}
	const scaffold = formScaffoldMutations(doc, mod.uuid, "survey");
	if (scaffold === null) {
		throw new Error(
			`Could not build the survey scaffold for module "${decision.moduleName}" on ${decision.appId}.`,
		);
	}
	applyMutations(doc, scaffold.mutations);
	if (decision.disableConnect === true) {
		applyMutations(doc, [{ kind: "setConnectType", connectType: null }]);
		return `seeded the survey-form scaffold into module "${decision.moduleName}" and turned Connect off (no participating content exists)`;
	}
	return `seeded the survey-form scaffold into module "${decision.moduleName}"`;
}

async function main() {
	console.log(
		`${opts.execute ? "APPLYING" : "Dry run of"} the recorded needs-owner decisions…\n`,
	);
	let failures = 0;
	for (const decision of DECISIONS) {
		const label = `${decision.appId} (${decision.appName})`;
		try {
			const app = await loadApp(decision.appId);
			if (!app) {
				throw new Error("app row not found");
			}
			const doc = hydratePersistedBlueprint(
				app.blueprint as Parameters<typeof hydratePersistedBlueprint>[0],
			);
			const before = evaluateLegacyFindings(doc).findings.length;
			const description = applyDecision(doc, decision);
			const after = evaluateLegacyFindings(doc).findings;
			if (after.length !== 0) {
				throw new Error(
					`repair left ${after.length} finding(s) standing — expected zero; nothing was written for this app:\n` +
						after
							.map((finding) => `      [${finding.code}] ${finding.message}`)
							.join("\n"),
				);
			}
			if (opts.execute) {
				await appendSyntheticBatch(decision.appId, toPersistableDoc(doc));
			}
			console.log(
				`${label}\n  ${opts.execute ? "✔ WROTE" : "would write"}: ${description} (${before} finding(s) → 0)\n`,
			);
		} catch (err) {
			failures += 1;
			console.log(
				`${label}\n  ✗ SKIPPED — ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}
	if (failures > 0) {
		console.log(
			`${failures} decision(s) did not apply. Nothing else was affected.`,
		);
		process.exitCode = 1;
		return;
	}
	console.log(
		opts.execute
			? "All decisions applied. Verify with: npx tsx scripts/scan-legacy-findings.ts --prod"
			: "All decisions apply cleanly. Re-run with --execute to write.",
	);
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
