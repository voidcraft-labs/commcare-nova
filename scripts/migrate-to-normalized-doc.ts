// scripts/migrate-to-normalized-doc.ts
//
// One-time migration: reads every app doc from Firestore, converts the
// legacy nested AppBlueprint shape to the normalized BlueprintDoc shape,
// writes it back. Idempotent — if a doc is already normalized (detected
// by presence of top-level `fields` and `fieldOrder` keys), skip.
//
// The legacy shape stores the full form tree nested inside
// `blueprint.modules[].forms[].questions[]`, with snake_case field names
// and numeric module/form indices in form_links. The normalized shape
// flattens all entities into top-level keyed maps (modules, forms, fields)
// with order arrays (moduleOrder, formOrder, fieldOrder) and UUID refs.
//
// Field name translations applied during migration:
//   close_condition.question  → close_condition.field
//   case_property_on          → case_property
//   form_links target indices → form_links target UUIDs
//
// Usage:
//   npx tsx scripts/migrate-to-normalized-doc.ts [--dry-run] [--app-id=<id>]
//
//   --dry-run    Print what would be migrated without writing to Firestore
//   --app-id=<id> Migrate a single app doc by ID only

import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import {
	asUuid,
	type BlueprintDoc,
	blueprintDocSchema,
	type FormLink,
	type Uuid,
} from "@/lib/domain";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const dryRun = process.argv.includes("--dry-run");
const appIdFilter = process.argv
	.find((a) => a.startsWith("--app-id="))
	?.slice("--app-id=".length);

// ---------------------------------------------------------------------------
// Core migration logic — exported so tests can import it directly without
// spinning up a Firestore connection.
// ---------------------------------------------------------------------------

/**
 * Translates a legacy form_link `target` from index-based addressing to
 * UUID-based addressing, using the order maps built during the migration walk.
 *
 * Legacy targets look like:
 *   { type: "form", moduleIndex: 0, formIndex: 1 }
 *   { type: "module", moduleIndex: 2 }
 *
 * Normalized targets look like:
 *   { type: "form", moduleUuid: "<uuid>", formUuid: "<uuid>" }
 *   { type: "module", moduleUuid: "<uuid>" }
 *
 * Targets of unrecognized types are cast to the module variant as a safe
 * fallback — the subsequent schema validation will surface any bad shape.
 */
function migrateFormLinkTarget(
	legacyTarget: Record<string, unknown>,
	moduleOrder: Uuid[],
	formOrder: Record<Uuid, Uuid[]>,
): FormLink["target"] {
	if (legacyTarget.type === "module") {
		const idx = legacyTarget.moduleIndex as number;
		return { type: "module", moduleUuid: moduleOrder[idx] };
	}
	if (legacyTarget.type === "form") {
		const mIdx = legacyTarget.moduleIndex as number;
		const fIdx = legacyTarget.formIndex as number;
		const moduleUuid = moduleOrder[mIdx];
		const formUuid = formOrder[moduleUuid]?.[fIdx];
		return { type: "form", moduleUuid, formUuid };
	}
	// Unknown target type — treat as a module target; schema validation
	// will surface the bad shape if it doesn't conform.
	return legacyTarget as FormLink["target"];
}

/**
 * Converts a legacy nested AppBlueprint doc (as stored by prior code) into
 * the normalized BlueprintDoc shape. Pure function — no I/O. Throws via
 * `blueprintDocSchema.parse` if the output fails validation.
 *
 * The walk is intentionally forgiving about missing optional fields on
 * legacy questions (hint, required, relevant, etc.) — undefined values are
 * simply omitted from the output object and Zod strips them cleanly.
 *
 * @param appId - The Firestore document ID (used as `appId` in the doc).
 * @param legacy - Raw Firestore document data in the old AppBlueprint shape.
 * @returns A validated BlueprintDoc (including the derived `fieldParent` field
 *          which callers should omit when persisting — only fieldOrder is stored).
 */
