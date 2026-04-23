/**
 * Shared MCP helper — load one app's blueprint and hydrate its derived
 * `fieldParent` reverse index, returning both the in-memory blueprint
 * and the `AppDoc` denormalized columns in one record.
 *
 * Firestore persists the `PersistableDoc` shape (see `toPersistableDoc`)
 * without `fieldParent` — the index is derived from `fieldOrder` at
 * every load so the disk doc has one canonical source of truth for
 * parent-child relationships. Every MCP surface that reads a blueprint
 * needs the fully-hydrated `BlueprintDoc`, so the rebuild lives here
 * rather than inlined at each call site.
 *
 * Returning `{ doc, app }` (rather than just the blueprint) lets
 * callers that also need denormalized `AppDoc` columns — e.g.
 * `compile_app` consumes `app.app_name` for the ccz profile manifest —
 * share a single Firestore read. Callers that only need the blueprint
 * destructure `.doc` and ignore the rest.
 *
 * `LoadedApp.app` is narrowed to `Omit<AppDoc, "blueprint">` so a
 * caller that reaches for `.app.blueprint` gets a type error rather
 * than a silently-stale blueprint missing the rebuilt `fieldParent`
 * index. The blueprint lives in one place on this result — on `.doc`.
 *
 * Three MCP surfaces use this: the shared tool adapter before
 * dispatching to a mutating or read tool (destructures `.doc`), the
 * `get_app` tool when rendering a summary (destructures `.doc`), and
 * `compile_app` when emitting HQ format (uses both).
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
import type { AppDoc } from "@/lib/db/types";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";

/**
 * Result of a successful `loadAppBlueprint` call. The `fieldParent`-
 * hydrated blueprint lives exclusively on `.doc`; `.app` carries the
 * denormalized columns (`app_name`, `status`, timestamps) with the raw
 * `blueprint` field stripped so a caller reaching for
 * `.app.blueprint` sees a compile error rather than a stale copy
 * missing the rebuilt reverse index.
 */
export interface LoadedApp {
	/** In-memory blueprint shape with `fieldParent` rebuilt from `fieldOrder`. */
	doc: BlueprintDoc;
	/**
	 * `AppDoc` denormalized columns without the raw `blueprint` — the
	 * blueprint lives on `.doc` and consumers that want it go there.
	 */
	app: Omit<AppDoc, "blueprint">;
}

/**
 * Fetch `appId`'s blueprint and rebuild its `fieldParent` reverse
 * index in-memory. Returns `{ doc, app }` for callers that need
 * either the hydrated blueprint, denormalized `AppDoc` fields, or
 * both. Resolves to `null` if the app row is missing.
 */
export async function loadAppBlueprint(
	appId: string,
): Promise<LoadedApp | null> {
	const loaded = await loadApp(appId);
	if (!loaded) return null;
	/* Split the raw blueprint off the `AppDoc` envelope so the return
	 * type can't accidentally leak a stale blueprint through `.app`.
	 * `rebuildFieldParent` assigns into `doc.fieldParent`; spreading
	 * first prevents mutation of the shared object `loadApp` returned. */
	const { blueprint, ...appRest } = loaded;
	const doc: BlueprintDoc = { ...blueprint, fieldParent: {} };
	rebuildFieldParent(doc);
	return { doc, app: appRest };
}
