import type { BrowserContext, Page, Request, Route } from "@playwright/test";

type RouteHandler = (route: Route, request: Request) => unknown;
type RouteUrl = Parameters<Page["route"]>[0];
type RouteOptions = Parameters<Page["route"]>[2];

export interface RemovableRoutes {
	/** Adds a route to the group, taking what `page.route` takes. */
	route(
		url: RouteUrl,
		handler: RouteHandler,
		options?: RouteOptions,
	): Promise<void>;
	/**
	 * Waits until no request is inside any of the group's handlers, then
	 * removes them all. Release anything a handler is holding first: a handler
	 * still waiting on a gate holds this call until the test times out.
	 */
	removeAll(): Promise<void>;
}

/**
 * Routes a test removes again, and the one way a spec removes a route
 * (`e2e/lint/routeRemoval.grit` refuses a bare `unroute` or `unrouteAll`).
 *
 * Playwright stops intercepting a page's requests as soon as its list of
 * routes is empty, and it forwards any request still waiting in a handler
 * itself. The handler's own `fulfill` or `continue` then throws "Route is
 * already handled!". `unrouteAll({ behavior: "wait" })` does not prevent it:
 * it empties the list before it waits, and another request finishing in a
 * handler meanwhile turns interception off. `removeAll` waits until the
 * handlers hold no request and only then removes the routes, in the same
 * turn, so no request can start in between.
 *
 * A route kept after its handler returns, to be fulfilled later, is outside
 * what `removeAll` can see: the test finishes or aborts it first.
 */
export function removableRoutes(
	target: Page | BrowserContext,
): RemovableRoutes {
	const added: { url: RouteUrl; handler: RouteHandler }[] = [];
	const running = new Set<Promise<unknown>>();
	return {
		async route(url, handler, options) {
			const tracked = async (route: Route, request: Request) => {
				const run = (async () => await handler(route, request))();
				running.add(run);
				try {
					await run;
				} finally {
					running.delete(run);
				}
			};
			added.push({ url, handler: tracked });
			await target.route(url, tracked, options);
		},
		async removeAll() {
			while (running.size > 0) {
				await Promise.allSettled([...running]);
			}
			const removed = added.splice(0);
			await Promise.all(
				removed.map(({ url, handler }) => target.unroute(url, handler)),
			);
		},
	};
}