export function legacyAppBlueprintToDoc(
	appId: string,
	legacy: unknown,
): BlueprintDoc {
	// Cast to a loose object shape; we validate the output with Zod, so
	// strict typing of the input isn't necessary here.
	const src = legacy as Record<string, unknown>;

	// Accumulators for the normalized entity maps.
	const modules: BlueprintDoc["modules"] = {};
	const forms: BlueprintDoc["forms"] = {};
	const fields: BlueprintDoc["fields"] = {};
	const moduleOrder: Uuid[] = [];
	const formOrder: Record<Uuid, Uuid[]> = {};
	const fieldOrder: Record<Uuid, Uuid[]> = {};

	const legacyModules = (src.modules ?? []) as Record<string, unknown>[];

	// First pass: mint all module + form UUIDs so that form_link target
	// translation (second pass) can look them up by index.
	for (const mod of legacyModules) {
		const moduleUuid = asUuid(
			(mod.uuid as string | undefined) ?? crypto.randomUUID(),
		);
		moduleOrder.push(moduleUuid);
		formOrder[moduleUuid] = [];

		const legacyForms = (mod.forms ?? []) as Record<string, unknown>[];
		for (const form of legacyForms) {
			const formUuid = asUuid(
				(form.uuid as string | undefined) ?? crypto.randomUUID(),
			);
			formOrder[moduleUuid].push(formUuid);
		}
	}

	// Second pass: build the entity maps using the now-complete order maps.
	for (let mIdx = 0; mIdx < legacyModules.length; mIdx++) {
		const mod = legacyModules[mIdx];
		const moduleUuid = moduleOrder[mIdx];

		// Derive a semantic id if not present — snake_case from name.
		const moduleId =
			(mod.id as string | undefined) ??
			(mod.name as string).toLowerCase().replace(/\s+/g, "_");

		modules[moduleUuid] = {
			uuid: moduleUuid,
			id: moduleId,
			name: mod.name as string,
			// Optional fields: only include when defined so Zod doesn't
			// receive explicit `undefined` values (Firestore would reject them).
			...(mod.case_type != null && { caseType: mod.case_type as string }),
			...(mod.case_list_only != null && {
				caseListOnly: mod.case_list_only as boolean,
			}),
			...(mod.purpose != null && { purpose: mod.purpose as string }),
			...(mod.case_list_columns != null && {
				caseListColumns: mod.case_list_columns as Array<{
					field: string;
					header: string;
				}>,
			}),
			...(mod.case_detail_columns != null && {
				caseDetailColumns: mod.case_detail_columns as Array<{
					field: string;
					header: string;
				}>,
			}),
		};

		const legacyForms = (mod.forms ?? []) as Record<string, unknown>[];

		for (let fIdx = 0; fIdx < legacyForms.length; fIdx++) {
			const form = legacyForms[fIdx];
			const formUuid = formOrder[moduleUuid][fIdx];

			const formId =
				(form.id as string | undefined) ??
				(form.name as string).toLowerCase().replace(/\s+/g, "_");

			// Translate close_condition: rename `question` → `field`.
			let closeCondition: BlueprintDoc["forms"][Uuid]["closeCondition"];
			const legacyCc = form.close_condition as
				| Record<string, unknown>
				| undefined;
			if (legacyCc) {
				closeCondition = {
					// The legacy field is `question`; the normalized schema uses `field`.
					field: legacyCc.question as string,
					answer: legacyCc.answer as string,
					...(legacyCc.operator != null && {
						operator: legacyCc.operator as "=" | "selected",
					}),
				};
			}

			// Translate form_links: indices → UUIDs.
			const legacyLinks = form.form_links as
				| Array<Record<string, unknown>>
				| undefined;
			const formLinks: FormLink[] | undefined = legacyLinks?.map((link) => ({
				...(link.condition != null && { condition: link.condition as string }),
				target: migrateFormLinkTarget(
					link.target as Record<string, unknown>,
					moduleOrder,
					formOrder,
				),
				...(link.datums != null && {
					datums: link.datums as FormLink["datums"],
				}),
			}));

			forms[formUuid] = {
				uuid: formUuid,
				id: formId,
				name: form.name as string,
				type: form.type as BlueprintDoc["forms"][Uuid]["type"],
				...(form.purpose != null && { purpose: form.purpose as string }),
				...(closeCondition !== undefined && { closeCondition }),
				...(form.connect != null && {
					connect: form.connect as BlueprintDoc["forms"][Uuid]["connect"],
				}),
				...(form.post_submit != null && {
					postSubmit:
						form.post_submit as BlueprintDoc["forms"][Uuid]["postSubmit"],
				}),
				...(formLinks != null && { formLinks }),
			};

			// Initialize field order for the form's top-level children.
			fieldOrder[formUuid] = [];

			// Recursive walker: visits every question in the form tree and
			// flattens it into the `fields` map, recording parent-child
			// relationships in `fieldOrder`.
			function walk(questions: Record<string, unknown>[], parentUuid: Uuid) {
				for (const q of questions) {
					const fieldUuid = asUuid(
						(q.uuid as string | undefined) ?? crypto.randomUUID(),
					);
					// Record this field under its parent's order list.
					fieldOrder[parentUuid].push(fieldUuid);

					// Build the normalized field object. The `kind` discriminant
					// maps directly from the legacy `type` field. Other properties
					// are translated or conditionally included.
					//
					// Zod will strip keys that don't belong on a given kind — for
					// example, `label` is stripped from hidden fields because the
					// hidden schema omits it. That's the correct behavior.
					const fieldObj: Record<string, unknown> = {
						kind: q.type,
						uuid: fieldUuid,
						id: q.id,
						label: q.label ?? "",
						// case_property_on → case_property (the CommCare boundary
						// renaming that is the whole point of this migration).
						...(q.case_property_on != null && {
							case_property: q.case_property_on,
						}),
						// Input field optional fields — included only if present.
						...(q.hint != null && { hint: q.hint }),
						...(q.required != null && { required: q.required }),
						...(q.relevant != null && { relevant: q.relevant }),
						// Kind-specific fields.
						...(q.validate != null && { validate: q.validate }),
						...(q.validation != null && { validate: q.validation }),
						...(q.validation_msg != null && { validate_msg: q.validation_msg }),
						...(q.calculate != null && { calculate: q.calculate }),
						...(q.default_value != null && { default_value: q.default_value }),
						...(q.options != null && { options: q.options }),
					};

					fields[fieldUuid] = fieldObj as BlueprintDoc["fields"][Uuid];

					// If this field is a container (group or repeat), recurse into
					// its children using this field's UUID as the parent key.
					const children = q.children as Record<string, unknown>[] | undefined;
					if (children?.length && (q.type === "group" || q.type === "repeat")) {
						fieldOrder[fieldUuid] = [];
						walk(children, fieldUuid);
					}
				}
			}

			const legacyQuestions = (form.questions ?? []) as Record<
				string,
				unknown
			>[];
			walk(legacyQuestions, formUuid);
		}
	}

	// Build the raw doc object including the transient fieldParent field
	// (required by the BlueprintDoc type). We populate it as an empty map
	// here — callers that need it should call rebuildFieldParent() on the
	// loaded doc. The field is NOT persisted to Firestore.
	const doc: BlueprintDoc = {
		appId,
		appName: src.app_name as string,
		connectType: (src.connect_type as BlueprintDoc["connectType"]) ?? null,
		caseTypes: (src.case_types as BlueprintDoc["caseTypes"]) ?? null,
		modules,
		forms,
		fields,
		moduleOrder,
		formOrder,
		fieldOrder,
		fieldParent: {} as Record<Uuid, Uuid | null>,
	};

	// Validate the persistable portion against the schema. Throws if the
	// migration produced an invalid shape — no silent skip.
	const { fieldParent: _fp, ...persistable } = doc;
	blueprintDocSchema.parse(persistable);

	return doc;
}

