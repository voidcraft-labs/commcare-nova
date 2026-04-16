/**
 * Client-side effect that scrubs stale URL paths whenever a referenced
 * entity disappears from the doc. Mounted inside BuilderProvider so it
 * has access to the doc store (via BlueprintDocContext).
 *
 * Two recovery strategies work in tandem:
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
 * Returns `null` — exists purely for its side effect.
 */
"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useLocation } from "@/lib/routing/hooks";
import {
	buildUrl,
	recoverLocation,
	serializePath,
} from "@/lib/routing/location";
import {
	notifyPathChange,
	useBuilderPathSegments,
} from "@/lib/routing/useClientPath";

export function LocationRecoveryEffect() {
	const loc = useLocation();
	const pathname = usePathname();
	const segments = useBuilderPathSegments();

	/* Subscribe to entity maps directly so the effect re-fires whenever a
	 * referenced uuid might have disappeared. Each slice is an Immer-stable
	 * reference, so `useBlueprintDoc` with the default `Object.is` equality
	 * only triggers when the specific map's identity changes. */
	const modules = useBlueprintDoc((s) => s.modules);
	const forms = useBlueprintDoc((s) => s.forms);
	const fields = useBlueprintDoc((s) => s.fields);

	useEffect(() => {
		/* Strategy 1: check if the parsed location has stale references that
		 * recoverLocation can strip. */
		const recovered = recoverLocation(loc, { modules, forms, fields });
		const target = recovered === loc ? loc : recovered;

		/* Strategy 2: check if the URL path matches the canonical path for
		 * the (possibly recovered) location. With path-based parsing, the
		 * parser degrades unresolvable UUIDs at parse time, so the parsed
		 * location may be "home" while the URL still shows old segments. */
		const canonicalSegments = serializePath(target);
		const urlMatchesLocation =
			segments.length === canonicalSegments.length &&
			segments.every((s, i) => s === canonicalSegments[i]);

		if (recovered === loc && urlMatchesLocation) return;

		const parts = pathname.split("/").filter(Boolean);
		const basePath = `/${parts.slice(0, 2).join("/")}`;
		const url = buildUrl(basePath, target);
		window.history.replaceState(null, "", url);
		notifyPathChange();
	}, [loc, modules, forms, fields, pathname, segments]);

	return null;
}
