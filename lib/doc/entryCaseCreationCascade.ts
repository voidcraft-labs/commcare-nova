import type { CaseOperation, Form, Uuid } from "@/lib/domain";
import type { Mutation } from "./types";

/**
 * The edit that keeps a form's deep-link creation choice
 * (`Form.entryCaseCreations`) to the case operations a batch leaves it, for
 * a batch that removes operations. A removed creation leaves the choice in
 * the same batch, and a choice left empty clears, so removing a case change
 * a deep link supplied succeeds with the link taking that ID from the form
 * again, rather than stopping on the choice that named it. Nothing where the
 * form chose none or every chosen creation remains.
 */
export function entryCaseCreationsLeftBy(
	form: Form,
	remaining: readonly CaseOperation[],
): Mutation[] {
	const chosen = form.entryCaseCreations;
	if (chosen === undefined) return [];
	const left = new Set<Uuid>(remaining.map((operation) => operation.uuid));
	const kept = chosen.filter((uuid) => left.has(uuid));
	if (kept.length === chosen.length) return [];
	return [
		{
			kind: "updateForm",
			uuid: form.uuid,
			patch: { entryCaseCreations: kept.length > 0 ? kept : null },
		},
	];
}
