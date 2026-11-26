/**
 * ONE-OFF, read only: lists every app brought in from CommCare HQ whose stored baseline holds an
 * override that an earlier reading folded into the text its output is based on, and says, per
 * adoption, whether the repair moves it back offline exactly, needs data only CommCare HQ can
 * give, finds nothing to unfold (none folded, or a publish since carried the fold to CommCare HQ),
 * or leaves a base an author has edited in Nova since. Prints counts and app ids only. Run at the
 * cutover that ships the reading which holds such an override as the output's own wording, with
 * `migrate-translation-folds.ts`, then remove both (`lib/translationFoldRepair.ts` says what).
 *
 *   npx tsx --conditions=react-server scripts/scan-translation-folds.ts [--app <id>] [--prod]
 *
 * Zero adoptions is its usual answer. Exits 1 where an adoption unfolds or needs CommCare HQ's
 * data, 0 otherwise.
 */
import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import {
	adoptedAppIds,
	type FoldStanding,
	scanTranslationFolds,
} from "./lib/translationFoldRepair";

const options = new Command()
	.description(
		"Scan adoptions for translation overrides an earlier reading folded, without writing.",
	)
	.option("--app <id>")
	.option("--prod", "read production as the operator IAM identity")
	.parse()
	.opts<{ app?: string; prod?: boolean }>();
if (options.prod) targetProdDb();

runMain(async () => {
	try {
		const apps = options.app ? [options.app] : await adoptedAppIds();
		const counts: Record<FoldStanding, number> = {
			unfolds: 0,
			"needs-hq-data": 0,
			"nothing-to-unfold": 0,
			"author-edited": 0,
		};
		let listsRetiredId = 0;
		let adoptions = 0;
		for (const appId of apps)
			for (const one of await scanTranslationFolds(appId)) {
				adoptions += 1;
				counts[one.standing] += 1;
				if (one.listsRetiredId) listsRetiredId += 1;
				console.log(
					JSON.stringify({
						appId: one.appId,
						standing: one.standing,
						unfolds: one.unfolds,
						edited: one.edited,
						listsRetiredId: one.listsRetiredId,
					}),
				);
			}
		console.log(JSON.stringify({ adoptions, ...counts, listsRetiredId }));
		process.exitCode =
			counts.unfolds > 0 || counts["needs-hq-data"] > 0 || listsRetiredId > 0
				? 1
				: 0;
	} finally {
		await closeCaseStoreDatabase();
	}
});