// ---------------------------------------------------------------------------
// Firestore migration runner (not used in unit tests)
// ---------------------------------------------------------------------------

async function main() {
	// Load the service-account credentials from the environment — the same
	// pattern used by every other script in this directory.
	const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
	if (!credPath) {
		throw new Error(
			"GOOGLE_APPLICATION_CREDENTIALS env var is required. Point it at a service-account JSON file.",
		);
	}

	initializeApp({
		credential: cert(JSON.parse(readFileSync(credPath, "utf-8"))),
	});
	const db = getFirestore();

	// Either fetch a single doc (--app-id=<id>) or the whole collection.
	const snapshot = appIdFilter
		? await db.collection("apps").where("__name__", "==", appIdFilter).get()
		: await db.collection("apps").get();

	let migrated = 0;
	let skipped = 0;

	for (const docSnap of snapshot.docs) {
		const data = docSnap.data();

		// Detection: a normalized doc has both `fields` and `fieldOrder` at
		// the top level. A legacy doc nests everything inside `blueprint`.
		if ("fields" in data && "fieldOrder" in data) {
			skipped++;
			console.log(`Skipped (already normalized): ${docSnap.id}`);
			continue;
		}

		// Convert the legacy doc. Throws on schema validation failure — we
		// want the script to stop and surface the bad doc rather than silently
		// skipping it, so the operator can fix the underlying data.
		const doc = legacyAppBlueprintToDoc(docSnap.id, data);
		const { fieldParent: _fp, ...persistable } = doc;

		if (dryRun) {
			console.log(
				`[dry-run] would migrate ${docSnap.id}: ${Object.keys(doc.fields).length} fields across ${Object.keys(doc.forms).length} forms`,
			);
		} else {
			// Full overwrite — the legacy shape and normalized shape are
			// structurally incompatible, so merge: true would leave stale keys.
			await docSnap.ref.set(persistable, { merge: false });
			console.log(
				`Migrated ${docSnap.id}: ${Object.keys(doc.fields).length} fields across ${Object.keys(doc.forms).length} forms`,
			);
		}
		migrated++;
	}

	console.log(
		`\nDone. Migrated: ${migrated}, Skipped (already normalized): ${skipped}.`,
	);
	if (dryRun) {
		console.log("(dry run — no writes performed)");
	}
}

// Guard: only execute when run directly (e.g. `npx tsx scripts/migrate-…`),
// not when imported by vitest or other test runners. Using `import.meta.url`
// vs the resolved path of `process.argv[1]` is the ESM equivalent of Node's
// `if (require.main === module)` pattern.
import { fileURLToPath } from "url";

const isMain =
	process.argv[1] &&
	fileURLToPath(import.meta.url) === fileURLToPath(`file://${process.argv[1]}`);

if (isMain) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
