/**
 * Historical hidden value-source repair: drop the dead `default_value` from
 * every hidden field that also carries a `calculate`. Dry run by default;
 * `--prod` is read only. Production writes go through the immutable
 * maintenance Job (`commcare-nova-historical-repair`, tool
 * `hidden-value-both-sources-repair.cjs`); see docs/architecture/deployment.md
 * "Historical repairs".
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import {
	listHiddenValueBothSourcesCandidateAppIds,
	runHiddenValueBothSourcesRepair,
} from "@/scripts/lib/hiddenValueBothSourcesRepair";
import { runMain } from "@/scripts/lib/main";
import { targetProdDb } from "@/scripts/lib/prodDb";

const options = new Command()
	.name("migrate-hidden-value-both-sources")
	.description(
		"Drop the dead default_value from hidden fields that also carry a calculate. Dry run unless --execute is present.",
	)
	.option("--app <appId>", "constrain the run to one app")
	.option("--prod", "scan production without writing")
	.option(
		"--execute",
		"apply the historical repair under the maintenance identity",
	)
	.addHelpText(
		"after",
		"\nThe writer reaches the app-state layer, which imports `server-only`, so run it with\n" +
			"the react-server condition (the maintenance bundle already carries it).\n" +
			"\nExamples:\n" +
			"  $ npx tsx --conditions=react-server scripts/migrate-hidden-value-both-sources.ts\n" +
			"  $ npx tsx --conditions=react-server scripts/migrate-hidden-value-both-sources.ts --app <appId> --execute\n" +
			"  $ npx tsx --conditions=react-server scripts/migrate-hidden-value-both-sources.ts --prod\n",
	)
	.parse()
	.opts<{ app?: string; prod?: boolean; execute?: boolean }>();
if (options.prod && options.execute) {
	throw new Error(
		"--prod is read only, so --execute cannot run against production from here. Execute the immutable maintenance Job instead: deploy-cloud-run.py --execute-job --job=commcare-nova-historical-repair --execution-arg=hidden-value-both-sources-repair.cjs --execution-arg=--execute",
	);
}
if (options.prod) targetProdDb();
runMain(async () => {
	try {
		const candidates = await listHiddenValueBothSourcesCandidateAppIds();
		const appIds =
			options.app === undefined
				? candidates
				: candidates.filter((appId) => appId === options.app);
		if (options.app !== undefined && appIds.length === 0) {
			throw new Error("No app matched --app.");
		}
		const report = await runHiddenValueBothSourcesRepair(appIds, {
			dryRun: !options.execute,
		});
		console.log(JSON.stringify({ dryRun: !options.execute, ...report }));
		if (
			options.execute ? report.blockedApps.length > 0 : report.repairedApps > 0
		) {
			process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
