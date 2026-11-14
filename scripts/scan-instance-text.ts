/**
 * Read-only inventory of saved apps holding text CommCare HQ's build reads as
 * an instance where no spelling keeps it out: a form's name in the app's
 * default language, or a Connect block's name or description
 * (`lib/commcare/xform/sourceTexts.ts::formSourceTexts`, read by
 * `lib/domain/hqInstanceRead.ts::instanceScanRead`, the gate's own rule), or
 * a choice's value, of a question or of a case property's catalog
 * (`lib/domain/selectOptionValue.ts::selectOptionValueProblem`, `instance-read`).
 *
 * Every stored app is loaded through the schema alone, skipping today's gate,
 * so an app the rule now refuses is still read. It prints the id of each app
 * that holds such a text and nothing else of it: no name, no form, never the
 * text. It writes nothing.
 *
 *   npx tsx --conditions=react-server scripts/scan-instance-text.ts [--prod]
 *
 * The condition resolves `server-only`, which the app loader reaches, to its
 * no-op export.
 */
import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { formSourceTexts } from "@/lib/commcare/xform/sourceTexts";
import { loadSchemaAdmittedAppForInspection } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { instanceScanRead } from "@/lib/domain/hqInstanceRead";
import { selectOptionValueProblem } from "@/lib/domain/selectOptionValue";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const options = new Command()
	.description(
		"List the saved apps whose form name (in the app's default language), Connect block name or description, or choice value holds text CommCare HQ's build reads as a data source, such as instance('casedb'). Read-only. Prints app ids alone, never the text. Exits 1 when an app holds such a text, 2 when an app could not be read.",
	)
	.option("--prod", "read production as the operator IAM identity")
	.parse()
	.opts<{ prod?: boolean }>();
if (options.prod) targetProdDb();

/** Whether a choice value is one HQ's build reads as an instance. */
function readAsInstance(value: string): boolean {
	return selectOptionValueProblem(value) === "instance-read";
}

/** Whether some form's plain text, or some choice's value, of the document
 *  holds a text HQ's build reads as an instance. */
function holdsInstanceText(doc: BlueprintDoc): boolean {
	return (
		Object.keys(doc.forms).some((formUuid) =>
			formSourceTexts(doc, formUuid as Uuid).some(
				({ text }) => instanceScanRead(text) !== undefined,
			),
		) ||
		Object.values(doc.fields).some(
			(field) =>
				(field.kind === "single_select" || field.kind === "multi_select") &&
				field.optionsSource.kind === "inline" &&
				field.optionsSource.options.some((option) =>
					readAsInstance(option.value),
				),
		) ||
		(doc.caseTypes ?? []).some((caseType) =>
			caseType.properties.some((property) =>
				(property.options ?? []).some((option) => readAsInstance(option.value)),
			),
		)
	);
}

runMain(async () => {
	try {
		const db = await getAppDb();
		const apps = await db
			.selectFrom("apps")
			.select("id")
			.orderBy("id")
			.execute();
		let holding = 0;
		let unreadable = 0;
		for (const { id } of apps) {
			try {
				const app = await loadSchemaAdmittedAppForInspection(id);
				if (app === null) throw new Error("App disappeared during scan");
				const doc = { ...app.blueprint, fieldParent: {} } as BlueprintDoc;
				rebuildFieldParent(doc);
				if (holdsInstanceText(doc)) {
					holding++;
					console.log(JSON.stringify({ appId: id }));
				}
			} catch {
				unreadable++;
				console.error(
					JSON.stringify({ appId: id, error: "Could not read the app" }),
				);
			}
		}
		console.log(JSON.stringify({ scanned: apps.length, holding, unreadable }));
		process.exitCode = unreadable ? 2 : holding ? 1 : 0;
	} finally {
		await closeCaseStoreDatabase();
	}
});
