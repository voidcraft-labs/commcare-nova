/**
 * Refetches the app list once, when the user arrives on a list that was
 * rendered before an app they have since created.
 *
 * Creation installs its app in place rather than navigating, so the history
 * entry behind the builder is the list as it stood beforehand — and Next serves
 * back/forward from the client Router Cache whatever the route's own freshness
 * says. Without this, Back shows a list missing the app the user just made.
 *
 * The note is set by the installer and read exactly once
 * (`lib/ui/appListFreshness`), so an ordinary visit costs nothing: no refetch,
 * no second render, no request.
 *
 * Renders nothing; it exists for its effect.
 */

"use client";

import { useEffect } from "react";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { consumeAppListStale } from "@/lib/ui/appListFreshness";

export function RefreshStaleAppList() {
	const { refresh } = useExternalNavigate();
	useEffect(() => {
		if (consumeAppListStale()) refresh();
	}, [refresh]);
	return null;
}
