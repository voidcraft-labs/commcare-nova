// components/builder/case-list-config/uuid.ts
//
// Local helper minting a fresh branded `Uuid` for UI-side authoring
// paths (column add, search-input add, kind swap that needs a new
// identity). Routes through `crypto.randomUUID()` and brands the
// result via `asUuid` so call sites stay typed against the branded
// shape rather than reaching for the cast inline.
//
// Mirrors the agent-layer's `newUuid()` at
// `lib/agent/tools/case-list-config/shared.ts` — both authoring
// surfaces (SA tool path + UI workspace) need the same kind of
// helper, but cross-layer imports from `components/builder` into
// `lib/agent/tools` would invert the dependency direction (UI
// depends on tools, not the other way around). One helper per
// authoring surface, both wrapping the same primitive.

import { asUuid, type Uuid } from "@/lib/doc/types";

/**
 * Mint a fresh `Uuid` for a freshly-authored column or search input.
 * Wraps `crypto.randomUUID()` + brands via `asUuid` so call sites
 * receive the branded `Uuid` shape directly.
 */
export function newUuid(): Uuid {
	return asUuid(crypto.randomUUID());
}
