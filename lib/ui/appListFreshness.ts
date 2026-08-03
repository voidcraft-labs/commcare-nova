/**
 * A one-shot note that the app list the user can still reach with Back is out
 * of date.
 *
 * Both ways an app is born now install it in place rather than navigating, so
 * the history entry behind the builder is the app list as it stood BEFORE the
 * app existed — and back/forward is served from Next's client Router Cache
 * whatever the route's own freshness says. A user pressing Back would not see
 * the app they just made, and would reasonably make it again.
 *
 * `revalidatePath("/")` is the usual cure and is the wrong one here: the router
 * re-render that carries a revalidation restores Next's own canonical URL,
 * which undoes the promotion from `/build/new` to `/build/{id}` — and doing it
 * afterwards instead leaves a second history entry behind, so Back lands in the
 * builder again rather than on the list. So the note is client-side, and the
 * list refreshes itself when it is next shown.
 *
 * A module singleton on purpose. It describes one moment in one document, and
 * a reload must not inherit it: a reload refetches the list anyway.
 */

let stale = false;

/** Called the moment an app is installed in place. */
export function markAppListStale(): void {
	stale = true;
}

/** Read and clear. The list refreshes once, then goes back to trusting the
 *  cache like every other route. */
export function consumeAppListStale(): boolean {
	const was = stale;
	stale = false;
	return was;
}
