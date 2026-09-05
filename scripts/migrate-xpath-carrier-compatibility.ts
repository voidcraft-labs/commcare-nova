/**
 * READ-ONLY DEPLOY GATE: verify current apps against the absolute XPath
 * carrier contract. The migration image runs this before traffic shifts, but
 * it never rewrites authored expressions.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { runXPathCarrierCompatibilityVerification } from "./lib/xpathCarrierCompatibilityRepair";

interface Options {
	app?: string;
}

const program = new Command();
program
	.name("migrate-xpath-carrier-compatibility")
	.description(
		"Verify current apps against the XPath carrier gate without rewriting authored expressions.",
	)
	.option("--app <appId>", "scope verification to one app")
	.addHelpText(
		"after",
		"\nProduction verification uses scripts/scan-xpath-carrier-compatibility.ts --prod. There is intentionally no writer mode.\n",
	);
program.parse();
const options = program.opts<Options>();

async function main(): Promise<void> {
	const report = await runXPathCarrierCompatibilityVerification(
		options.app === undefined ? undefined : [options.app],
	);
	console.log(
		JSON.stringify({
			severity: "INFO",
			message: "XPath carrier compatibility verified",
			...report,
		}),
	);
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
