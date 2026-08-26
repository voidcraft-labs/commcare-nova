/**
 * READ-ONLY — inventory every stored raw-XPath function against the carrier
 * contract before validator or lowering changes ship.
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadSchemaAdmittedAppForInspection } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import {
	scanBlueprintXPathCarriers,
	summarizeXPathCompatibility,
	type XPathCompatibilityAggregate,
	xpathCompatibilityScanShouldFail,
} from "./lib/xpathCompatibilityScan";

interface Options {
	app?: string;
	debugDetails?: boolean;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-xpath-carrier-compatibility")
	.description(
		"Read stored XPath calls and classify them for JavaRosa and Nova Preview; never writes.",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--debug-details",
		"show carrier addresses and diagnostics (requires --app)",
	)
	.option("--prod", "scan production through the read-only operator identity");
program.parse();
const options = program.opts<Options>();
if (options.debugDetails === true && options.app === undefined) {
	throw new Error(
		"--debug-details requires --app so private detail stays bounded.",
	);
}
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getAppDb();
	let query = db.selectFrom("apps").select("id");
	if (options.app !== undefined) query = query.where("id", "=", options.app);
	const rows = await query.execute();
	if (options.app !== undefined && rows.length === 0) {
		throw new Error("No app matched --app.");
	}

	let expressions = 0;
	let functionCalls = 0;
	let javaRosaLowered = 0;
	let errorFindings = 0;
	let failedApps = 0;
	const aggregates = new Map<string, XPathCompatibilityAggregate>();
	for (const { id } of rows) {
		try {
			const app = await loadSchemaAdmittedAppForInspection(id);
			if (app === null)
				throw new Error("App disappeared while the scan read it.");
			const occurrences = scanBlueprintXPathCarriers(
				hydratePersistedBlueprint(app.blueprint),
			);
			const summary = summarizeXPathCompatibility(occurrences);
			expressions += summary.expressions;
			functionCalls += summary.functionCalls;
			javaRosaLowered += summary.javaRosaLoweredCalls;
			errorFindings += summary.errorFindings;
			for (const finding of summary.findings) {
				const key = `${finding.profile}\u0000${finding.severity}\u0000${finding.code}`;
				const previous = aggregates.get(key);
				aggregates.set(key, {
					...finding,
					count: (previous?.count ?? 0) + finding.count,
				});
			}

			if (options.debugDetails === true) {
				for (const occurrence of occurrences) {
					for (const finding of occurrence.findings) {
						console.log(
							`${id}\t${occurrence.path}\t${occurrence.profile}\t${finding.code}\t${finding.detail}`,
						);
					}
				}
			}
		} catch {
			failedApps += 1;
			if (options.debugDetails === true) {
				console.error(`${id}: could not inspect stored blueprint.`);
			}
		}
	}

	for (const finding of [...aggregates.values()].sort(
		(a, b) =>
			a.profile.localeCompare(b.profile) ||
			a.severity.localeCompare(b.severity) ||
			a.code.localeCompare(b.code),
	)) {
		console.log(
			`${finding.profile}\t${finding.code}\t${finding.severity}\t${finding.count}`,
		);
	}
	console.log(
		`Scanned ${rows.length} app(s), ${expressions} expression(s), ${functionCalls} function call(s): ${javaRosaLowered} JavaRosa-lowered, ${errorFindings} compatibility error(s), ${failedApps} unreadable app(s).`,
	);
	if (xpathCompatibilityScanShouldFail({ errorFindings }, failedApps)) {
		process.exitCode = 1;
	}
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
