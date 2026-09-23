/** One-time conversion after reviewing scan-authoring-ledger output. */
import { parseArgs } from "node:util";
import { migrateTrialLedger } from "./lib/authoringLedgerMigration";

async function main() {
	const { values } = parseArgs({
		options: {
			source: { type: "string" },
			destination: { type: "string" },
			ceiling: { type: "string" },
			"expected-sha256": { type: "string" },
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(
			"--source <legacy-ledger.json> --destination <new-ledger.json> --ceiling <authorized-total-usd> --expected-sha256 <reviewed-scan-hash>",
		);
	} else {
		if (
			!values.source ||
			!values.destination ||
			!values.ceiling ||
			!values["expected-sha256"]
		)
			throw new Error(
				"Source, new destination, authorized ceiling and reviewed scan hash are required.",
			);
		const { ledger, ...report } = await migrateTrialLedger(
			values.source,
			values.destination,
			Number(values.ceiling),
			values["expected-sha256"],
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
