/**
 * Reconstruct the nested `BlueprintForm` shape for a single form.
 *
 * Used by consumers that predate the normalized doc model — the expander,
 * the XForms compiler, the form preview renderer. Memoized so the
 * reconstruction runs only when the form's entity or field subtree
 * changes.
 *
 * Off-form short-circuit: callers that live inside the builder layout
 * (shortcut handlers, delete action) keep this hook mounted at all times,
 * but only actually need an assembled form when the location is a form
 * screen. Passing `undefined` makes the hook cheap — the selector returns
 * a stable `undefined` without touching any entity map, so zustand's
 * `Object.is` equality never triggers a re-render while off-form. This
 * eliminates the full-tree rebuild that earlier call sites incurred by
 * coercing an absent uuid to an empty string.
 */

import { useMemo } from "react";
import type { BlueprintDoc, QuestionEntity, Uuid } from "@/lib/doc/types";
import type { BlueprintForm, Question } from "@/lib/schemas/blueprint";
import { assembleFormFields } from "@/lib/services/normalizedState";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

/* Stable sentinel returned by the selector when the hook is in its
 * "off-form" short-circuit. Using a single module-level reference means
 * every no-op invocation shares the same object identity — with shallow
 * equality, zustand short-circuits without subscribing to any entity map. */
const OFF_FORM_STATE = { form: undefined } as const;

type AssembledSlice =
	| typeof OFF_FORM_STATE
	| {
			form: BlueprintDoc["forms"][Uuid];
			fields: BlueprintDoc["fields"];
			fieldOrder: BlueprintDoc["fieldOrder"];
	  };

export function useAssembledForm(
	formUuid: Uuid | undefined,
): BlueprintForm | undefined {
	/* Selector runs on every store update, but when `formUuid` is falsy
	 * it returns the shared sentinel — shallow equality then sees no
	 * change and skips the re-render. When `formUuid` is set, the
	 * selected slice is a plain object of Immer-stable references, so
	 * shallow equality still avoids re-renders when unrelated state
	 * changes (e.g. UI fields on the legacy store mirror). */
	const state: AssembledSlice = useBlueprintDocShallow((s) => {
		if (!formUuid) return OFF_FORM_STATE;
		const form = s.forms[formUuid];
		if (!form) return OFF_FORM_STATE;
		return {
			form,
			fields: s.fields,
			fieldOrder: s.fieldOrder,
		};
	});

	return useMemo(() => {
		if (!formUuid || state === OFF_FORM_STATE || !state.form) {
			return undefined;
		}
		// Use the shared camel→snake assembler so the returned BlueprintForm
		// has wire-format field names (close_condition, post_submit, etc.).
		// Cast through `unknown` to bridge the branded Uuid vs plain string gap.
		return {
			...assembleFormFields(
				state.form as unknown as Parameters<typeof assembleFormFields>[0],
			),
			questions: assembleFieldTree(formUuid, state.fields, state.fieldOrder),
		};
	}, [formUuid, state]);
}

/**
 * Recursively rebuild the nested question tree for a single parent.
 *
 * Mirrors the `assembleQuestions` function in `converter.ts` but operates
 * on the flat entity maps rather than the full `BlueprintDoc`. Groups and
 * repeats include a `children` array; leaf fields omit it entirely.
 */
function assembleFieldTree(
	parentUuid: Uuid,
	fields: BlueprintDoc["fields"],
	fieldOrder: BlueprintDoc["fieldOrder"],
): Question[] {
	const order = fieldOrder[parentUuid] ?? [];
	return order
		.map((uuid) => {
			const field = fields[uuid];
			if (!field) return undefined;
			const nested = fieldOrder[uuid];
			return nested !== undefined
				? {
						...(field as QuestionEntity),
						children: assembleFieldTree(uuid, fields, fieldOrder),
					}
				: (field as unknown as Question);
		})
		.filter((q): q is Question => q !== undefined);
}
