import { v5 as uuidv5 } from "uuid";
import type { Uuid } from "./uuid";

/**
 * The UUIDv5 namespace of the date-and-time split's two new questions. The
 * identities are derived, never random, so the same split planned twice (a
 * dry run and its execution, or two people splitting one question at once)
 * names the same questions: the second batch then meets UUIDs already taken
 * and is refused rather than leaving four questions.
 */
export const DATETIME_SPLIT_NAMESPACE_UUID =
	"6cbda68f-3426-4851-8dcc-ed0424034b59";

const DATETIME_SPLIT_VERSION = "nova-datetime-split-v1";

/**
 * The UUID of the date or the time question a split of `fieldUuid` inserts.
 * The name is the JSON array of the version, the app, the original question
 * and the purpose, with the attempt appended after the first, so a question
 * split, joined back by hand while one of its questions stayed, and split
 * again still finds free identities (the planner takes the first attempt
 * whose two UUIDs are both free).
 */
export function datetimeSplitFieldUuid(
	appId: string,
	fieldUuid: Uuid,
	purpose: "date" | "time",
	attempt = 0,
): Uuid {
	const name = JSON.stringify(
		attempt === 0
			? [DATETIME_SPLIT_VERSION, appId, fieldUuid, purpose]
			: [DATETIME_SPLIT_VERSION, appId, fieldUuid, purpose, attempt],
	);
	return uuidv5(name, DATETIME_SPLIT_NAMESPACE_UUID) as Uuid;
}
