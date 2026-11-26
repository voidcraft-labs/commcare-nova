import "./lib/loadEnv";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import { scanSearchResultsAdoptions } from "./lib/searchResultsAdoption";

const options = new Command()
	.description("Freeze the retained search names of active adopted menus.")
	.requiredOption("--out <path>")
	.option("--prod")
	.parse()
	.opts<{ out: string; prod?: boolean }>();
if (options.prod) targetProdDb();
runMain(async () => {
	try {
		const facts = await scanSearchResultsAdoptions();
		await writeFile(options.out, JSON.stringify(facts), {
			flag: "wx",
			mode: 0o600,
		});
		console.log(
			JSON.stringify({
				targets: facts.targets.length,
				namedMenus: facts.targets.reduce(
					(sum, target) =>
						sum + target.menus.filter((menu) => menu.name !== null).length,
					0,
				),
				digest: canonicalJsonDigest(facts),
			}),
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
