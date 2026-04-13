/**
 * Client-side effect that scrubs stale URL params whenever a referenced
 * entity disappears from the doc. Mounted inside BuilderProvider so it
 * has access to both the doc store (via BlueprintDocContext) and the
 * Next.js App Router (via useRouter).
 *
 * The effect walks the current location inside-out (most specific to
 * least specific), dropping any reference that doesn't resolve. The
 * scrubbed location is issued as a `router.replace` so the bad URL
 * doesn't end up in history.
 *
 * Returns `null` — exists purely for its side effect.
 */
"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useLocation } from "@/lib/routing/hooks";
import { recoverLocation, serializeLocation } from "@/lib/routing/location";

export function LocationRecoveryEffect() {
	const loc = useLocation();
	const router = useRouter();
	const pathname = usePathname();

	/* Subscribe to entity maps directly so the effect re-fires whenever a
	 * referenced uuid might have disappeared. Each slice is an Immer-stable
	 * reference, so `useBlueprintDoc` with the default `Object.is` equality
	 * only triggers when the specific map's identity changes. */
	const modules = useBlueprintDoc((s) => s.modules);
	const forms = useBlueprintDoc((s) => s.forms);
	const questions = useBlueprintDoc((s) => s.questions);

	useEffect(() => {
		/* `recoverLocation` accepts a `LocationDoc` (Pick of BlueprintDoc),
		 * so this ad-hoc slice object is a first-class argument — no cast,
		 * no full doc reconstruction. Identity-equality on the return value
		 * means the happy path (everything resolves) short-circuits with a
		 * single pointer comparison.
		 *
		 * No empty-doc short-circuit: a previous version skipped this effect
		 * when all three entity maps were empty to avoid firing during
		 * hydration (Idle / new build before generation). That guard also
		 * swallowed the "user deleted every module mid-session" case —
		 * when the URL still points at dead uuids but the doc is empty,
		 * we want recovery to fire. The Idle case is handled trivially by
		 * `recoverLocation` itself: if `loc.kind === "home"` it returns
		 * the same reference and the identity check below skips the
		 * `router.replace`. */
		const recovered = recoverLocation(loc, { modules, forms, questions });
		if (recovered === loc) return;

		const params = serializeLocation(recovered).toString();
		const url = params ? `${pathname}?${params}` : pathname;
		router.replace(url, { scroll: false });
	}, [loc, modules, forms, questions, router, pathname]);

	return null;
}
