/**
 * Shared MCP helper — ownership-gate and load one app's blueprint in a
 * single Firestore read.
 *
 * Combines the ownership check + the blueprint load that every MCP
 * tool surface needs. Folding both into one read avoids a redundant
 * full-doc fetch (a separate `loadAppOwner` would re-read the same
 * row). The cost matters because every shared-tool dispatch + every
 * blueprint-touching MCP tool runs through this path.
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
 * Throws `McpAccessError("not_found")` when the app row is absent or
 * `McpAccessError("not_owner")` when the row exists but is owned by
 * another user; the wire layer collapses both to `not_found` (see
 * `errors.ts`'s IDOR-hardening note) while the audit log preserves
 * the internal distinction.
 */

import { loadApp } from "@/lib/db/apps";
import type { AppDoc } from "@/lib/db/types";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { McpAccessError } from "./ownership";

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
 * Fetch `appId`'s blueprint, verify the caller owns it, and rebuild
 * its `fieldParent` reverse index in-memory. Returns `{ doc, app }`
 * for callers that need either the hydrated blueprint, denormalized
 * `AppDoc` fields, or both.
 *
 * Throws `McpAccessError("not_found")` when the row is absent and
 * `McpAccessError("not_owner")` when it exists but is owned by
 * someone else. Both collapse to `"not_found"` on the wire.
 */
export async function loadAppBlueprint(
	appId: string,
	userId: string,
): Promise<LoadedApp> {
	const loaded = await loadApp(appId);
	if (!loaded) throw new McpAccessError("not_found");
	if (loaded.owner !== userId) throw new McpAccessError("not_owner");
	/* Split the raw blueprint off the `AppDoc` envelope so the return
	 * type can't accidentally leak a stale blueprint through `.app`.
	 * `rebuildFieldParent` assigns into `doc.fieldParent`; spreading
	 * first prevents mutation of the shared object `loadApp` returned. */
	const { blueprint, ...appRest } = loaded;
	const doc: BlueprintDoc = { ...blueprint, fieldParent: {} };
	rebuildFieldParent(doc);
	return { doc, app: appRest };
}
