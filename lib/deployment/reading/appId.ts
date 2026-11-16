/**
 * The id of the app a bring-in creates.
 *
 * The client never chooses an app's primary key: it sends back the reading's
 * id, and the app's id is a hash of that id with the person's own id and the
 * key of the HQ app. A request can therefore aim at no existing app, and no
 * one else's request derives the same id. A create sent twice derives the
 * same id twice, which is what makes a repeated create answer the app the
 * first one made.
 */

import "server-only";
import { v5 as uuidv5 } from "uuid";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import type { ReadingKey } from "./types";

export const BROUGHT_IN_APP_NAMESPACE = "01616c9c-4e63-4e67-80dd-67bcb59e8431";

/** UUIDv5 under the namespace of
 *  `canonicalJsonText([actorUserId, projectId, server, domain, remoteAppId, readingId])`. */
export function broughtInAppId(
	actorUserId: string,
	key: ReadingKey,
	readingId: string,
): string {
	return uuidv5(
		canonicalJsonText([
			actorUserId,
			key.projectId,
			key.server,
			key.domain,
			key.remoteAppId,
			readingId,
		]),
		BROUGHT_IN_APP_NAMESPACE,
	);
}
