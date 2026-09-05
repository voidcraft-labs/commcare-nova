/** Historical select-value repair. Scan by default; production --prod is read only. */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "@/scripts/lib/main";
import { targetProdDb } from "@/scripts/lib/prodDb";
import {
	listRepairCandidateAppIds,
	loadSelectOptionValueRepairSnapshot,
	planSelectOptionValueRepair,
	runSelectOptionValueRepair,
} from "@/scripts/lib/selectOptionValueRepair";

const options = new Command()
	.option("--prod", "scan production without writing")
	.option(
		"--execute",
		"apply the historical repair under the maintenance identity",
	)
	.parse()
	.opts<{ prod?: boolean; execute?: boolean }>();
if (options.prod && options.execute) {
	throw new Error(
		"--prod is read only. Execute the immutable maintenance Job to repair production.",
	);
}
if (options.prod) targetProdDb();
runMain(async () => {
	try {
		const appIds = await listRepairCandidateAppIds();
		if (options.execute) {
			const report = await runSelectOptionValueRepair(appIds);
			console.log(JSON.stringify(report));
			if (report.blockedApps.length > 0) process.exitCode = 1;
			return;
		}
		let appsNeedingRepair = 0;
		for (const appId of appIds) {
			const snapshot = await loadSelectOptionValueRepairSnapshot(appId);
			if (
				snapshot &&
				planSelectOptionValueRepair(snapshot.blueprint).rewrites.length > 0
			) {
				appsNeedingRepair++;
			}
		}
		console.log(
			JSON.stringify({ scannedApps: appIds.length, appsNeedingRepair }),
		);
		if (appsNeedingRepair > 0) process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
});
