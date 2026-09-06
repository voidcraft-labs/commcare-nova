/**
 * Client-side effect that scrubs stale URL paths whenever a referenced
 * entity disappears from the doc. Mounted inside BuilderProvider so it
 * has access to the doc store (via BlueprintDocContext).
 *
 * Three recovery strategies work in tandem:
 *
 * 1. **Stale-reference recovery**: `recoverLocation` walks the current
 *    parsed location and strips any UUID that no longer exists in the doc.
 *
 * 2. **URL-mismatch recovery**: With path-based URLs, the parser itself
 *    degrades unresolvable UUIDs to simpler locations at parse time
 *    (e.g. a deleted form UUID → home). This means the parsed location
 *    is already "recovered," but the browser URL still shows the old
 *    path. The effect detects this mismatch by comparing the canonical
 *    URL for the parsed location against the current path segments.
 *
 * 3. **Former-parent recovery**: The previous valid topology remembers the
 *    parent of an open submenu, so a remote deletion can retain the nearest
 *    surviving menu instead of always falling all the way back to Home.
 *
 * Returns `null`: exists purely for its side effect.
 */
"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useDocEntityMaps } from "@/lib/doc/hooks/useDocEntityMaps";
import { useLocation } from "@/lib/routing/hooks";
import { buildUrl } from "@/lib/routing/location";
import { advanceLocationRecovery } from "@/lib/routing/locationRecovery";
import type { PreviousLocationTopology } from "@/lib/routing/topologyRecovery";
import {
	pushBuilderHistory,
	useBuilderPathSegments,
} from "@/lib/routing/useClientPath";

export function LocationRecoveryEffect() {
	const loc = useLocation();
	const pathname = usePathname();
	const segments = useBuilderPathSegments();
	const previousTopology = useRef<PreviousLocationTopology | undefined>(
		undefined,
	);

	/* Subscribe to entity maps directly so the effect re-fires whenever a
	 * referenced uuid might have disappeared. `useDocEntityMaps` returns a
	 * shallow-stable `{modules, forms, fields}` object: each slice is an
	 * Immer-stable reference, so the hook only re-renders when one of the
	 * three maps actually changes identity. */
	const { modules, forms, fields } = useDocEntityMaps();

	useEffect(() => {
		const recovery = advanceLocationRecovery(
			previousTopology.current,
			segments,
			loc,
			{ modules, forms, fields },
		);
		previousTopology.current = recovery.topology;
		if (recovery.replacement === undefined) return;

		const parts = pathname.split("/").filter(Boolean);
		const basePath = `/${parts.slice(0, 2).join("/")}`;
		const url = buildUrl(basePath, recovery.replacement);
		pushBuilderHistory(url, true);
	}, [loc, modules, forms, fields, pathname, segments]);

	return null;
}
