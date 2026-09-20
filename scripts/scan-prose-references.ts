/** Read-only inventory. Production contents go only to the explicit private output. */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { canonicalJsonDigest } from "../lib/utils/canonicalJson";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import { scanProseReferenceRepair } from "./lib/proseReferenceRepair";

const options = new Command()
	.description("Read-only historical prose-reference scan.")
	.option("--prod", "read production using the operator identity")
	.option(
		"--output <path>",
		"write a private manifest and digest; existing files refuse",
	)
	.parse()
	.opts<{ prod?: boolean; output?: string }>();
if (options.prod) targetProdDb();
runMain(async () => {
	try {
		const result = await scanProseReferenceRepair();
		const digest = canonicalJsonDigest(result.manifest);
		if (options.output && result.blocked.length === 0) {
			await writeFile(
				options.output,
				JSON.stringify(result.manifest, null, 2),
				{ mode: 0o600, flag: "wx" },
			);
			await writeFile(`${options.output}.sha256`, `${digest}\n`, {
				mode: 0o600,
				flag: "wx",
			});
		}
		console.log(
			JSON.stringify({
				scannedApps: result.scannedApps,
				affectedApps: result.manifest.entries.length,
				slots: result.manifest.entries.reduce(
					(count, app) => count + app.changes.length,
					0,
				),
				references: result.manifest.entries.reduce(
					(count, app) =>
						count +
						app.changes.reduce((n, change) => n + change.tokens.length, 0),
					0,
				),
				manifestDigest: digest,
				blocked: result.blocked,
			}),
		);
		if (result.blocked.length) process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
});
