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
import { legacyAppBlueprintToDoc as legacyAppBlueprintToDocWithParent } from "@/lib/doc/legacyBridge";
import type { BlueprintDoc, Uuid } from "@/lib/domain";

/**
 * Migration-facing wrapper around the shared `legacyAppBlueprintToDoc`
 * helper. The shared helper populates the transient `fieldParent`
 * reverse-index so runtime consumers (stream dispatcher, SA) can read it
 * immediately. The migration output, however, is the on-disk
 * representation — `fieldParent` is derived on load and MUST NOT be
 * persisted. Strip it here so a single call produces a ready-to-write
 * doc and the resulting fixture in tests matches the persistence
 * contract.
 */
export function legacyAppBlueprintToDoc(
	appId: string,
	legacy: unknown,
): BlueprintDoc {
	const doc = legacyAppBlueprintToDocWithParent(appId, legacy);
	return { ...doc, fieldParent: {} as Record<Uuid, Uuid | null> };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const dryRun = process.argv.includes("--dry-run");
const appIdFilter = process.argv
	.find((a) => a.startsWith("--app-id="))
	?.slice("--app-id=".length);

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
