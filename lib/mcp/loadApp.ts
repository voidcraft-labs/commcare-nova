/**
 * Shared MCP helper — load one app's blueprint and hydrate its derived
 * `fieldParent` reverse index.
 *
 * Firestore persists the `PersistableDoc` shape (see `toPersistableDoc`)
 * without `fieldParent` — the index is derived from `fieldOrder` at
 * every load so the disk doc has one canonical source of truth for
 * parent-child relationships. Every MCP surface that reads a blueprint
 * needs the fully-hydrated `BlueprintDoc`, so the rebuild lives here
 * rather than inlined at each call site.
 *
 * Two MCP surfaces use this: the shared tool adapter before
 * dispatching to a mutating or read tool, and the standalone
 * `get_app` tool when rendering a summary. Extracting the pattern
 * keeps their behavior lockstep — a future renderer change (e.g.
 * lazy-loading `fieldParent` only when a tool needs it) updates
 * both surfaces at one site.
 *
 * Returns `null` when the app row is absent. The null case maps to an
 * `McpAccessError("not_found")` at the caller — preserving that
 * reason coding requires the caller to translate, since this helper
 * stays pure (no MCP-type leakage into the load path).
 *
 * Race: ownership checks (`requireOwnedApp`) and this load are not
 * atomic. A concurrent hard-delete between the two reads lands here
 * as the same null return an "app never existed" probe would see, so
 * the caller can collapse both paths to one consistent `not_found`
 * response.
 */

import { loadApp } from "@/lib/db/apps";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";

/**
 * Fetch `appId`'s blueprint and rebuild its `fieldParent` reverse
 * index in-memory. Returns the full `BlueprintDoc` shape tools
 * consume, or `null` if the app row is missing.
 */
export async function loadAppBlueprint(
	appId: string,
): Promise<BlueprintDoc | null> {
	const app = await loadApp(appId);
	if (!app) return null;
	/* Spread first so the on-disk doc is not mutated — `rebuildFieldParent`
	 * assigns into `doc.fieldParent`, which would otherwise land on the
	 * shared object returned by `loadApp`'s Zod converter. */
	const doc: BlueprintDoc = { ...app.blueprint, fieldParent: {} };
	rebuildFieldParent(doc);
	return doc;
}
