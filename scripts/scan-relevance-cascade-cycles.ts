/**
 * READ-ONLY — find every stored app whose forms carry a relevance-cascade
 * cycle: a group or repeat whose display condition depends on one of its
 * own descendants.
 *
 * The sizing run for the validator change that teaches `TriggerDag`'s
 * authoring cycle proof the edge JavaRosa draws from a container's
 * `relevant` to everything inside it (`commcare-core
 * .../FormDef.java::fillTriggeredElements`). CommCare already refuses such
 * a form at install ("Logic is cyclical"), so every app listed here could
 * not build on HQ before the change; after it, the commit gate refuses any
 * further edit to the app until the loop is broken, and the export boundary
 * names the loop instead of letting HQ find it. This script says which apps
 * those are, with the exact loop, so their owners can be told.
 *
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL`
 * locally); `--prod` targets the production instance over its public IP
 * (see `./lib/prodDb.ts`). Never writes. Run with `--help` for flags.
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { validateBlueprintDeep } from "@/lib/commcare/validator";
import { loadAppForInspection } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-relevance-cascade-cycles")
	.description(
		"List every stored app with a group or repeat whose display condition depends on one of its own descendants (read-only). " +
			"CommCare refuses such a form at install; the validator now refuses it at commit.",
	)
	.option("--app <appId>", "scope the scan to a single app")
	.option(
		"--prod",
		"scan the production Cloud SQL instance (public IP + your gcloud IAM identity)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx --conditions=react-server scripts/scan-relevance-cascade-cycles.ts\n" +
			"  $ npx tsx --conditions=react-server scripts/scan-relevance-cascade-cycles.ts --prod\n" +
			"  $ npx tsx --conditions=react-server scripts/scan-relevance-cascade-cycles.ts --app <appId> --prod\n",
	);
program.parse();
const opts = program.opts<ScanOptions>();

if (opts.prod === true) {
	targetProdDb();
}

async function main() {
	const db = await getAppDb();

	let appQuery = db.selectFrom("apps").select("id");
	if (opts.app !== undefined) {
		appQuery = appQuery.where("id", "=", opts.app);
	}
	const appRows = await appQuery.execute();
	if (opts.app !== undefined && appRows.length === 0) {
		console.error(`App ${opts.app} not found.`);
		process.exit(1);
	}

	console.log(
		`Scanning ${appRows.length} app(s) for relevance-cascade cycles…\n`,
	);

	let affectedApps = 0;
	let affectedForms = 0;
	let otherCycleApps = 0;
	const failedApps: string[] = [];

	for (const { id } of appRows) {
		const appDoc = await loadAppForInspection(id).catch((err: unknown) => {
			failedApps.push(id);
			console.log(
				`${id}\n  ✗ COULDN'T SCAN — the stored blueprint couldn't be assembled:\n` +
					`      ${err instanceof Error ? err.message : String(err)}\n`,
			);
			return null;
		});
		if (!appDoc) continue;

		const doc = hydratePersistedBlueprint(appDoc.blueprint);
		const cycles = validateBlueprintDeep(doc).filter((e) => e.kind === "cycle");
		if (cycles.length === 0) continue;

		const cascades = cycles.filter(
			(e) => e.kind === "cycle" && e.cascade !== undefined,
		);
		if (cascades.length === 0) {
			/* A pre-existing authored-expression loop the gate already refuses;
			 * counted so the report separates "new refusal" from "old refusal". */
			otherCycleApps++;
			continue;
		}

		affectedApps++;
		console.log(`${id} (${appDoc.app_name || "unnamed"}) — ${appDoc.status}`);
		const forms = new Set<string>();
		for (const finding of cascades) {
			if (finding.kind !== "cycle" || finding.cascade === undefined) continue;
			forms.add(finding.formUuid);
			console.log(
				`  "${finding.formName}" in "${finding.moduleName}": ${finding.cycle.join(" → ")}`,
			);
			console.log(
				`      ${finding.cascade.containerKind} ${finding.cascade.container} reads its descendant ${finding.cascade.descendant}`,
			);
		}
		affectedForms += forms.size;
		console.log("");
	}

	const failedSuffix =
		failedApps.length > 0
			? ` (${failedApps.length} app(s) could not be scanned: ${failedApps.join(", ")})`
			: "";
	console.log(
		`Done: ${affectedApps} app(s) / ${affectedForms} form(s) carry a relevance-cascade cycle; ` +
			`${otherCycleApps} app(s) carry only a pre-existing authored-expression cycle${failedSuffix}.`,
	);
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
