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
import { scanBlueprintXPathCarriers } from "./lib/xpathCompatibilityScan";

interface Options {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-xpath-carrier-compatibility")
	.description(
		"Read stored XPath calls and classify them for JavaRosa and Nova Preview; never writes.",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option("--prod", "scan production through the read-only operator identity");
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getAppDb();
	let query = db.selectFrom("apps").select("id");
	if (options.app !== undefined) query = query.where("id", "=", options.app);
	const rows = await query.execute();
	if (options.app !== undefined && rows.length === 0) {
		throw new Error(`App ${options.app} not found.`);
	}

	let expressions = 0;
	let calls = 0;
	let javaRosaLowered = 0;
	let javaRosaUnsafe = 0;
	let previewUnsupported = 0;
	let failedApps = 0;
	for (const { id } of rows) {
		let loadFailed = false;
		const app = await loadSchemaAdmittedAppForInspection(id).catch(
			(error: unknown) => {
				failedApps += 1;
				loadFailed = true;
				console.error(
					`${id}: could not assemble stored blueprint: ${error instanceof Error ? error.message : String(error)}`,
				);
				return null;
			},
		);
		if (app === null) {
			if (!loadFailed) {
				failedApps += 1;
				console.error(`${id}: app disappeared while the scan was reading it`);
			}
			continue;
		}
		const doc = hydratePersistedBlueprint(app.blueprint);
		for (const occurrence of scanBlueprintXPathCarriers(doc)) {
			expressions += 1;
			for (const call of occurrence.calls) {
				calls += 1;
				if (call.javaRosa === "lowered") javaRosaLowered += 1;
				const unsafe =
					call.javaRosa === "unsupported" ||
					call.javaRosa === "context-handler" ||
					!call.validPathInitializer;
				const previewUnsafe =
					call.preview === "unsupported" ||
					(call.preview === "path-initializer" && !call.validPathInitializer);
				if (unsafe) javaRosaUnsafe += 1;
				if (previewUnsafe) previewUnsupported += 1;
				if (unsafe || call.javaRosa === "lowered" || previewUnsafe) {
					console.log(
						`${id}\t${occurrence.path}\t${call.name}()\tJavaRosa=${unsafe ? "UNSAFE" : call.javaRosa.toUpperCase()}\tPreview=${call.preview}`,
					);
				}
			}
		}
	}

	console.log(
		`Scanned ${rows.length} app(s), ${expressions} expression(s), ${calls} function call(s): ${javaRosaLowered} JavaRosa-lowered, ${javaRosaUnsafe} JavaRosa-unsafe, ${previewUnsupported} Preview-unsupported, ${failedApps} unreadable app(s).`,
	);
	if (javaRosaUnsafe > 0 || failedApps > 0) process.exitCode = 1;
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
