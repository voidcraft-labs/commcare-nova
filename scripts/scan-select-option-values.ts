/**
 * READ-ONLY — census of inline select option VALUES that CommCare cannot
 * carry safely: whitespace (the device throws on any select value holding
 * a space, and a multi-select answer is a space-joined token list) and the
 * quote characters JavaRosa's parser flags (`'`, `"`, `` ` ``).
 *
 * The sizing run for the `SELECT_OPTION_VALUE_INVALID` validator rule: how
 * many stored apps carry such a value, by field kind, and which ones.
 *
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL`
 * locally); `--prod` targets the production instance over its public IP
 * (see `./lib/prodDb.ts`). Never writes. Run with `--help` for flags.
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadAppForInspection } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	app?: string;
	prod?: boolean;
	verbose?: boolean;
}

const program = new Command();
program
	.name("scan-select-option-values")
	.description(
		"Census of inline select option values holding whitespace or quote characters (read-only).",
	)
	.option("--app <appId>", "scope the scan to a single app")
	.option("--verbose", "print every offending value")
	.option(
		"--prod",
		"scan the production Cloud SQL instance (public IP + your gcloud IAM identity)",
	);
program.parse();
const opts = program.opts<ScanOptions>();

if (opts.prod === true) {
	targetProdDb();
}

const WHITESPACE = /\s/;
const QUOTES = /['"`]/;

async function main() {
	const db = await getAppDb();

	let appQuery = db.selectFrom("apps").select("id");
	if (opts.app !== undefined) {
		appQuery = appQuery.where("id", "=", opts.app);
	}
	const appRows = await appQuery.execute();

	console.log(`Scanning ${appRows.length} app(s) for unsafe option values…\n`);

	const perKind = new Map<
		string,
		{ fields: number; values: number; apps: Set<string> }
	>();
	let emptyValues = 0;
	const failedApps: string[] = [];
	let totalOptions = 0;

	for (const { id } of appRows) {
		const appDoc = await loadAppForInspection(id).catch((err: unknown) => {
			failedApps.push(id);
			console.log(
				`${id}\n  ✗ COULDN'T SCAN: ${err instanceof Error ? err.message : String(err)}\n`,
			);
			return null;
		});
		if (!appDoc) continue;

		const fields = appDoc.blueprint.fields as Record<
			string,
			{
				id?: string;
				kind?: string;
				optionsSource?: {
					kind?: string;
					options?: ReadonlyArray<{ value?: string }>;
				};
			}
		>;
		const appLines: string[] = [];
		for (const field of Object.values(fields)) {
			const source = field.optionsSource;
			if (source?.kind !== "inline" || source.options === undefined) continue;
			let fieldHit = false;
			for (const option of source.options) {
				totalOptions++;
				const value = option.value ?? "";
				if (value === "") {
					emptyValues++;
					continue;
				}
				if (!WHITESPACE.test(value) && !QUOTES.test(value)) continue;
				fieldHit = true;
				const kind = field.kind ?? "?";
				const entry = perKind.get(kind) ?? {
					fields: 0,
					values: 0,
					apps: new Set<string>(),
				};
				entry.values++;
				entry.apps.add(id);
				perKind.set(kind, entry);
				appLines.push(`  ${kind} ${field.id ?? "?"}: ${JSON.stringify(value)}`);
			}
			if (fieldHit) {
				const entry = perKind.get(field.kind ?? "?");
				if (entry) entry.fields++;
			}
		}
		if (appLines.length > 0 && opts.verbose === true) {
			console.log(`${id} (${appDoc.app_name || "unnamed"}) — ${appDoc.status}`);
			for (const line of appLines) console.log(line);
			console.log("");
		}
	}

	console.log(`Inline options scanned: ${totalOptions}`);
	console.log(`Empty values: ${emptyValues}`);
	for (const [kind, entry] of perKind) {
		console.log(
			`${kind}: ${entry.values} unsafe value(s) on ${entry.fields} field(s) across ${entry.apps.size} app(s): ${[...entry.apps].join(", ")}`,
		);
	}
	if (perKind.size === 0) console.log("No unsafe option values found.");
	if (failedApps.length > 0) {
		console.log(`${failedApps.length} app(s) could not be scanned.`);
	}
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
