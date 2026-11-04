import { v5 as uuidv5 } from "uuid";
import type { Uuid } from "./uuid";

/**
 * The UUIDv5 namespace of the case operations made from a form's field
 * writes: the own arm, a child or extension create per bucket, the
 * worker-record update. Derived, never random, so the same migration
 * planned twice (a dry run and its execution, or a fuzz draw mapped twice)
 * names the same operations.
 */
export const CASE_WRITE_OPERATION_NAMESPACE_UUID =
	"2d4b57b2-18ff-430a-b230-8eec087cdfc1";

const CASE_WRITE_OPERATION_VERSION = "nova-case-writes-op-v1";

/** `own`, `usercase`, `child:<case type>:<repeat uuid or root>`,
 *  `extension:<case type>:<repeat uuid or root>`. */
export type CaseWriteOperationUnit =
	| "own"
	| "usercase"
	| `child:${string}:${string}`
	| `extension:${string}:${string}`;

/**
 * The UUID of the operation made for `unit` of `formUuid`. The name is the
 * JSON array of the version, the app, the form and the unit, with the
 * attempt appended after the first, so a UUID already taken in the
 * document is stepped around (the planner takes the first attempt whose
 * UUID no entity of the document holds).
 */
export function caseWriteOperationUuid(
	appId: string,
	formUuid: Uuid,
	unit: CaseWriteOperationUnit,
	attempt = 0,
): Uuid {
	const name = JSON.stringify(
		attempt === 0
			? [CASE_WRITE_OPERATION_VERSION, appId, formUuid, unit]
			: [CASE_WRITE_OPERATION_VERSION, appId, formUuid, unit, attempt],
	);
	return uuidv5(name, CASE_WRITE_OPERATION_NAMESPACE_UUID) as Uuid;
}
