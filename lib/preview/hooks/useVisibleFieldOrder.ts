"use client";

import { useContext } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
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
import { buildFieldTree, type FieldTreeNode } from "../engine/fieldTree";
import {
	type FormPresentationSource,
	fieldHasWorkerPresentation,
	fieldTreesEqual,
	visibleRepeatInstances,
} from "../engine/formPresentation";
import { useEngineController } from "./useEngineController";
import { usePresentationSelector } from "./usePresentationDocument";

// Document snapshots are immutable. Sibling/instance selectors share one
// language projection per snapshot instead of rebuilding its translation
// inventory for every recursive renderer.
const localizedFieldsByDoc = new WeakMap<
	BlueprintDoc,
	Map<LanguageTag, Record<string, Field>>
>();
const fieldTreesByDoc = new WeakMap<
	BlueprintDoc,
	Map<LanguageTag | null, Map<Uuid, FieldTreeNode[]>>
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

function presentationSource(state: RuntimeStoreState): FormPresentationSource {
	return {
		stateAt: (field, path) =>
			state[path.includes("[") ? path : field.uuid] ?? DEFAULT_RUNTIME_STATE,
	};
}

function samePresentationField(
	left: Field | undefined,
	right: Field | undefined,
) {
	return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function presentationTree(
	doc: BlueprintDoc,
	language: LanguageTag | null,
	parentUuid: Uuid,
) {
	const resolved =
		language === null ? null : resolveAppLanguage(doc.localization, language);
	let byLanguage = fieldTreesByDoc.get(doc);
	if (byLanguage === undefined) {
		byLanguage = new Map();
		fieldTreesByDoc.set(doc, byLanguage);
	}
	let byParent = byLanguage.get(resolved);
	if (byParent === undefined) {
		byParent = new Map();
		byLanguage.set(resolved, byParent);
	}
	let tree = byParent.get(parentUuid);
	if (tree === undefined) {
		tree = buildFieldTree(
			parentUuid,
			presentationFields(doc, resolved),
			doc.fieldOrder,
		);
		byParent.set(parentUuid, tree);
	}
	return tree;
}

function useFieldTree(parentUuid: Uuid) {
	const language = useContext(BlueprintAuthoringLanguageContext);
	return usePresentationSelector(
		(doc) => presentationTree(doc, language, parentUuid),
		(left, right) => fieldTreesEqual(left, right, samePresentationField),
	);
}

/** Field IDs and prose come from the document owning the published runtime. */
export function usePresentationField(uuid: Uuid): Field | undefined {
	const language = useContext(BlueprintAuthoringLanguageContext);
	return usePresentationSelector(
		(doc) => presentationFields(doc, language)[uuid],
		samePresentationField,
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
