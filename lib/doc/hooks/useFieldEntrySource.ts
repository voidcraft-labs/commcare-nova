/**
 * Named owning-document slice for field-picker label projection.
 *
 * Picker labels are full ProseTemplates and may contain UUID-backed field or
 * worker-information references. The source therefore includes every document
 * family needed by `projectProseTemplate`, not only the field tree it walks.
 */

"use client";

import type { FieldEntrySource } from "@/lib/references/provider";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export function useFieldEntrySource(): FieldEntrySource {
	return useBlueprintDocShallow((state) => ({
		fields: state.fields,
		fieldOrder: state.fieldOrder,
		forms: state.forms,
		fieldParent: state.fieldParent,
		userProperties: state.userProperties,
	}));
}
