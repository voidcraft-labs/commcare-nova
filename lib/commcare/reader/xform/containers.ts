/**
 * Groups, Question Lists and sections (10.2). A `group` control that wraps no
 * repeat is a `group` field over its data node; `field-list` in any letter
 * case is a Question List, which the runtimes read so (Core's
 * `FormEntryController.isHostWithAppearance` compares ignoring case). A form
 * whose root is made only of Question Lists reads as sections, the document
 * Nova's own editors make of that wire (`xform/builder.ts::buildContainer`:
 * a section is always a field-list).
 */

import { isTag } from "domhandler";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { elementNamespace, splitName, XFORMS_NS } from "../../xmlNamespaces";
import type { Accounting } from "../accounting";
import type { Claim } from "../claims";
import type { XmlCursor } from "../xmlCursor";
import {
	type AppearanceForm,
	claimAppearance,
	classifyAppearance,
} from "./appearances";
import { type ControlNode, isFieldListAppearance } from "./body";
import { X } from "./claims";
import type { DraftField } from "./index";
import type { BindFacts } from "./model";
import type { ParsedXForm } from "./parse";

type ParsedXFormScope = ParsedXForm["scope"];

/** Whether a control holds a `label` child in the XForms namespace. */
export function hasLabel(
	control: ControlNode,
	scope: ParsedXFormScope,
): boolean {
	return control.element.children
		.filter(isTag)
		.some(
			(child) =>
				elementNamespace(child, scope(child)) === XFORMS_NS &&
				splitName(child.name).local === "label",
		);
}

/** Whether a repeat whose rows the worker adds stands anywhere under the field. */
function holdsUserRepeat(
	field: DraftField,
	childrenOf: (f: DraftField) => readonly DraftField[],
): boolean {
	return childrenOf(field).some(
		(child) =>
			(child.kind === "repeat" &&
				child.field.repeat_mode === "user_controlled") ||
			holdsUserRepeat(child, childrenOf),
	);
}

export interface RootSectionsInput {
	readonly root: readonly DraftField[];
	readonly binds: ReadonlyMap<DraftField["node"], BindFacts>;
	readonly childrenOf: (field: DraftField) => readonly DraftField[];
	/** Whether a field's label carries media, which a section cannot hold. */
	readonly labelMedia: (field: DraftField) => boolean;
}

/**
 * Whether the form's root fields all become sections: there is at least one, every one is a
 * Question List, none has a bind `relevant` or label media, and none holds, at any depth, a
 * repeat whose rows the worker adds.
 */
export function rootSections(input: RootSectionsInput): boolean {
	return (
		input.root.length > 0 &&
		input.root.every(
			(field) =>
				field.kind === "group" &&
				field.field.fieldList === true &&
				input.binds.get(field.node)?.logic.relevant === undefined &&
				!input.labelMedia(field) &&
				!holdsUserRepeat(field, input.childrenOf),
		)
	);
}

export interface ReadContainersInput {
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly scope: ParsedXFormScope;
	/** Every group field with its control, in document order. */
	readonly groups: readonly {
		readonly field: DraftField;
		readonly control: ControlNode;
	}[];
	readonly sectioned: boolean;
	readonly childrenOf: (field: DraftField) => readonly DraftField[];
	readonly placeOf: (field: DraftField) => HqPlace;
	readonly intents: AppearanceForm;
	/** Appends a control's data path where its appearance was accounted under an inert entry. */
	readonly inertAppearance: (path: string) => void;
}

/**
 * Claims every group by its row of 10.2, turning each root Question List into a section where
 * `sectioned`, and refuses a repeat whose rows the worker adds anywhere under a Question List.
 */
export function readContainers(input: ReadContainersInput): void {
	const { cursor, accounting } = input;
	for (const { field, control } of input.groups) {
		const labelled = hasLabel(control, input.scope);
		const fieldList = isFieldListAppearance(control.appearance);
		const sites: {
			readonly node: Claim<"take">;
			readonly control: Claim<"take">;
			readonly ref: Claim<"take">;
			readonly appearance?: Claim<"take">;
		} = fieldList
			? input.sectioned && field.parent === null
				? X.sectionQuestionList
				: labelled
					? X.questionList
					: X.unlabelledQuestionList
			: labelled
				? X.group
				: X.unlabelledGroup;
		if (fieldList && input.sectioned && field.parent === null) {
			field.kind = "section";
			delete field.field.fieldList;
		}
		cursor.take({ element: field.node.element }, sites.node).value;
		cursor.take({ element: control.element }, sites.control).value;
		if (control.path === "ref" || control.path === "nodeset")
			cursor.take(
				{ element: control.element, attribute: control.path },
				sites.ref,
			).value;
		const place = input.placeOf(field);
		if (control.appearance !== undefined) {
			if (fieldList && sites.appearance !== undefined)
				cursor.take(
					{ element: control.element, attribute: "appearance" },
					sites.appearance,
				).value;
			else if (
				claimAppearance(
					cursor,
					control,
					classifyAppearance(
						control,
						undefined,
						control.appearance,
						input.intents,
					),
					place,
				).inert
			)
				input.inertAppearance(field.node.path.join("/"));
		}
		if (fieldList) refuseUserRepeats(field, input, accounting);
	}
}

function refuseUserRepeats(
	field: DraftField,
	input: ReadContainersInput,
	accounting: Accounting,
): void {
	for (const child of input.childrenOf(field)) {
		if (
			child.kind === "repeat" &&
			child.field.repeat_mode === "user_controlled"
		)
			accounting.finding(X.userRepeatInQuestionList, input.placeOf(child));
		refuseUserRepeats(child, input, accounting);
	}
}
