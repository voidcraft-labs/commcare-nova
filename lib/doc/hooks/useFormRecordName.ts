"use client";

import { deepEqual } from "@/lib/doc/deepEqual";
import { formRecordName } from "@/lib/doc/formRecordName";
import { projectXPath, type Uuid, xpathPrintContext } from "@/lib/domain";
import { useBlueprintDocEq } from "./useBlueprintDoc";

export function useFormRecordName(formUuid: Uuid) {
	return useBlueprintDocEq((doc) => {
		const value = formRecordName(doc, formUuid);
		return value ? projectXPath(value, xpathPrintContext(doc)) : undefined;
	}, deepEqual);
}
