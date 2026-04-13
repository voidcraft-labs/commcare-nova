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
import type { BlueprintDoc } from "@/lib/doc/types";
import { useLocation } from "@/lib/routing/hooks";
import { serializeLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

/**
 * Reduce an invalid Location to the closest valid ancestor given the
 * current doc. Pure function — no hooks, easy to unit test if needed.
 *
 * Recovery policy (most specific → least specific):
 * - Home: always valid, returned as-is.
 * - Module/cases with missing module → home.
 * - Form with missing form → parent module screen.
 * - Form with missing selectedUuid → same form, no selection.
 * - If everything resolves, return the original location unchanged
 *   (referential identity preserved for the === check in the effect).
 */
function recover(loc: Location, doc: BlueprintDoc): Location {
	if (loc.kind === "home") return loc;

	/* Module UUID is shared by module, cases, and form screens. */
	if (doc.modules[loc.moduleUuid] === undefined) {
		return { kind: "home" };
	}

	if (loc.kind === "module") return loc;
	if (loc.kind === "cases") return loc;

	/* loc.kind === "form" — check form, then selected question. */
	if (doc.forms[loc.formUuid] === undefined) {
		return { kind: "module", moduleUuid: loc.moduleUuid };
	}

	if (
		loc.selectedUuid !== undefined &&
		doc.questions[loc.selectedUuid] === undefined
	) {
		return {
			kind: "form",
			moduleUuid: loc.moduleUuid,
			formUuid: loc.formUuid,
		};
	}

	return loc;
}

export function LocationRecoveryEffect() {
	const loc = useLocation();
	const router = useRouter();
	const pathname = usePathname();

	/* Subscribe to entity maps directly so the effect re-fires whenever a
	 * referenced uuid might have disappeared. */
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

		const doc = { modules, forms, questions } as BlueprintDoc;
		const recovered = recover(loc, doc);
		if (recovered === loc) return;

		const params = serializeLocation(recovered).toString();
		const url = params ? `${pathname}?${params}` : pathname;
		router.replace(url, { scroll: false });
	}, [loc, modules, forms, questions, router, pathname]);

	return null;
}
