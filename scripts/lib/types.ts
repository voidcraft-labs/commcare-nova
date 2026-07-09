/**
 * Shared type re-exports for diagnostic scripts.
 *
 * Only re-exports types that are imported by MULTIPLE scripts through
 * this module. Single-consumer types import directly from their canonical
 * home — re-exporting them here would drift without a second user to
 * catch the drift.
 */

// ── Event log (read by inspect-logs + inspect-compare) ──────────────

export type { ConversationPayload, Event } from "../../lib/log/types";

// ── Per-run summary doc (read by inspect-app + inspect-logs + inspect-compare) ──

export type { RunSummaryDoc } from "../../lib/db/types";

// ── Blueprint structure (normalized shape) ──────────────────────────
// Scripts read the normalized doc shape assembled from the app-state
// `blueprint_entities` rows. The distinction between `PersistableDoc`
// (stored shape — no `fieldParent`) and `BlueprintDoc` (in-memory shape —
// includes the derived `fieldParent` reverse index) is load-bearing:
//   - `loadApp` (`@/lib/db/apps`) hands back a `PersistableDoc`.
//   - Walkers in `lib/doc/fieldWalk.ts` require `BlueprintDoc`.
// Use `hydratePersistedBlueprint` (`@/lib/doc/fieldParent`) at the boundary.

export type {
	BlueprintDoc,
	Field,
	Form,
	Module,
	PersistableDoc,
	Uuid,
} from "../../lib/domain";
