/**
 * READ-ONLY — search every stored app's blueprint for construct usage.
 *
 * The sizing step before a validator or emitter change: "which stored
 * apps carry construct X, and where?" Two modes:
 *
 *   --where key=value [more pairs]   list every blueprint node carrying
 *                                    ALL the pairs, with its path
 *   --count-values <key>             census of every value the key takes
 *                                    across the fleet (nodes + apps)
 *
 * Matches run against the PERSISTED blueprint (the `PersistableDoc`
 * assembled from `blueprint_entities`) — the stored shape, without the
 * hydrated view's derived indexes attached.
 *
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL`
 * locally, the Cloud SQL connector in the migrate-job image); `--prod`
 * targets the production instance over its public IP (see
 * `./lib/prodDb.ts`). Never writes. Run with `--help` for flags.
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadApp } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import { countKeyValues, parseWherePair, scanNodes } from "./lib/blueprintScan";
import { printTable, truncate } from "./lib/format";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanBlueprintsOptions {
	where?: string[];
	countValues?: string;
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-blueprints")
	.description(
		"Search every stored app's blueprint for nodes matching key=value pairs, or census the values a key takes across the fleet (read-only). " +
			"The sizing step before a validator or emitter change: which stored apps carry construct X, and where?",
	)
	.option(
		"--where <key=value...>",
		"list every blueprint node carrying ALL the given pairs (primitive values; numbers/booleans by canonical string form)",
	)
	.option(
		"--count-values <key>",
		"tally every value the given key takes across all scanned blueprints",
	)
	.option("--app <appId>", "scope the scan to a single app")
	.option(
		"--prod",
		"scan the production Cloud SQL instance (public IP + your gcloud IAM identity)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-blueprints.ts --count-values kind\n" +
			"  $ npx tsx scripts/scan-blueprints.ts --where kind=datetime-coerce\n" +
			"  $ npx tsx scripts/scan-blueprints.ts --where kind=display field=status --app <appId>\n" +
			"  $ npx tsx scripts/scan-blueprints.ts --where kind=date-add --prod\n",
	);
program.parse();
const opts = program.opts<ScanBlueprintsOptions>();

if ((opts.where === undefined) === (opts.countValues === undefined)) {
	program.error(
		"Pass exactly one mode: --where key=value (list matching nodes) or --count-values <key> (census of a key's values).",
	);
}
/* Parse the pairs before any database access — a typo'd pair must
 * fail with its repair text, not a connection error. */
let where: ReadonlyMap<string, string>;
try {
	where = new Map((opts.where ?? []).map(parseWherePair));
} catch (err) {
	program.error(err instanceof Error ? err.message : String(err));
}
if (opts.prod === true) {
	targetProdDb();
}

async function main() {
	const db = await getAppDb();
	const countKey = opts.countValues;

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
		countKey !== undefined
			? `Censusing "${countKey}" values across ${appRows.length} app(s)…\n`
			: `Scanning ${appRows.length} app(s) for nodes where ${[...where]
					.map(([k, v]) => `${k}=${v}`)
					.join(" AND ")}…\n`,
	);

	/* Census aggregation: per distinct value, total node count + how
	 * many apps carry it at least once. The app count is the exposure
	 * number the sizing question actually needs. */
	const census = new Map<string, { nodes: number; apps: number }>();
	let matchedApps = 0;
	let matchedNodes = 0;
	const failedApps: string[] = [];

	for (const { id } of appRows) {
		const appDoc = await loadApp(id).catch((err: unknown) => {
			failedApps.push(id);
			console.log(
				`${id}\n  ✗ COULDN'T SCAN — the stored blueprint couldn't be assembled:\n` +
					`      ${err instanceof Error ? err.message : String(err)}\n`,
			);
			return null;
		});
		if (!appDoc) continue;

		if (countKey !== undefined) {
			for (const [value, count] of countKeyValues(appDoc.blueprint, countKey)) {
				const entry = census.get(value) ?? { nodes: 0, apps: 0 };
				entry.nodes += count;
				entry.apps += 1;
				census.set(value, entry);
			}
			continue;
		}

		const matches = scanNodes(appDoc.blueprint, where);
		if (matches.length === 0) continue;
		matchedApps++;
		matchedNodes += matches.length;
		console.log(`${id} (${appDoc.app_name || "unnamed"})`);
		for (const match of matches) {
			console.log(`  ${match.path === "" ? "(root)" : match.path}`);
			console.log(`      ${truncate(JSON.stringify(match.node), 160)}`);
		}
		console.log("");
	}

	const failedSuffix =
		failedApps.length > 0
			? `; ${failedApps.length} app(s) couldn't be scanned: ${failedApps.join(", ")}`
			: "";

	if (countKey !== undefined) {
		if (census.size === 0) {
			console.log(`No node carries a primitive-valued "${countKey}" key.`);
		} else {
			printTable(
				[
					{ header: "Value" },
					{ header: "Nodes", align: "right" },
					{ header: "Apps", align: "right" },
				],
				[...census.entries()]
					.sort((a, b) => b[1].nodes - a[1].nodes)
					.map(([value, { nodes, apps }]) => [
						truncate(value, 60),
						String(nodes),
						String(apps),
					]),
			);
		}
		console.log(
			`\n${appRows.length} app(s) scanned; ${census.size} distinct value(s)${failedSuffix}`,
		);
	} else {
		console.log(
			`${appRows.length} app(s) scanned; ${matchedApps} app(s) carry a match; ${matchedNodes} matching node(s)${failedSuffix}`,
		);
	}
	await closeCaseStoreDatabase();
}

runMain(main);
