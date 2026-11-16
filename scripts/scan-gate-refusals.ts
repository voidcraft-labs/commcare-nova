/**
 * READ-ONLY: list every saved app the commit gate in this tree would refuse,
 * so a deploy that adds validator rules knows which stored apps those rules
 * strand before it lands (a refused app stops loading: the strict loader
 * throws on it).
 *
 * Each app is read in one REPEATABLE READ, READ ONLY transaction: the
 * persisted Blueprint through the schema alone, skipping today's gate
 * (`scripts/lib/loadPersistedBlueprint.ts::loadPersistedBlueprintReadOnly`,
 * then `lib/doc/fieldParent.ts::hydratePersistedBlueprint`), and the
 * definitions of the Project lookup tables it references
 * (`lib/lookup/definitionSnapshot.ts::readLookupDefinitionsInTransaction`).
 * It then runs `lib/doc/commitVerdicts.ts::mutationCommitVerdict` with an
 * empty batch: the absolute whole-document gate, exactly what the strict
 * loader (`lib/db/canonicalCommitKernel.ts::loadStrictAppSnapshotFromRowInTransaction`)
 * and every commit run, refusing on any shape, soundness or completeness
 * finding.
 *
 * Why the gate and not the export boundary
 * (`lib/export/boundaryValidation.ts`, `evaluateBoundary`): the export runs
 * the same rules and adds only environment-class findings, which are
 * functions of data outside the document (media rows, lookup rows, the
 * export mode and target) and never refuse a saved app. Every app the gate
 * refuses, every export refuses too.
 *
 * Output names app ids and validator codes alone, never a name, label,
 * form, path or any text of an app. A finding's `details.reason` is printed
 * beside its code (`CODE:reason`) only where it is a closed kebab-case token;
 * some rules put a sentence naming app content there, so any other reason
 * prints as `CODE:*`.
 *
 *   npx tsx --conditions=react-server scripts/scan-gate-refusals.ts [--prod] [--json]
 *
 * The condition resolves `server-only`, which the gate's imports reach, to
 * its no-op export. Exit 0 when no app has a finding, 1 when one does, 2 when
 * an app could not be read, 3 on a fatal error before the scan finished.
 */

import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import { getAppDb } from "@/lib/db/pg";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceTargets,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { loadPersistedBlueprintReadOnly } from "./lib/loadPersistedBlueprint";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	prod?: boolean;
	json?: boolean;
}

const program = new Command();
program
	.name("scan-gate-refusals")
	.description(
		"Print the id of every saved app the commit gate in this tree would refuse, with the validator codes it finds (read-only; never any app content).",
	)
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.option("--json", "print one machine-readable JSON object instead of lines")
	.addHelpText(
		"after",
		"\nOutput: one line per refused app, `<appId> CODE=<n> CODE:reason=<n> ...`, then a summary.\n" +
			"A reason that is not a closed token is withheld and printed as `CODE:*`.\n" +
			"Exit 0 when no app has a finding, 1 when one does, 2 when an app could not be read, 3 on a fatal error.\n" +
			"\nExamples:\n" +
			"  $ npx tsx --conditions=react-server scripts/scan-gate-refusals.ts\n" +
			"  $ npx tsx --conditions=react-server scripts/scan-gate-refusals.ts --prod\n" +
			"  $ npx tsx --conditions=react-server scripts/scan-gate-refusals.ts --prod --json\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

/** A reason printed beside its code: a closed kebab-case token, never text. */
const REASON_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REASON_TOKEN_MAX = 64;

/** The key a finding is counted under: its code, with its reason where the
 *  finding carries one. */
function findingKey(finding: ValidationError): string {
	const reason = finding.details?.reason;
	if (reason === undefined) return finding.code;
	return reason.length <= REASON_TOKEN_MAX && REASON_TOKEN.test(reason)
		? `${finding.code}:${reason}`
		: `${finding.code}:*`;
}

type Verdict =
	| { readonly kind: "gone" }
	| { readonly kind: "read"; readonly findings: readonly ValidationError[] };

/** One app's gate verdict over one read-only snapshot. */
async function gateVerdict(appId: string): Promise<Verdict> {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx): Promise<Verdict> => {
			const row = await tx
				.selectFrom("apps")
				.select("project_id")
				.where("id", "=", appId)
				.executeTakeFirst();
			if (row === undefined) return { kind: "gone" };
			const persisted = await loadPersistedBlueprintReadOnly(tx, appId);
			if (persisted === null) return { kind: "gone" };
			const doc = hydratePersistedBlueprint(persisted);
			const definitions = await readLookupDefinitionsInTransaction(
				tx,
				row.project_id,
				extractLookupReferenceTargets(doc).tableIds,
			);
			const lookupContext: LookupValidationContext = {
				kind: "available",
				...definitions,
			};
			const verdict = mutationCommitVerdict(doc, [], lookupContext);
			return { kind: "read", findings: verdict.ok ? [] : verdict.findings };
		});
}

