/** Explicit maintenance invocation; defaults to checking the immutable manifest. */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { canonicalJsonDigest } from "../lib/utils/canonicalJson";
import { runMain } from "./lib/main";
import {
	applyProseReferenceRepair,
	checkProseReferenceRepair,
	proseRepairManifestSchema,
} from "./lib/proseReferenceRepair";

const options = new Command()
	.description("Apply only the digest-pinned historical prose repair manifest.")
	.option("--execute", "apply manifest entries")
	.option("--rollback", "compensate unchanged repaired entries")
	.option("--app <id>", "select one manifest app for the canary or rollback")
	.parse()
	.opts<{ execute?: boolean; rollback?: boolean; app?: string }>();
if (options.execute && options.rollback)
	throw new Error("Choose execution or rollback, never both.");
runMain(async () => {
	try {
		const manifest = proseRepairManifestSchema.parse(
			JSON.parse(await readFile("prose-reference-manifest.json", "utf8")),
		);
		const digest = canonicalJsonDigest(manifest);
		if (
			digest !==
			(await readFile("prose-reference-manifest.json.sha256", "utf8")).trim()
		)
			throw new Error("Manifest digest mismatch.");
		const entries = manifest.entries.filter(
			(entry) => !options.app || entry.appId === options.app,
		);
		if (options.app && entries.length !== 1)
			throw new Error("App is not in this manifest.");
		for (const entry of entries) {
			try {
				const result =
					!options.execute && !options.rollback
						? await checkProseReferenceRepair(entry, digest)
						: await applyProseReferenceRepair(
								entry,
								digest,
								options.rollback ? "rollback" : "execute",
							);
				console.log(
					JSON.stringify({
						appId: entry.appId,
						manifestDigest: digest,
						...result,
					}),
				);
			} catch (error) {
				console.error(
					JSON.stringify({
						appId: entry.appId,
						kind: "blocked",
						reason: error instanceof Error ? error.message : String(error),
					}),
				);
				process.exitCode = 1;
			}
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
