/**
 * BuilderReferenceProvider: isolates the selected-form route projection
 * needed to resolve the in-scope form for reference autocomplete/lint.
 *
 * The in-scope form lives on the URL, so `getRefContext` needs a
 * selected-form read. Keeping that read here, rather than in
 * `BuilderLayout`: preserves the layout's "re-render only on app
 * lifecycle transitions" invariant: every selection change issues a
 * navigation, and a layout-level `useLocation()` would cascade those
 * into layout re-renders.
 *
 * This component owns the `useLocation()` subscription, constructs
 * `getRefContext` via the doc store imperatively (no reactive
 * subscription), and renders `ReferenceProviderWrapper`. Re-renders here
 * are cheap: the child tree is just the wrapper, whose
 * `ReferenceProvider` instance is memoized and whose cache invalidation
 * is driven by the `subscribeMutation` handle, not the React render
 * cycle.
 */

"use client";

import { useCallback, useContext } from "react";
import { buildLintContext } from "@/lib/codemirror/buildLintContext";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDocState } from "@/lib/doc/store";
import { asUuid } from "@/lib/domain";
import { ReferenceProviderWrapper } from "@/lib/references/ReferenceContext";
import { useSelectedFormUuid } from "@/lib/routing/hooks";

interface BuilderReferenceProviderProps {
	children: React.ReactNode;
}

/** `buildLintContext` reads only these field slots. A scalar edit to case
 * storage, validation, defaults, media, or choice configuration cannot change
 * a reference's path, display label, or value-producing kind. */
function referenceFieldsChanged(
	current: BlueprintDocState["fields"],
	previous: BlueprintDocState["fields"],
): boolean {
	if (current === previous) return false;
	const currentEntries = Object.entries(current);
	if (currentEntries.length !== Object.keys(previous).length) return true;
	for (const [uuid, field] of currentEntries) {
		const before = previous[uuid];
		if (
			before === undefined ||
			field.id !== before.id ||
			field.kind !== before.kind ||
			("label" in field ? field.label : undefined) !==
				("label" in before ? before.label : undefined)
		) {
			return true;
		}
	}
	return false;
}

function referenceFormsChanged(
	current: BlueprintDocState["forms"],
	previous: BlueprintDocState["forms"],
): boolean {
	if (current === previous) return false;
	const currentEntries = Object.entries(current);
	if (currentEntries.length !== Object.keys(previous).length) return true;
	return currentEntries.some(
		([uuid, form]) => previous[uuid]?.type !== form.type,
	);
}

function referenceModulesChanged(
	current: BlueprintDocState["modules"],
	previous: BlueprintDocState["modules"],
): boolean {
	if (current === previous) return false;
	const currentEntries = Object.entries(current);
	if (currentEntries.length !== Object.keys(previous).length) return true;
	return currentEntries.some(
		([uuid, module]) => previous[uuid]?.caseType !== module.caseType,
	);
}

export function BuilderReferenceProvider({
	children,
}: BuilderReferenceProviderProps) {
	const docStore = useContext(BlueprintDocContext);
	const currentFormUuid = useSelectedFormUuid();

	/** Build the `XPathLintContext` for any form by uuid. Called by
	 *  `ReferenceProvider` whenever it resolves a ref: the active form for
	 *  in-editor surfaces, each field's owning form for the sidebar. Reads the
	 *  doc store imperatively so we don't subscribe to blueprint state here
	 *  (cache invalidation is driven by `subscribeMutation` below). */
	const getContextForForm = useCallback(
		(formUuid: string) =>
			docStore
				? buildLintContext(docStore.getState(), asUuid(formUuid))
				: undefined,
		[docStore],
	);

	/** The form the user is currently editing, surfaced via `useCurrentFormUuid`
	 *  so editor/canvas chip surfaces resolve without threading the uuid.
	 *  A form's own configuration URLs name the same form. */
	/** Subscribe to every document projection read by `buildLintContext`. Field
	 *  moves change only `fieldOrder`; form moves change only `formOrder`;
	 *  worker-information renames and case-catalog edits likewise live outside
	 *  the field/module/form entity maps. Entity maps are compared through the
	 *  exact slots the lint context consumes, so a case-write or ordinary logic
	 *  edit does not clear every form cache and wake every projected tree label. */
	const subscribeMutation = useCallback(
		(listener: () => void) => {
			if (!docStore) return () => {};
			return docStore.subscribe((current, previous) => {
				if (
					current.fieldOrder !== previous.fieldOrder ||
					current.formOrder !== previous.formOrder ||
					current.caseTypes !== previous.caseTypes ||
					current.userProperties !== previous.userProperties ||
					referenceFieldsChanged(current.fields, previous.fields) ||
					referenceFormsChanged(current.forms, previous.forms) ||
					referenceModulesChanged(current.modules, previous.modules)
				) {
					listener();
				}
			});
		},
		[docStore],
	);

	return (
		<ReferenceProviderWrapper
			getContextForForm={getContextForForm}
			currentFormUuid={currentFormUuid}
			subscribeMutation={subscribeMutation}
		>
			{children}
		</ReferenceProviderWrapper>
	);
}
