/**
 * Groups, Question Lists and sections. A `group` control that wraps no
 * repeat is a `group` field over its data node; `field-list` in any letter
 * case is a Question List, which the runtimes read so (Core's
 * `FormEntryController.isHostWithAppearance` compares ignoring case). A form
 * whose root questions are all Question Lists reads them as sections, the document
 * Nova's own editors make of that wire (`xform/builder.ts::buildContainer`:
 * a section is always a field-list).
 */

import { type Element, isTag } from "domhandler";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { elementNamespace, splitName, XFORMS_NS } from "../../xmlNamespaces";
import type { Accounting } from "../accounting";
import type { Claim } from "../claims";
import { ownText, type XmlCursor } from "../xmlCursor";
import {
	type AppearanceForm,
	claimAppearance,
	classifyAppearance,
} from "./appearances";
import { type ControlNode, isFieldListAppearance } from "./body";
import { X } from "./claims";
import { hqQuestionType } from "./hqQuestionType";
import type { DraftField } from "./index";
import { itextReference } from "./itext";
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

/** The media forms of an itext value: what a field's label media is. */
const MEDIA_FORMS: ReadonlySet<string> = new Set(["image", "audio", "video"]);

/** An element's children in the XForms namespace named `local`. */
function xformsChildren(
	element: Element,
	scope: ParsedXFormScope,
	local: string,
): Element[] {
	return element.children
		.filter(isTag)
		.filter(
			(child) =>
				elementNamespace(child, scope(child)) === XFORMS_NS &&
				splitName(child.name).local === local,
		);
}

/**
 * Whether a control's label carries media, read from the source: its `jr:itext` text holds a
 * value of a media form, in any language. A container's label media is written nowhere on its
 * draft, so a section's rule reads it here.
 */
export function labelCarriesMedia(
	control: ControlNode,
	parsed: ParsedXForm,
): boolean {
	const label = xformsChildren(control.element, parsed.scope, "label")[0];
	const ref = label?.attribs.ref;
	if (ref === undefined || parsed.itext === undefined) return false;
	const reference = itextReference(ref);
	if (reference.kind !== "id") return false;
	return xformsChildren(parsed.itext, parsed.scope, "translation").some(
		(translation) =>
			xformsChildren(translation, parsed.scope, "text")
				.filter((text) => text.attribs.id === reference.id)
				.some((text) =>
					xformsChildren(text, parsed.scope, "value").some(
						(value) =>
							MEDIA_FORMS.has(value.attribs.form ?? "") &&
							ownText(value).trim() !== "",
					),
				),
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
 * Whether the form's root questions all become sections. Bodyless Connect activities keep their
 * submitted position without contributing a page. There is at least one question, every one is a
 * Question List, none has a bind `relevant` or label media, and none holds, at any depth, a
 * repeat whose rows the worker adds.
 */
export function rootSections(input: RootSectionsInput): boolean {
	const pages = input.root.filter((field) => field.kind !== "connect_activity");
	return (
		pages.length > 0 &&
		pages.every(
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
	/** Each data node's bind, whose `type` CommCare HQ's question reader reads a group by. */
	readonly binds: ReadonlyMap<DraftField["node"], BindFacts>;
	readonly sectioned: boolean;
	readonly childrenOf: (field: DraftField) => readonly DraftField[];
	readonly placeOf: (field: DraftField) => HqPlace;
	readonly intents: AppearanceForm;
	/** Appends a control's data path where its appearance was accounted under an inert entry. */
	readonly inertAppearance: (path: string) => void;
}

/**
 * Claims every group by the kind of group it is, turning each root Question List into a section where
 * `sectioned`, and refuses a repeat whose rows the worker adds anywhere under a Question List.
 */
export function readContainers(input: ReadContainersInput): void {
	const { cursor, accounting } = input;
	for (const { field, control } of input.groups) {
		const labelled = hasLabel(control, input.scope);
		const fieldList = isFieldListAppearance(control.appearance);
		const sites: {
			readonly node: Claim<"take">;
			/** The node's claim where CommCare HQ's question reader holds the Question List as a
			 *  Group: its appearance is `field-list` in another letter case. */
			readonly nodeAsGroup?: Claim<"take">;
			readonly control: Claim<"take">;
			readonly ref: Claim<"take">;
			readonly appearance?: Claim<"take">;
		} = fieldList
			? labelled
				? X.questionList
				: input.sectioned && field.parent === null
					? X.sectionQuestionList
					: X.unlabelledQuestionList
			: labelled
				? X.group
				: X.unlabelledGroup;
		if (fieldList && input.sectioned && field.parent === null) {
			field.kind = "section";
			delete field.field.fieldList;
		}
		const hqType = hqQuestionType({
			tag: control.tag,
			type: input.binds.get(field.node)?.type,
			mediaType: control.mediaType,
			appearance: control.appearance,
		});
		cursor.take(
			{ element: field.node.element },
			hqType === "Group" && sites.nodeAsGroup !== undefined
				? sites.nodeAsGroup
				: sites.node,
		).value;
		cursor.take({ element: control.element }, sites.control).value;
		if (control.path === "ref" || control.path === "nodeset")
			cursor.take(
				{ element: control.element, attribute: control.path },
				sites.ref,
			).value;
		const place = input.placeOf(field);
		// A group inside a Question List, at any depth, is one HQ's form builder holds by its
		// own feature as well as by its row.
		if (insideQuestionList(field))
			accounting.claimEntry(
				{ element: control.element },
				X.groupInQuestionList.entry,
				X.groupInQuestionList.key as string,
				place,
			);
		if (control.appearance !== undefined) {
			if (fieldList && sites.appearance !== undefined)
				cursor.take(
					{ element: control.element, attribute: "appearance" },
					sites.appearance,
				).value;
			else if (
				claimAppearance(
					cursor,
					accounting,
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

/** Whether a container above the field is a Question List, or a section, which is one. */
function insideQuestionList(field: DraftField): boolean {
	for (let at = field.parent; at !== null; at = at.parent)
		if (at.kind === "section" || at.field.fieldList === true) return true;
	return false;
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
		) {
			// The class is a fact about the `<repeat>` element, so the refusal stands there too.
			const control = child.control;
			if (control?.tag === "repeat")
				accounting.findingAtNode(
					X.userRepeatInQuestionList,
					input.placeOf(child),
					{ element: control.element },
					"xform:repeat",
				);
			else accounting.finding(X.userRepeatInQuestionList, input.placeOf(child));
		}
		refuseUserRepeats(child, input, accounting);
	}
}
