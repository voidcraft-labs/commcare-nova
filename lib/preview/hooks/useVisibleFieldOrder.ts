"use client";

import { useContext } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import { useBlueprintDocEq } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	type BlueprintDoc,
	type Field,
	type LanguageTag,
	projectLocalizedFields,
	type RepeatField,
	resolveAppLanguage,
	type Uuid,
} from "@/lib/domain";
import type { RuntimeStoreState } from "../engine/engineController";
import { DEFAULT_RUNTIME_STATE } from "../engine/engineController";
import { buildFieldTree } from "../engine/fieldTree";
import {
	type FormPresentationSource,
	fieldHasWorkerPresentation,
	fieldTreesEqual,
	visibleRepeatInstances,
} from "../engine/formPresentation";
import { useEngineController } from "./useEngineController";

// Document snapshots are immutable. Sibling/instance selectors share one
// language projection per snapshot instead of rebuilding its translation
// inventory for every recursive renderer.
const localizedFieldsByDoc = new WeakMap<
	BlueprintDoc,
	Map<LanguageTag, Record<string, Field>>
>();

function presentationFields(doc: BlueprintDoc, language: LanguageTag | null) {
	if (language === null) return doc.fields;
	const resolved = resolveAppLanguage(doc.localization, language);
	let byLanguage = localizedFieldsByDoc.get(doc);
	if (byLanguage === undefined) {
		byLanguage = new Map();
		localizedFieldsByDoc.set(doc, byLanguage);
	}
	const cached = byLanguage.get(resolved);
	if (cached !== undefined) return cached;
	const fields = projectLocalizedFields(doc, resolved);
	byLanguage.set(resolved, fields);
	return fields;
}

function samePresentationField(left: Field, right: Field) {
	return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function presentationSource(state: RuntimeStoreState): FormPresentationSource {
	return {
		stateAt: (field, path) =>
			state[path.includes("[") ? path : field.uuid] ?? DEFAULT_RUNTIME_STATE,
	};
}

function useFieldTree(parentUuid: Uuid) {
	const language = useContext(BlueprintAuthoringLanguageContext);
	return useBlueprintDocEq(
		(doc) =>
			buildFieldTree(
				parentUuid,
				presentationFields(doc, language),
				doc.fieldOrder,
			),
		(left, right) => fieldTreesEqual(left, right, samePresentationField),
	);
}

/** Rendered sibling order. Concrete paths preserve each repeat instance's
 * relevance; value-only changes leave this shallow UUID sequence unchanged. */
export function useVisibleFieldOrder(
	parentUuid: Uuid,
	prefix: string,
): readonly Uuid[] {
	const tree = useFieldTree(parentUuid);
	const controller = useEngineController();
	return useStore(
		controller.store,
		useShallow((state) =>
			tree
				.filter((node) =>
					fieldHasWorkerPresentation(
						node,
						`${prefix}/${node.field.id}`,
						presentationSource(state),
					),
				)
				.map((node) => node.field.uuid),
		),
	);
}

/** Automatic iterations without visible content have no instance chrome. */
export function useVisibleRepeatInstances(
	field: RepeatField,
	path: string,
): readonly number[] {
	const children = useFieldTree(field.uuid);
	const controller = useEngineController();
	return useStore(
		controller.store,
		useShallow((state) =>
			visibleRepeatInstances(
				{ field, children },
				path,
				presentationSource(state),
			),
		),
	);
}
