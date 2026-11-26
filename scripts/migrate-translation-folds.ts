/**
 * ONE-OFF: moves back every override an earlier reading folded into the text its output is based
 * on, for each app brought in from CommCare HQ, one transaction per app with the document's reload
 * boundary, and takes the retired id `translation-overrides-folded` off each stored list. An
 * adoption whose baseline does not read whole offline changes nothing and is named. Dry run unless
 * `--execute`; a second run finds nothing. Run at the cutover after `scan-translation-folds.ts`,
 * then remove both (`lib/translationFoldRepair.ts` says what).
 *
 *   npx tsx --conditions=react-server scripts/migrate-translation-folds.ts [--app <id>] [--execute]
 */
import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import {
	adoptedAppIds,
	migrateTranslationFolds,
} from "./lib/translationFoldRepair";

const options = new Command()
	.description(
		"Move back translation overrides an earlier reading folded. Dry-run by default.",
	)
	.option("--app <id>")
	.option("--execute")
	.parse()
	.opts<{ app?: string; execute?: boolean }>();

runMain(async () => {
	try {
		const apps = options.app ? [options.app] : await adoptedAppIds();
		for (const appId of apps) {
			const result = await migrateTranslationFolds(
				appId,
				options.execute === true,
			);
			console.log(
				JSON.stringify({
					appId: result.appId,
					status: result.status,
					adoptions: result.adoptions.map((one) => ({
						standing: one.standing,
						unfolds: one.unfolds,
						edited: one.edited,
						listsRetiredId: one.listsRetiredId,
					})),
				}),
			);
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
