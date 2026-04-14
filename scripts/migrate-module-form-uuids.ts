/**
 * Stamp stable uuids on every module + form in every Firestore app document.
 *
 * Background: prior to the "stable module + form uuids" change, BlueprintModule
 * and BlueprintForm did not persist uuids. The blueprint→doc converter
 * (`lib/doc/converter.ts::toDoc`) minted fresh uuids on every load, so the URL
 * router (which keys on doc-level uuids) could never produce a stable bookmark
 * — clicking a module after a server reload would bounce the user back to home
 * because the URL referenced a uuid that no longer existed in the freshly
 * generated doc.
 *
 * The schema fix makes uuid a required field on both schemas; this script is
 * the one-shot migration for legacy Firestore documents that pre-date the
 * change. After it has run, every app's blueprint conforms to the strict
 * schema and the converter never mints — uuids round-trip through Firestore.
 *
 * Eligibility:
 *   Any app document whose `blueprint.modules` is a non-empty array. We do not
 *   filter on `status` — even `error`/`generating` apps may unstick later, so
 *   the migration applies broadly. Apps with empty `modules` have nothing to
 *   stamp and are skipped silently.
 *
 * Idempotency:
 *   Walks every module + form. Mints `crypto.randomUUID()` only for the ones
 *   missing a `uuid`. If every module + form already has a uuid, the document
 *   is left untouched (no Firestore write, no `updated_at` bump).
 *
 * Usage:
 *   npx tsx scripts/migrate-module-form-uuids.ts            # dry run (read-only)
 *   npx tsx scripts/migrate-module-form-uuids.ts --confirm  # actually writes
 *
 * Excluded from Docker builds via `.dockerignore` (alongside the rest of the
 * scripts/ tooling).
 */
import { randomUUID } from "node:crypto";
import { db } from "./lib/firestore";

interface MigrationModule {
	uuid?: string;
	name?: string;
	forms?: MigrationForm[];
}

interface MigrationForm {
	uuid?: string;
	name?: string;
}

interface MigrationStats {
	scanned: number;
	migrated: number;
	skipped: number;
	moduleUuidsMinted: number;
	formUuidsMinted: number;
}

const confirmed = process.argv.includes("--confirm");

/**
 * Walk a blueprint's modules + forms and stamp uuids where missing.
 *
 * Mutates `modules` in place and returns counts. Returns `{ moduleUuids,
 * formUuids } = { 0, 0 }` when the blueprint already has full uuid
 * coverage — callers use this to decide whether a Firestore write is
 * needed at all (idempotency).
 */
function stampUuids(modules: MigrationModule[]): {
	moduleUuids: number;
	formUuids: number;
} {
	let moduleUuids = 0;
	let formUuids = 0;

	for (const mod of modules) {
		if (!mod.uuid) {
			mod.uuid = randomUUID();
			moduleUuids += 1;
		}
		const forms = mod.forms ?? [];
		for (const form of forms) {
			if (!form.uuid) {
				form.uuid = randomUUID();
				formUuids += 1;
			}
		}
	}

	return { moduleUuids, formUuids };
}

async function main() {
	const stats: MigrationStats = {
		scanned: 0,
		migrated: 0,
		skipped: 0,
		moduleUuidsMinted: 0,
		formUuidsMinted: 0,
	};

	const header = confirmed
		? "MIGRATION TOOL — module + form uuid backfill (writes to production)"
		: "MIGRATION TOOL — module + form uuid backfill (dry run, read-only)";
	console.log(`${header}\n`);

	/* `listDocuments()` returns refs even for documents Firestore considers
	 * "missing" (e.g. those that exist only as parents of a subcollection).
	 * `.get()` on each ref tolerates that case via `snap.exists`. */
	const refs = await db.collection("apps").listDocuments();

	for (const ref of refs) {
		const snap = await ref.get();
		if (!snap.exists) continue;

		stats.scanned += 1;

		const data = snap.data() ?? {};
		const blueprint = data.blueprint as
			| { modules?: MigrationModule[] }
			| undefined;
		const modules = blueprint?.modules;

		/* Empty or missing module list → no migration target. Skip silently
		 * to keep the output focused on apps that actually have data. */
		if (!modules || modules.length === 0) {
			continue;
		}

		const { moduleUuids, formUuids } = stampUuids(modules);

		if (moduleUuids === 0 && formUuids === 0) {
			stats.skipped += 1;
			console.log(`app ${ref.id}: already migrated, skipping`);
			continue;
		}

		stats.migrated += 1;
		stats.moduleUuidsMinted += moduleUuids;
		stats.formUuidsMinted += formUuids;

		if (confirmed) {
			console.log(
				`app ${ref.id}: minted ${moduleUuids} module uuids, ${formUuids} form uuids`,
			);
			/* Write only the blueprint subtree we mutated. Merge keeps every
			 * other field (status, owner, updated_at, etc.) untouched; we
			 * deliberately do NOT bump `updated_at` here because the user-
			 * visible blueprint is unchanged — only the stable identity
			 * fields were filled in. */
			await ref.update({ "blueprint.modules": modules });
		} else {
			console.log(
				`app ${ref.id}: would mint ${moduleUuids} module uuids, ${formUuids} form uuids`,
			);
		}
	}

	console.log("");
	console.log("Summary:");
	console.log(`  Apps scanned:           ${stats.scanned}`);
	console.log(`  Apps migrated:          ${stats.migrated}`);
	console.log(`  Apps already migrated:  ${stats.skipped}`);
	console.log(`  Module uuids minted:    ${stats.moduleUuidsMinted}`);
	console.log(`  Form uuids minted:      ${stats.formUuidsMinted}`);

	if (!confirmed) {
		console.log("");
		console.log("This was a DRY RUN. Re-run with --confirm to write.");
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});

/* Exported for tests — the script itself is a thin wrapper that consumes the
 * Firestore client and prints stats. The pure helper is the testable unit. */
export { stampUuids };
