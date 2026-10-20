/**
 * Why each of a select's choices can't be removed, read live from the
 * reference index (`lib/doc/optionRemoval.ts`): one reason per option UUID,
 * `undefined` where nothing reads it. A row added in a draft and not yet
 * saved has no readers.
 */

"use client";

import type { Uuid } from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import { optionRemovalBlocker } from "../optionRemoval";
import { useBlueprintDocEq } from "./useBlueprintDoc";

export function useOptionRemovalBlockers(
	optionUuids: readonly Uuid[],
): readonly (string | undefined)[] {
	return useBlueprintDocEq(
		(doc) =>
			optionUuids.map((uuid) =>
				optionRemovalBlocker(
					doc,
					uuid,
					(template) => projectProseTemplate(template, doc).text,
				),
			),
		sameReasons,
	);
}

function sameReasons(
	a: readonly (string | undefined)[],
	b: readonly (string | undefined)[],
): boolean {
	return (
		a.length === b.length && a.every((reason, index) => reason === b[index])
	);
}
