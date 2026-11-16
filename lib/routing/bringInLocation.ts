/**
 * Where the new-app page stands in bringing an app in from CommCare HQ, as its
 * query string says it.
 *
 * `/build/new?hq=choose` is the picker, and `/build/new?hq=app&project=…&server=…&space=…&app=…`
 * names one CommCare HQ app and the Project it is added to. The address holds
 * nothing of what Nova read: opening it reads the app again. A value the read's
 * own key schema refuses, a missing value, and any other `hq` value all read as
 * no bring-in at all, so an address never makes the page post a read for text
 * the read route would refuse.
 *
 * Client-safe and pure.
 */

import {
	type ReadingKey,
	readingKeySchema,
} from "@/lib/deployment/reading/types";

export type BringInLocation =
	| { readonly kind: "none" }
	| { readonly kind: "choose" }
	/** One HQ app, to be added to one Project: the key of a read. */
	| { readonly kind: "app"; readonly key: ReadingKey };

const NEW_APP_PATH = "/build/new";

/** The most characters a project space in the address holds. */
const SPACE_MAX_LENGTH = 255;

const NONE: BringInLocation = Object.freeze({ kind: "none" });
const CHOOSE: BringInLocation = Object.freeze({ kind: "choose" });

/** Reads the `hq` state of a query string: `choose`, an app's key, or anything else as `none`. */
export function bringInLocation(search: string): BringInLocation {
	const params = new URLSearchParams(search);
	const hq = params.get("hq");
	if (hq === "choose") return CHOOSE;
	if (hq !== "app") return NONE;
	const projectId = params.get("project");
	const server = params.get("server");
	const domain = params.get("space");
	const remoteAppId = params.get("app");
	if (
		projectId === null ||
		server === null ||
		domain === null ||
		remoteAppId === null ||
		domain.length < 1 ||
		domain.length > SPACE_MAX_LENGTH
	) {
		return NONE;
	}
	const parsed = readingKeySchema.safeParse({
		projectId,
		server,
		domain,
		remoteAppId,
	});
	if (!parsed.success) return NONE;
	return { kind: "app", key: parsed.data };
}

/** The address of a location: `/build/new`, `/build/new?hq=choose` or the app's address. */
export function bringInHref(location: BringInLocation): string {
	switch (location.kind) {
		case "none":
			return NEW_APP_PATH;
		case "choose":
			return `${NEW_APP_PATH}?hq=choose`;
		case "app": {
			const { projectId, server, domain, remoteAppId } = location.key;
			const params = new URLSearchParams([
				["hq", "app"],
				["project", projectId],
				["server", server],
				["space", domain],
				["app", remoteAppId],
			]);
			return `${NEW_APP_PATH}?${params.toString()}`;
		}
	}
}
