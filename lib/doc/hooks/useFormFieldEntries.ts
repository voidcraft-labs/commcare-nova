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
import {
	type CasePropertyDataType,
	caseDataTypeForFieldKind,
	type Field,
	type FieldKind,
} from "@/lib/domain";
import type { Uuid } from "../types";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export interface FormFieldEntry {
	readonly uuid: Uuid;
	readonly id: string;
	/** The author's own words for the field — its label, else its id. */
	readonly label: string;
	readonly kind: FieldKind;
	/** The case data type the answer holds; `undefined` for a container
	 *  and for `hidden`, which always holds a value but declares no type. */
	readonly dataType: CasePropertyDataType | undefined;
	/** The innermost repeat containing this field, if any. */
	readonly repeat: Uuid | undefined;
}

function labelOf(field: Field): string {
	const label = "label" in field ? (field.label ?? "").trim() : "";
	return label.length > 0 ? label : field.id;
}

/** Every field in the form, in canvas order, innermost-repeat-tagged. */
export function useFormFieldEntries(formUuid: Uuid): readonly FormFieldEntry[] {
	const { fields, fieldOrder } = useBlueprintDocShallow((state) => ({
		fields: state.fields,
		fieldOrder: state.fieldOrder,
	}));
	return useMemo(() => {
		const found: FormFieldEntry[] = [];
		const walk = (parent: Uuid, repeat: Uuid | undefined) => {
			for (const uuid of fieldOrder[parent] ?? []) {
				const field = fields[uuid];
				if (field === undefined) continue;
				const inner = field.kind === "repeat" ? field.uuid : repeat;
				found.push({
					uuid: field.uuid,
					id: field.id,
					label: labelOf(field),
					kind: field.kind,
					dataType: caseDataTypeForFieldKind(field.kind),
					repeat: inner,
				});
				walk(uuid, inner);
			}
		};
		walk(formUuid, undefined);
		return found;
	}, [fields, fieldOrder, formUuid]);
}
