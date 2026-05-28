/**
 * Read-only scan for the legacy preload auto-default.
 *
 * Before case-preload became structural at the wire layer, the agent
 * (`lib/agent/contentProcessing.ts::applyDefaults`) stamped
 * `default_value = "#case/{id}"` onto every primary case property of a
 * case-loading form so the local preview/CCZ would show the loaded value.
 * That autoset is gone — `xform/caseBlocks.ts::addCaseBlocks` now lowers the
 * derived `case_preload` action into `casedb` `<setvalue>` reads directly.
 *
 * Existing stored apps may still carry that `default_value` on disk. It's
 * harmless: the XForm emitter lowers it to a setvalue with the same ref +
 * value the structural preload now also emits, and JavaRosa tolerates the
 * duplicate (both fire at `xforms-ready`, both write the identical value).
 * But it's redundant on-disk state. This scan reports how many such fields
 * each app carries so the operator can decide whether a follow-up cleanup
 * migration is worth running.
 *
 * READ-ONLY by construction — there is no write path here. A cleanup, if
 * the operator wants one after reading the counts, is a separate `--apply`
 * script.
 *
 * Usage:
 *   npx tsx scripts/scan-preload-autoset.ts                 # scan all complete apps
 *   npx tsx scripts/scan-preload-autoset.ts --app-id=abc123 # scan one app
 *   npx tsx scripts/scan-preload-autoset.ts --help
 */

import "dotenv/config";
import { CASE_LOADING_FORM_TYPES, type Field, type Uuid } from "@/lib/domain";
import { db, hydrateBlueprint } from "./lib/firestore";

const HELP_TEXT = [
	"scan-preload-autoset — report fields carrying the legacy preload auto-default.",
	"",
	"Counts, per app, the case-loading-form primary fields whose stored",
	'`default_value` equals "#case/{field.id}" — the signature the removed',
	"`applyDefaults` autoset wrote. Read-only; no Firestore writes.",
	"",
	"Usage:",
	"  npx tsx scripts/scan-preload-autoset.ts",
	"  npx tsx scripts/scan-preload-autoset.ts --app-id=<id>",
	"  npx tsx scripts/scan-preload-autoset.ts --help",
].join("\n");

/** Loose view of an input field's optional string slots. */
type FieldSlots = {
	id: string;
	kind: string;
	default_value?: string;
	calculate?: string;
	case_property_on?: string;
};

/**
 * Does this field carry the removed autoset's exact signature? The autoset
 * fired only when `case_property_on === moduleCaseType`, the id wasn't
 * `case_name`, the field had no `calculate`, and `default_value` was unset
 * (it then wrote `#case/{id}`). Reproducing every condition — including the
 * `!calculate` guard — keeps the scan from over-reporting a hand-authored
 * `#case/{id}` default on a calculated field, which the autoset never wrote.
 */
function isLegacyAutoset(
	field: Field,
	moduleCaseType: string | undefined,
): boolean {
	const f = field as unknown as FieldSlots;
	return (
		f.id !== "case_name" &&
		!!moduleCaseType &&
		f.case_property_on === moduleCaseType &&
		!f.calculate &&
		f.default_value === `#case/${f.id}`
	);
}

interface AppScan {
	appId: string;
	appName: string;
	autosetFields: string[]; // "moduleId/formId/fieldId"
}

/** Walk one app's blueprint and collect every legacy-autoset field. */
function scanApp(appId: string, appName: string, blueprint: unknown): AppScan {
	const doc = hydrateBlueprint(blueprint);
	const hits: string[] = [];

	const walk = (
		parentUuid: Uuid,
		caseType: string | undefined,
		label: string,
	) => {
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[fieldUuid];
			if (!field) continue;
			if (isLegacyAutoset(field, caseType)) hits.push(`${label}/${field.id}`);
			// Recurse into containers (a present fieldOrder entry marks one).
			if (doc.fieldOrder[fieldUuid] !== undefined) {
				walk(fieldUuid, caseType, label);
			}
		}
	};

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (!CASE_LOADING_FORM_TYPES.has(form.type)) continue;
			walk(formUuid, mod.caseType, `${mod.id}/${form.id}`);
		}
	}

	return { appId, appName, autosetFields: hits };
}

interface AppDocSnapshot {
	id: string;
	data(): { app_name?: string; blueprint?: unknown } | undefined;
}

async function run(appId: string | undefined): Promise<void> {
	const docs: AppDocSnapshot[] = [];
	if (appId !== undefined) {
		const snap = (await db
			.collection("apps")
			.doc(appId)
			.get()) as unknown as AppDocSnapshot & { exists: boolean };
		if (snap.exists) docs.push(snap);
	} else {
		const result = (await db
			.collection("apps")
			.where("deleted_at", "==", null)
			.where("status", "==", "complete")
			.get()) as unknown as { docs: AppDocSnapshot[] };
		docs.push(...result.docs);
	}

	let scanned = 0;
	let appsWithAutoset = 0;
	let totalFields = 0;

	for (const snap of docs) {
		const data = snap.data();
		if (!data?.blueprint) continue;
		scanned += 1;
		const result = scanApp(
			snap.id,
			data.app_name ?? "(unnamed)",
			data.blueprint,
		);
		if (result.autosetFields.length === 0) continue;
		appsWithAutoset += 1;
		totalFields += result.autosetFields.length;
		console.log(
			`${result.appId}  "${result.appName}"  ${result.autosetFields.length} field(s):`,
		);
		for (const f of result.autosetFields) console.log(`    ${f}`);
	}

	console.log("");
	console.log(
		`scanned=${scanned} apps_with_autoset=${appsWithAutoset} total_autoset_fields=${totalFields}`,
	);
	console.log(
		totalFields === 0
			? "No stored apps carry the legacy preload auto-default. Nothing to clean up."
			: "These default_value entries are redundant (preload is now structural) but harmless. A cleanup migration is optional.",
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP_TEXT);
		process.exit(0);
	}
	const appIdArg = args.find((a) => a.startsWith("--app-id="));
	const appId = appIdArg ? appIdArg.slice("--app-id=".length) : undefined;
	run(appId).catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
