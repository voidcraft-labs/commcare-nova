/** Cross-route navigation consults the mounted Builder at event time, before
 * Next can replace it. The guard owns no copy of the document or save state. */
const guards = new Set<(url: string) => boolean>();

export function allowRouteDeparture(url: string): boolean {
	for (const guard of guards) if (!guard(url)) return false;
	return true;
}

/** Native reload/close and client-side exits share the same live work predicate.
 * Same-app History navigation preserves the runtime and needs no warning. */
export function guardBuilderDeparture(
	appId: () => string | undefined,
	hasUnsavedChanges: () => boolean,
): () => void {
	const staysInBuilder = (url: string) => {
		const destination = new URL(url, window.location.href);
		const id = appId();
		const prefix = `/build/${id ?? "new"}`;
		return (
			destination.origin === window.location.origin &&
			(destination.pathname === prefix ||
				destination.pathname.startsWith(`${prefix}/`))
		);
	};
	const allow = (url: string) =>
		staysInBuilder(url) ||
		!hasUnsavedChanges() ||
		window.confirm(
			"Your latest edits haven't been saved yet. Leave and discard those edits?",
		);
	const beforeUnload = (event: BeforeUnloadEvent) => {
		if (!hasUnsavedChanges()) return;
		event.preventDefault();
		// Browsers own this dialog's wording. returnValue covers older engines.
		event.returnValue = "";
	};
	const click = (event: MouseEvent) => {
		if (
			event.defaultPrevented ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		)
			return;
		const anchor = event
			.composedPath()
			.find(
				(target): target is HTMLAnchorElement =>
					target instanceof HTMLAnchorElement,
			);
		if (
			!anchor?.hasAttribute("href") ||
			anchor.hasAttribute("download") ||
			(anchor.target !== "" && anchor.target !== "_self")
		)
			return;
		const url = new URL(anchor.href);
		// Full document departures use beforeunload (one native warning).
		if (url.origin !== window.location.origin) return;
		if (!staysInBuilder(url.href) && hasUnsavedChanges()) {
			// Take the native departure path while dirty. This catches Next Links
			// before their route transition and gives plain anchors only one dialog.
			event.preventDefault();
			event.stopPropagation();
			window.location.assign(url.href);
		}
	};
	const navigate = (event: NavigateEvent) => {
		// Back/Forward can leave through a cached Next route without unloading.
		// Cancel before popstate; canceling a push after Next renders is too late.
		if (
			event.navigationType === "traverse" &&
			event.destination.sameDocument &&
			event.cancelable &&
			!allow(event.destination.url)
		)
			event.preventDefault();
	};
	guards.add(allow);
	window.addEventListener("beforeunload", beforeUnload);
	document.addEventListener("click", click, true);
	window.navigation?.addEventListener("navigate", navigate);
	return () => {
		guards.delete(allow);
		window.removeEventListener("beforeunload", beforeUnload);
		document.removeEventListener("click", click, true);
		window.navigation?.removeEventListener("navigate", navigate);
	};
}
