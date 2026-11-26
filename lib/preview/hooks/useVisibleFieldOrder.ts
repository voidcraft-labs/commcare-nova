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
	proseTemplateText,
	type RepeatField,
	resolveAppLanguage,
	type Uuid,
} from "@/lib/domain";
import { formOfField } from "@/lib/domain/fieldForm";
import { formRootName } from "@/lib/domain/formAnswerRoot";
import type { RuntimeStoreState } from "../engine/engineController";
import { DEFAULT_RUNTIME_STATE } from "../engine/engineController";
import {
	controlValuePath,
	type FieldTreeNode,
	formFieldTrees,
} from "../engine/fieldTree";
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
// inventory for every recursive renderer. The projection is the filled one a
// worker reads, so a blank translation shows the text a device shows.
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
	const fields = projectLocalizedFields(doc, resolved, { filled: true });
	byLanguage.set(resolved, fields);
	return fields;
}

function presentationSource(
	state: RuntimeStoreState,
	workerRelevant: ReadonlySet<string> | undefined,
): FormPresentationSource {
	return {
		workerRelevant,
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
		const form = formOfField(doc, parentUuid);
		if (form === undefined) return [];
		const { controls } = formFieldTrees(
			form,
			presentationFields(doc, resolved),
			doc.fieldOrder,
			`/${formRootName(doc.forms[form])}`,
		);
		const remember = (parent: Uuid, list: FieldTreeNode[]) => {
			byParent.set(parent, list);
			for (const node of list)
				if (node.children !== undefined)
					remember(node.field.uuid, node.children);
		};
		remember(form, controls);
		tree = byParent.get(parentUuid) ?? [];
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
						controlValuePath(node, prefix),
						presentationSource(state, controller.workerRelevantPaths()),
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
				presentationSource(state, controller.workerRelevantPaths()),
			),
		),
	);
}

/** Android's current QuestionsView owns its floating labels. Use the same
 * localized fields and concrete display state as the worker form itself. */
export interface QuestionBanner {
	readonly path: string;
	readonly uuid: Uuid;
	readonly tone: "good" | "caution" | "bad";
	readonly text: string;
}
export function useScreenBanners(uuid: Uuid, path: string): QuestionBanner[] {
	const language = useContext(BlueprintAuthoringLanguageContext);
	const controller = useEngineController();
	return usePresentationSelector(
		(doc) => {
			const field = presentationFields(doc, language)[uuid];
			const source = presentationSource(
				controller.store.getState(),
				controller.workerRelevantPaths(),
			);
			const found: QuestionBanner[] = [];
			function visit(node: FieldTreeNode, concrete: string) {
				const { field, children = [] } = node;
				const state = source.stateAt(field, concrete);
				if (!state.visible || source.workerRelevant?.has(concrete) === false)
					return;
				const tone = "banner" in field ? field.banner : undefined;
				const label = "label" in field ? field.label : undefined;
				if ((tone === "good" || tone === "caution" || tone === "bad") && label)
					found.push({
						path: concrete,
						uuid: field.uuid,
						tone,
						text: state.resolvedLabel ?? proseTemplateText(label),
					});
				const containers =
					field.kind === "repeat"
						? visibleRepeatInstances(node, concrete, source).map(
								(index) => `${concrete}[${index}]`,
							)
						: [concrete];
				for (const parent of containers)
					for (const child of children)
						visit(child, controlValuePath(child, parent));
			}
			if (field)
				visit({ field, children: presentationTree(doc, language, uuid) }, path);
			return found;
		},
		(a, b) =>
			a.length === b.length &&
			a.every(
				(one, i) =>
					one.path === b[i].path &&
					one.uuid === b[i].uuid &&
					one.tone === b[i].tone &&
					one.text === b[i].text,
			),
	);
}
