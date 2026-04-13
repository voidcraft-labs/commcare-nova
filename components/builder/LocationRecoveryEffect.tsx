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
		/* Skip during hydration: if entity maps are still empty (Idle / new
		 * app before generation), there's nothing to validate against. */
		if (
			Object.keys(modules).length === 0 &&
			Object.keys(forms).length === 0 &&
			Object.keys(questions).length === 0
		) {
			return;
		}

		/* `recoverLocation` accepts a `LocationDoc` (Pick of BlueprintDoc),
		 * so this ad-hoc slice object is a first-class argument — no cast,
		 * no full doc reconstruction. Identity-equality on the return value
		 * means the happy path (everything resolves) short-circuits with a
		 * single pointer comparison. */
		const recovered = recoverLocation(loc, { modules, forms, questions });
		if (recovered === loc) return;

		const params = serializeLocation(recovered).toString();
		const url = params ? `${pathname}?${params}` : pathname;
		router.replace(url, { scroll: false });
	}, [loc, modules, forms, questions, router, pathname]);

	return null;
}
