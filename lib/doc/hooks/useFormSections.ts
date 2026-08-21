/**
 * useFormIsSectioned — whether a form is split into pages, reactively.
 *
 * A sectioned form's root holds sections only (the commit gate refuses any
 * other shape), so the first root field's kind is the whole answer: two
 * narrow subscriptions (the root order, the first root field) rather than
 * the field maps.
 */
"use client";
import type { Uuid } from "@/lib/domain";
import { useField } from "./useEntity";
import { useOrderedFields } from "./useOrderedFields";

export function useFormIsSectioned(formUuid: Uuid | undefined): boolean {
	const order = useOrderedFields(formUuid);
	const first = useField(order[0]);
	return first?.kind === "section";
}
