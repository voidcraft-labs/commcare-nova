/**
 * READ-ONLY: list every saved app holding a module whose case list
 * registration (`Module.caseListRegistrationForm`) names a form that also
 * creates a case of that module's case type at its root, as a basic subcase
 * (`basicCaseSlots.ts::rootBasicSubcaseCreates`). CommCare HQ counts that as a
 * second registration of the type and its build refuses the app, and the
 * validator's `CASE_LIST_REGISTRATION_NOT_REGISTRATION` reason
 * `several-registrations` refuses the shape.
 *
 * Output names app ids alone, one per line, never a label, a form or a value.
 * Exit 0 when no app holds the shape, 1 when one does, 2 when an app could
 * not be read.
 */

import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { rootBasicSubcaseCreates } from "@/lib/domain/basicCaseSlots";
import { loadPersistedBlueprintReadOnly } from "./lib/loadPersistedBlueprint";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-case-list-registration-registrations")
	.description(
		"Print the id of every saved app with a case list registration form that also creates a case of its menu's case type at its root (read-only).",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-case-list-registration-registrations.ts\n" +
			"  $ npx tsx scripts/scan-case-list-registration-registrations.ts --app <appId>\n" +
			"  $ npx tsx scripts/scan-case-list-registration-registrations.ts --prod\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

/** Whether some module's case list registration form creates a second case
 *  of the module's own case type at its root. */
function holdsSecondRegistration(doc: BlueprintDoc): boolean {
	return Object.values(doc.modules).some((mod) => {
		const formUuid = mod.caseListRegistrationForm?.formUuid;
		const caseType = mod.caseType;
		if (
			formUuid === undefined ||
			caseType === undefined ||
			doc.forms[formUuid] === undefined
		)
			return false;
		return rootBasicSubcaseCreates(doc, formUuid).some(
			(create) => create.caseType === caseType,
		);
	});
}

async function main(): Promise<void> {
	const db = await getAppDb();
	let query = db.selectFrom("apps").select("id");
	if (options.app !== undefined) query = query.where("id", "=", options.app);
	const rows = await query.orderBy("id").execute();
	if (options.app !== undefined && rows.length === 0) {
		throw new Error("No app matched --app.");
	}

	let found = 0;
	let unreadable = 0;
	for (const { id } of rows) {
		let holds: boolean;
		try {
			const blueprint = await db
				.transaction()
				.setIsolationLevel("repeatable read")
				.setAccessMode("read only")
				.execute((tx) => loadPersistedBlueprintReadOnly(tx, id));
			if (blueprint === null) {
				unreadable += 1;
				console.error(`unreadable ${id}`);
				continue;
			}
			holds = holdsSecondRegistration(hydratePersistedBlueprint(blueprint));
		} catch {
			unreadable += 1;
			console.error(`unreadable ${id}`);
			continue;
		}
		if (holds) {
			found += 1;
			console.log(id);
		}
	}
	console.error(
		`scanned ${rows.length} apps · ${found} hold the shape · ${unreadable} unreadable`,
	);
	process.exitCode = unreadable > 0 ? 2 : found > 0 ? 1 : 0;
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
