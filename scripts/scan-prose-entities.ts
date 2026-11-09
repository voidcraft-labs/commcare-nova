/** Read-only inventory of prose affected by the former export-only decoder. */
import "./lib/loadEnv";
import { Command } from "commander";
import { decodeXML } from "entities";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { isProseTemplate } from "@/lib/domain";
import { loadPersistedBlueprintSnapshot } from "./lib/loadPersistedBlueprint";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const options = new Command()
	.description(
		"Count saved prose whose text the former XML decoder changed. No authored text is printed.",
	)
	.option("--prod", "read production as the operator IAM identity")
	.parse()
	.opts<{ prod?: boolean }>();
if (options.prod) targetProdDb();

runMain(async () => {
	try {
		const db = await getAppDb();
		const apps = await db
			.selectFrom("apps")
			.select("id")
			.orderBy("id")
			.execute();
		let affected = 0;
		let unreadable = 0;
		for (const { id } of apps) {
			try {
				const snapshot = await loadPersistedBlueprintSnapshot(id);
				if (!snapshot) throw new Error("App disappeared during scan");
				const paths: string[] = [];
				const visit = (value: unknown, path: string): void => {
					if (isProseTemplate(value)) {
						if (
							value.parts.some(
								(part) =>
									part.kind === "text" && decodeXML(part.text) !== part.text,
							)
						)
							paths.push(path);
					} else if (Array.isArray(value)) {
						value.forEach((child, index) => {
							visit(child, `${path}[${index}]`);
						});
					} else if (value !== null && typeof value === "object") {
						for (const [key, child] of Object.entries(value))
							visit(child, `${path}.${key}`);
					}
				};
				visit(snapshot.blueprint, "blueprint");
				if (paths.length) {
					affected++;
					console.log(
						JSON.stringify({
							appId: id,
							mutationSeq: snapshot.mutationSeq,
							paths,
						}),
					);
				}
			} catch {
				unreadable++;
				console.error(
					JSON.stringify({ appId: id, error: "Could not inspect saved prose" }),
				);
			}
		}
		console.log(JSON.stringify({ scanned: apps.length, affected, unreadable }));
		process.exitCode = unreadable ? 2 : affected ? 1 : 0;
	} finally {
		await closeCaseStoreDatabase();
	}
});
