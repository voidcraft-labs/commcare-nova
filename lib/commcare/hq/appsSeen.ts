/**
 * CommCare HQ's own answer, in this request, that a key reaches these apps.
 *
 * A value of `HqAppsSeen` is made only where HQ answered about the apps it
 * names: `apps.ts::listHqApps` for every app the project space's list holds,
 * and `appReading.ts::readHqAppForReading` for the app whose document HQ
 * returned. Nothing else makes one, so a reader that demands it (Nova's view
 * of which Nova app holds an HQ app, `lib/deployment/store.ts::readHqAppClaims`)
 * can't be reached on the strength of what Nova stored about the key earlier:
 * a key HQ no longer answers gets HQ's own refusal, whether or not a Nova app
 * holds the app it named.
 *
 * Only those two modules import this one, and `apps.ts` re-exports the type:
 * a `noRestrictedImports` pattern in `biome.json` refuses any other
 * production importer.
 */

import type { CommCareServer } from "../servers";

declare const SEEN_BY_HQ: unique symbol;

export interface HqAppsSeen {
	readonly server: CommCareServer;
	readonly domain: string;
	/** HQ's ids of the apps it answered about, each once. */
	readonly remoteAppIds: readonly string[];
	readonly [SEEN_BY_HQ]: true;
}

/** Record that HQ just answered, to `server`'s key, about these apps of `domain`. */
export function seenByHq(
	server: CommCareServer,
	domain: string,
	remoteAppIds: readonly string[],
): HqAppsSeen {
	return {
		server,
		domain,
		remoteAppIds: [...new Set(remoteAppIds)],
	} as unknown as HqAppsSeen;
}
