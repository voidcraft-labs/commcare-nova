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
import {
	type FormFieldEntryWithAncestors,
	formFieldEntriesFor,
} from "../formFieldEntries";
import { findContainingForm } from "../mutations/helpers";
import { useBlueprintDoc, useBlueprintDocShallow } from "./useBlueprintDoc";

export type {
	FormFieldEntry,
	FormFieldEntryWithAncestors,
} from "../formFieldEntries";

/** Every field in the form, in canvas order, with complete repeat ancestry. */
export function useFormFieldEntries(
	formUuid: Uuid,
): readonly FormFieldEntryWithAncestors[] {
	const source = useFormFieldEntrySource();
	return useMemo(
		() => formFieldEntriesFor(source, formUuid),
		[source, formUuid],
	);
}

function useFormFieldEntrySource() {
	return useBlueprintDocShallow((state) => ({
		fields: state.fields,
		fieldOrder: state.fieldOrder,
		forms: state.forms,
		fieldParent: state.fieldParent,
		userProperties: state.userProperties,
	}));
}

/** Answer and destination choices for an Android app belong to the form
 * containing its question, including while the question is nested. */
export function useAndroidAppQuestionEntries(fieldUuid: Uuid) {
	const formUuid = useBlueprintDoc((state) =>
		findContainingForm(state, fieldUuid),
	);
	const source = useFormFieldEntrySource();
	return useMemo(
		() =>
			formUuid
				? formFieldEntriesFor(source, formUuid).map((entry) => {
						const field = source.fields[entry.uuid];
						return {
							...entry,
							app:
								field && "androidApp" in field ? field.androidApp : undefined,
						};
					})
				: [],
		[source, formUuid],
	);
}
