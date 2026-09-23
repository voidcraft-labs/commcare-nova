/** Read-only scan. Run with NODE_OPTIONS=--conditions=react-server. */
import { parseArgs } from "node:util";
import { scanTrialLedger } from "./lib/authoringLedgerMigration";

async function main() {
	const { values } = parseArgs({
		options: {
			source: { type: "string" },
			ceiling: { type: "string" },
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(
			"--source <legacy-ledger.json> --ceiling <authorized-total-usd>",
		);
	} else {
		if (!values.source || !values.ceiling)
			throw new Error("Source and authorized ceiling are required.");
		const { ledger, ...report } = await scanTrialLedger(
			values.source,
			Number(values.ceiling),
		);
		console.log(
			JSON.stringify(
				{
					...report,
					ceilingUsd: ledger.ceilingUsd,
					reconciledUsd: ledger.estimatedSpentUsd,
					calls: ledger.calls.length,
				},
				null,
				2,
			),
		);
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
