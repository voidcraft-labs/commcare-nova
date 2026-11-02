/**
 * One string per write key, for the maps and sets that track an operation's
 * writes by what they save to.
 *
 * A write is keyed by its property and the indices its `via` walks
 * (`lib/domain/forms.ts::caseWriteKeySchema`), so two writes of one property
 * through different indices are different members. The spelling is an
 * injective projection of that pair, never shown to anyone.
 */

import type { CaseOperationWrite, CaseWriteKey } from "@/lib/domain";
import { caseWriteKeyOf } from "@/lib/domain";

/** The string standing for `key` in a map or set. */
export function caseWriteKeyId(key: CaseWriteKey): string {
	return JSON.stringify([
		key.property,
		(key.via ?? []).map((step) => [
			step.identifier,
			step.throughCaseType ?? null,
		]),
	]);
}

/** The string standing for the key `write` saves to. */
export function caseWriteIdOf(write: CaseOperationWrite): string {
	return caseWriteKeyId(caseWriteKeyOf(write));
}
