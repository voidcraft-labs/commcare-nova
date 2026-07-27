// lib/doc/hooks/useFormFieldEntries.ts
//
// One form's answers, flattened, with the repeat each one sits in.
//
// Every surface that offers "which answer?" needs the same three facts —
// what it is called, what type it holds, and which repeat (if any) it
// belongs to — and the third is the one that decides admissibility for a
// case operation: an operation running once per submission cannot read
// an answer that has one value per iteration.
//
// A named hook rather than a selector at the call site, because
// selector-accepting store hooks are lib-private; the projection is
// memoized on the two entity maps it reads so a consumer can keep it in
// a dependency array.

"use client";

import { useMemo } from "react";
import type { Uuid } from "@/lib/domain";
import { type FormFieldEntry, formFieldEntriesFor } from "../formFieldEntries";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export type { FormFieldEntry } from "../formFieldEntries";

/** Every field in the form, in canvas order, innermost-repeat-tagged. */
export function useFormFieldEntries(formUuid: Uuid): readonly FormFieldEntry[] {
	const { fields, fieldOrder } = useBlueprintDocShallow((state) => ({
		fields: state.fields,
		fieldOrder: state.fieldOrder,
	}));
	return useMemo(
		() => formFieldEntriesFor(fields, fieldOrder, formUuid),
		[fields, fieldOrder, formUuid],
	);
}
