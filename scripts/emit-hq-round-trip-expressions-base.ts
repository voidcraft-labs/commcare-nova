import "./lib/loadEnv";

/**
 * READ-ONLY: the expression cutover's base emission census. Run from PR2's
 * head, while the production emitters still have their pre-step behavior:
 *
 *   npx tsx --conditions=react-server scripts/emit-hq-round-trip-expressions-base.ts --prod
 *
 * One fleet snapshot supplies every sequence, document and lookup definition.
 * Only live apps are emitted; the fleet digest includes soft-deleted apps too.
 * No authored text, media bytes or lookup rows leave this process. Both census
 * halves use emissionNormal's frozen fragment keys and synthetic options.
 */

import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import {
	CENSUS_ATTACHMENT_TARGET,
	CENSUS_COMPILE_OPTIONS,
	CENSUS_RUNTIME_TARGET,
	type EmissionFragment,
	normalizeEmittedApp,
} from "./lib/hqRoundTripExpressions/emissionNormal";
import { loadPersistedBlueprintReadOnly } from "./lib/loadPersistedBlueprint";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface BaseEmissionLine extends EmissionFragment {
	readonly app: string;
}

interface BaseCensus {
	readonly files: readonly BaseEmissionLine[];
	readonly fleetSeqDigest: string;
}

interface FailurePlace {
	readonly stage:
		| "configure"
		| "read-fleet"
		| "read-app"
		| "read-lookup-definitions"
		| "emit-app"
		| "normalize-emission"
		| "finish-snapshot"
		| "close-database";
	readonly app?: string;
}

/** Keep only the two local-archive carriers the census measures. Embedded
 * fixture blocks are removed by the frozen normalizer, after compilation has
 * checked that every declared fixture exists. ZIP metadata is never hashed. */
function localExpressionFiles(archive: Buffer): ReadonlyMap<string, string> {
	const files = new Map<string, string>();
	for (const entry of new AdmZip(archive).getEntries()) {
		if (
			entry.entryName === "suite.xml" ||
			/^modules-\d+\/forms-\d+\.xml$/.test(entry.entryName)
		) {
			files.set(entry.entryName, entry.getData().toString("utf8"));
		}
	}
	return files;
}

async function census(
	place: (next: FailurePlace) => void,
): Promise<BaseCensus> {
	place({ stage: "read-fleet" });
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const apps = await tx
				.selectFrom("apps")
				.select(["id", "project_id", "mutation_seq", "deleted_at"])
				.orderBy("id")
				.execute();
			// Explicit lexical order keeps this framing independent of database
			// collation. Sequences use the exact persisted protocol's admission.
			apps.sort((left, right) =>
				left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
			);
			const sequences = apps.map((app) => [
				app.id,
				safePersistedSequence(app.mutation_seq),
			]);
			const fleetSeqDigest = createHash("sha256")
				.update(JSON.stringify(sequences))
				.digest("hex");
			const files: BaseEmissionLine[] = [];
			for (const app of apps) {
				if (app.deleted_at !== null) continue;
				place({ stage: "read-app", app: app.id });
				const stored = await loadPersistedBlueprintReadOnly(tx, app.id);
				if (stored === null) {
					throw new Error("An app in the fleet snapshot has no document.");
				}
				const doc = hydratePersistedBlueprint(stored);
				place({ stage: "read-lookup-definitions", app: app.id });
				const { tableIds } = extractLookupReferenceTargets(doc);
				const lookup = await readLookupDefinitionsInTransaction(
					tx,
					app.project_id,
					tableIds,
				);
				const naming = lookupWireNaming(lookup.definitions);
				place({ stage: "emit-app", app: app.id });
				// HQ builds its own runtime destinations. The local archive needs
				// one fixed target; both paths exercise URL-backed capture writes.
				const options = {
					lookupNaming: naming,
					attachmentTarget: CENSUS_ATTACHMENT_TARGET,
				};
				const hqApp = expandDoc(doc, options);
				const localApp = expandDoc(doc, {
					...options,
					runtimeTarget: CENSUS_RUNTIME_TARGET,
				});
				const archive = compileCcz(localApp, doc.appName, doc, {
					...CENSUS_COMPILE_OPTIONS,
					lookup: {
						naming,
						fixtures: buildLookupFixtures(
							naming,
							new Map(naming.tables.map((table) => [table.tableId, []])),
						),
					},
				});
				place({ stage: "normalize-emission", app: app.id });
				for (const fragment of normalizeEmittedApp(
					hqApp,
					localExpressionFiles(archive),
				)) {
					files.push({
						app: app.id,
						file: fragment.file,
						rawDigest: fragment.rawDigest,
						digest: fragment.digest,
					});
				}
			}
			place({ stage: "finish-snapshot" });
			return { files, fleetSeqDigest };
		});
}

runMain(async () => {
	let place: FailurePlace = { stage: "configure" };
	let failure: FailurePlace | undefined;
	let result: BaseCensus | undefined;
	try {
		const program = new Command()
			.name("emit-hq-round-trip-expressions-base")
			.description(
				"Read the pre-step emission census as content-free JSON Lines. Never writes to the database.",
			)
			.option("--prod", "read production as the read-only operator");
		program.parse();
		process.env.NOVA_DB_WORKLOAD = "operator";
		if (program.opts<{ prod?: boolean }>().prod === true) targetProdDb();
		result = await census((next) => {
			place = next;
		});
	} catch {
		// A parser/compiler/driver error can hold authored text. Keep the
		// failure's operation and app identity, never its message or cause.
		failure = place;
	} finally {
		try {
			await closeCaseStoreDatabase();
		} catch {
			failure ??= { stage: "close-database" };
		}
	}
	if (failure !== undefined) {
		console.error(JSON.stringify({ error: "base-census-failed", ...failure }));
		process.exitCode = 1;
		return;
	}
	// Do not leave a partial successful-looking artifact if any app, the
	// snapshot transaction, or connection teardown failed.
	if (result !== undefined) {
		for (const line of result.files) console.log(JSON.stringify(line));
		console.log(
			JSON.stringify({ kind: "fleet", fleetSeqDigest: result.fleetSeqDigest }),
		);
	}
});
