/**
 * Shared Firestore client for diagnostic scripts.
 *
 * Uses Application Default Credentials (`gcloud auth application-default login`).
 * Import `db` directly — no lazy init needed outside the server runtime.
 *
 * Formatting utilities (tok, truncate, tsToISO, usd) live in ./format.ts.
 */
import "dotenv/config";
import { Firestore } from "@google-cloud/firestore";
import { rebuildFieldParent } from "../../lib/doc/fieldParent";
import type { BlueprintDoc, PersistableDoc } from "../../lib/domain";

export const db = new Firestore({
	projectId: process.env.GOOGLE_CLOUD_PROJECT,
	ignoreUndefinedProperties: true,
	preferRest: true,
});

/**
 * Promote a Firestore-stored `PersistableDoc` to an in-memory `BlueprintDoc`
 * by building the derived `fieldParent` reverse index. The domain walkers in
 * `lib/doc/fieldWalk.ts` require `BlueprintDoc`; this is the script-side
 * equivalent of what the app's hydration path does on load.
 *
 * Accepts `unknown` because Firestore script reads don't go through a
 * schema converter (scripts touch `db.collection(...).doc(...).get()`
 * directly for simplicity). The caller has already verified the doc
 * exists; this helper assumes the blob matches the persisted shape and
 * the domain walkers validate structurally at use.
 */
export function hydrateBlueprint(persisted: unknown): BlueprintDoc {
	const doc = persisted as PersistableDoc & {
		fieldParent?: BlueprintDoc["fieldParent"];
	};
	doc.fieldParent = {};
	rebuildFieldParent(doc as BlueprintDoc);
	return doc as BlueprintDoc;
}