/** Sorted `[key, count]` pairs for one app's findings. */
function countFindings(
	findings: readonly ValidationError[],
): [string, number][] {
	const counts = new Map<string, number>();
	for (const finding of findings) {
		const key = findingKey(finding);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function sortedRecord(counts: Map<string, number>): Record<string, number> {
	return Object.fromEntries(
		[...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

async function main(): Promise<void> {
	const db = await getAppDb();
	const rows = await db.selectFrom("apps").select("id").orderBy("id").execute();

	const refused: { id: string; codes: [string, number][] }[] = [];
	const unreadable: string[] = [];
	for (const { id } of rows) {
		let verdict: Verdict;
		try {
			verdict = await gateVerdict(id);
		} catch {
			unreadable.push(id);
			if (options.json !== true) console.error(`unreadable ${id}`);
			continue;
		}
		if (verdict.kind === "gone") {
			unreadable.push(id);
			if (options.json !== true) console.error(`unreadable ${id} (gone)`);
			continue;
		}
		if (verdict.findings.length === 0) continue;
		const codes = countFindings(verdict.findings);
		refused.push({ id, codes });
		if (options.json !== true) {
			console.log(
				`${id} ${codes.map(([key, count]) => `${key}=${count}`).join(" ")}`,
			);
		}
	}

	/* Apps per bare code, and per counted key (code with its reason). */
	const appsByCode = new Map<string, number>();
	const appsByKey = new Map<string, number>();
	for (const { codes } of refused) {
		const bare = new Set(codes.map(([key]) => key.split(":")[0] ?? key));
		for (const code of bare)
			appsByCode.set(code, (appsByCode.get(code) ?? 0) + 1);
		for (const [key] of codes)
			appsByKey.set(key, (appsByKey.get(key) ?? 0) + 1);
	}
	const appsRead = rows.length - unreadable.length;

	if (options.json === true) {
		console.log(
			JSON.stringify({
				apps: refused.map(({ id, codes }) => ({
					id,
					codes: Object.fromEntries(codes),
				})),
				unreadable,
				totals: {
					scanned: rows.length,
					appsRead,
					appsWithFindings: refused.length,
					unreadable: unreadable.length,
					appsByCode: sortedRecord(appsByCode),
					appsByKey: sortedRecord(appsByKey),
				},
			}),
		);
	} else {
		console.log("");
		console.log(
			`scanned ${rows.length} apps · read ${appsRead} · ${refused.length} refused by the gate · ${unreadable.length} unreadable`,
		);
		if (unreadable.length > 0) {
			console.log(`unreadable: ${unreadable.join(" ")}`);
		}
		if (appsByCode.size > 0) {
			console.log("apps per code:");
			const width = Math.max(...[...appsByCode.keys()].map((c) => c.length));
			for (const [code, count] of Object.entries(sortedRecord(appsByCode))) {
				console.log(`  ${code.padEnd(width)}  ${count}`);
			}
		}
	}
	process.exitCode = unreadable.length > 0 ? 2 : refused.length > 0 ? 1 : 0;
}

/* Not `runMain`: its fatal exit 1 would read as "an app has a finding". */
void (async () => {
	try {
		await main();
	} catch (error) {
		console.error("Fatal:", error);
		process.exitCode = 3;
	} finally {
		await closeCaseStoreDatabase();
	}
})();
