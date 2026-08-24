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
import {
	buildUrl,
	isRetiredAuthoringPath,
	recoverLocation,
	serializePath,
} from "@/lib/routing/location";
import {
	formerParentRecovery,
	type PreviousLocationTopology,
} from "@/lib/routing/topologyRecovery";
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
		/* Direct cutover: retired authoring tokens are not aliases and must not be
		 * rewritten into the new vocabulary. Their parsed location is home, but
		 * the old bookmark remains visibly unresolved instead of pretending it
		 * was a current route. */
		if (isRetiredAuthoringPath(segments)) return;

		/* Strategy 1: check if the parsed location has stale references that
		 * recoverLocation can strip. */
		const recovered = recoverLocation(loc, { modules, forms, fields });
		const formerParent = formerParentRecovery(
			segments,
			previousTopology.current,
			modules,
		);
		const target = formerParent ?? (recovered === loc ? loc : recovered);
		previousTopology.current = { location: target, modules };

		/* Strategy 2: check if the URL path matches the canonical path for
		 * the (possibly recovered) location. With path-based parsing, the
		 * parser degrades unresolvable UUIDs at parse time, so the parsed
		 * location may be "home" while the URL still shows old segments. */
		const canonicalSegments = serializePath(target);
		const urlMatchesLocation =
			segments.length === canonicalSegments.length &&
			segments.every((s, i) => s === canonicalSegments[i]);

		if (target === loc && urlMatchesLocation) return;

		const parts = pathname.split("/").filter(Boolean);
		const basePath = `/${parts.slice(0, 2).join("/")}`;
		const url = buildUrl(basePath, target);
		pushBuilderHistory(url, true);
	}, [loc, modules, forms, fields, pathname, segments]);

	return null;
}
