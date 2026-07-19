/**
 * Reactive view of the unwritten-property derivation
 * (`lib/doc/unwrittenProperties.ts`) — the case properties this app
 * reads while no form in it writes them, pre-rendered for the
 * app-settings "written outside this app" surface.
 *
 * Referential stability rides the domain-side memo (per doc
 * reference, same convention as `useEffectiveCaseTypes`), so
 * `Object.is` sees one stable value per doc state.
 */

"use client";

import {
	type UnwrittenPropertyCard,
	unwrittenPropertyCards,
} from "../unwrittenProperties";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useUnwrittenPropertyCards(): readonly UnwrittenPropertyCard[] {
	return useBlueprintDoc((s) => unwrittenPropertyCards(s));
}
