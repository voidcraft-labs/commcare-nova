/**
 * Claims the shared header band for the builder the moment the ROUTE commits,
 * which is earlier than the builder itself can.
 *
 * `BuilderHeader` claims too, and does it with live values, but it lives under
 * the build page — and that page awaits an authorized app snapshot plus its
 * threads before it renders anything. So on a hard load of `/build/{id}` the
 * shell hydrates first, the band has no claim yet, and it paints the site's
 * nav, Project switcher, and Help inside the builder for as long as those
 * reads take. This component sits in the route's own layout, above every one
 * of those awaits, so the claim lands in the first commit.
 *
 * The two writers do not disagree: what this claims IS the state the builder
 * opens in — an existing app starts in the loading phase and therefore wears
 * the mark alone, `/build/new` has no app and therefore wears the whole
 * lockup, and access begins authorized from the server-resolved tuple. The
 * band takes the last write, so `BuilderHeader` keeps it current from here.
 */

"use client";

import { useEffect } from "react";
import { useHeaderSlots } from "@/components/ui/headerSlots";

export function BuilderBandClaim({ newBuild }: { newBuild: boolean }) {
	const slots = useHeaderSlots();
	const claim = slots?.claim;
	useEffect(() => {
		claim?.({
			homeLabel: "Back to your apps",
			markOnly: !newBuild,
			stacked: false,
			/* Nothing has arrived in the row yet either way. */
			brand: "roomy",
			showAccount: true,
			canManageFiles: false,
		});
		return () => claim?.(null);
	}, [claim, newBuild]);
	return null;
}
