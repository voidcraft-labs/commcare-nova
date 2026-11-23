import { isCaptureFieldKind } from "@/lib/domain/fields";
/**
 * A form's text, read by the slot that references it, and, once
 * the expression stage bound the source language's outputs, its translations.
 * A `value` element's children become prose parts in order: a text
 * node as written, an `<output>` that is the emitter's spelling of literal
 * text (a whitespace run, or the bracket of text CommCare HQ's build would read
 * as an instance) as that text, and any other output as a value part the
 * expression stage binds. No logic is read here as text.
 */

import type { ChildNode, Element } from "domhandler";
import { isTag } from "domhandler";
import type { Draft } from "immer";
import {
	type BlueprintDoc,
	canonicalProseTemplate,
	caseScalarTextGuards,
	effectiveAppLocalization,
	expressionSlotValue,
	type LanguageTag,
	type ProsePart,
	type ProseTemplate,
	proseText,
	type TranslationEntry,
	type Uuid,
} from "@/lib/domain";
import type { ItextUnit } from "@/lib/domain/expression/types";
import { fieldKindDeclaresKey } from "@/lib/domain/fields";
import {
	makeTranslationUnitId,
	translationSourceFingerprint,
} from "@/lib/domain/localization";
import { EMPTY_PROSE_TEMPLATE, proseTemplateIsEmpty } from "@/lib/domain/prose";
import {
	filledProse,
	TRANSLATION_FILL_ROLES,
	translationFillSource,
} from "@/lib/domain/translationFill";
import {
	itextUnitTranslationId,
	snapshotTranslationUnits,
	type TranslationUnit,
	translationValueIntegrityIssue,
} from "@/lib/domain/translationUnits";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { parseHqJsonText } from "../../hq/jsonText";
import { placedBasic } from "../../placement";
import { type SourceTable, tableOf } from "../../sourceKeys";
import { rethrowWorkStop } from "../../workMeter";
import { buildLabelNodes } from "../../xform/builder";
import { bindCarriesConstraint } from "../../xform/constraintMessage";
import { isConsumerWhitespace } from "../../xform/consumerWhitespace";
import {
	elementNamespace,
	JAVAROSA_NS,
	type NamespaceScope,
	splitName,
	XFORMS_NS,
	XHTML_NS,
} from "../../xmlNamespaces";
import { InstanceSink } from "../../xpath/wire/instances";
import type { Accounting } from "../accounting";
import { withCandidate } from "../candidate";
import type { DraftForm, ReadContext } from "../context";
import { readerDefect } from "../defects";
import { pointerToken, sameJson } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { attributesByName, sameAttributeMaps } from "../sameElement";
import { sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import { translationEntryFor } from "../translations";
import type { ItextRecipient } from "../types";
import { ownText, type XmlCursor, type XmlNode } from "../xmlCursor";
import type { ControlNode } from "./body";
import { TEXT_CONTROLS, type TextControl, X } from "./claims";
import { carrierTextId } from "./generated";
import type { DraftField, ReadXForm } from "./index";
import {
	type ItextOwner,
	type ItextReading,
	itextIdsRead,
	itextRecipient,
	itextReference,
	sameValueNodes,
	settleItext,
	type TextSlot,
} from "./itext";
import { standInRefusal } from "./logic";
import type { BindFacts, DataNode } from "./model";
import type { FormRefusals, StandingRefusal } from "./refusals";

/** The surface key a source output's value is registered under. */
export const OUTPUT_VALUE_KEY =
	"xform:model/itext/translation/text/value/output@value";

const XFORM_MODE = { target: "xform", constraint: false } as const;

// ── Literal outputs ──────────────────────────────────────────────────────

/**
 * The text an output's `value` stands for where it is one of the emitter's two literal
 * spellings, read over the XPath grammar's tree: one string literal (a whitespace run, or a
 * bracket), or `json-property(<string>, 'v')` whose first string is JSON holding one string
 * member `v` (a run of Unicode whitespace). Undefined for any other value.
 */
export function literalOutputText(value: string): string | undefined {
	const read = readFormSyntax(value);
	const node = read.ok ? read.node : undefined;
	if (node === undefined) return undefined;
	if (node.kind === "string") return node.value;
	if (
		node.kind !== "call" ||
		node.name !== "json-property" ||
		node.args.length !== 2 ||
		node.args[0]?.kind !== "string" ||
		node.args[1]?.kind !== "string" ||
		node.args[1].value !== "v"
	)
		return undefined;
	let parsed: unknown;
	try {
		parsed = parseHqJsonText(node.args[0].value);
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return undefined;
	const keys = Object.keys(parsed);
	const member = (parsed as Record<string, unknown>).v;
	return keys.length === 1 && keys[0] === "v" && typeof member === "string"
		? member
		: undefined;
}

// ── A value's parts ──────────────────────────────────────────────────────

/** An output of a value: the attribute it is written with and its text. */
export interface SourceOutput {
	readonly element: Element;
	readonly attribute: "value" | "ref";
	readonly text: string;
}

/** A part of a value as the reader takes it. */
export type ValuePart =
	| { readonly kind: "text"; readonly text: string }
	/** An output read as the literal text it spells. */
	| {
			readonly kind: "literal";
			readonly output: SourceOutput;
			readonly text: string;
	  }
	| { readonly kind: "output"; readonly output: SourceOutput };

/** One language's default value of a text. */
export interface ReadValue {
	readonly element: Element;
	readonly parts: readonly ValuePart[];
}

function printedNodes(text: string): readonly ChildNode[] {
	return buildLabelNodes(
		proseText(text),
		() => {
			throw new Error("A literal text has no reference to lower.");
		},
		{ mode: XFORM_MODE, instances: new InstanceSink() },
	);
}

/** Whether the emitter's nodes for a run of text are the source's, node for node. */
function samePrint(
	printed: readonly ChildNode[],
	source: readonly (
		| { readonly kind: "text"; readonly text: string }
		| { readonly kind: "output"; readonly output: SourceOutput }
	)[],
): boolean {
	if (printed.length !== source.length) return false;
	return printed.every((node, index) => {
		const held = source[index];
		if (held === undefined) return false;
		if (node.type === "text")
			return held.kind === "text" && node.data === held.text;
		if (!isTag(node) || node.name !== "output" || held.kind !== "output")
			return false;
		const value = node.attribs.value;
		return (
			value !== undefined &&
			sameXPathText(value, held.output.text, { ruleSet: "form" })
		);
	});
}

/**
 * The parts of a value's children, every literal output confirmed by the print: a run of
 * text and candidate outputs between two other outputs reads as its text where the emitter
 * writes the run back node for node; otherwise each candidate reads as text where the emitter
 * writes it alone back as that output, and is kept as the value it is where it does not.
 */
export function valueParts(
	children: readonly (
		| { readonly kind: "text"; readonly text: string }
		| { readonly kind: "output"; readonly output: SourceOutput }
	)[],
): ValuePart[] {
	const parts: ValuePart[] = [];
	let run: (typeof children)[number][] = [];
	const flush = () => {
		const candidates = run.filter(
			(part) =>
				part.kind === "output" &&
				literalOutputText(part.output.text) !== undefined,
		);
		if (candidates.length === 0) {
			for (const part of run) parts.push(part);
			run = [];
			return;
		}
		const whole = run
			.map((part) =>
				part.kind === "text"
					? part.text
					: (literalOutputText(part.output.text) as string),
			)
			.join("");
		const wholeRead = samePrint(printedNodes(whole), run);
		for (const part of run) {
			if (part.kind === "text") {
				parts.push(part);
				continue;
			}
			const literal = literalOutputText(part.output.text);
			if (
				literal !== undefined &&
				(wholeRead || samePrint(printedNodes(literal), [part]))
			)
				parts.push({ kind: "literal", output: part.output, text: literal });
			else parts.push(part);
		}
		run = [];
	};
	for (const child of children) {
		if (
			child.kind === "output" &&
			literalOutputText(child.output.text) === undefined
		) {
			flush();
			parts.push(child);
			continue;
		}
		run.push(child);
	}
	flush();
	return parts;
}

/** Whether a value shows nothing: no text and no output. */
export function valueIsBlank(value: ReadValue): boolean {
	return value.parts.every(
		(part) => part.kind !== "output" && part.text === "",
	);
}

/**
 * Whether a value's text holds what Web Apps reads as markup. Web Apps writes a
 * plain label into the page as HTML (`cloudcare/js/form_entry/form_ui.js`, the
 * `caption` sanitized by DOMPurify, then knockout's `html` binding), where the
 * HTML tokenizer's data state opens a tag or a comment at a `<` before an ASCII
 * letter, `/`, `!` or `?`, and reads a character reference at `&#` before a
 * digit or `x`, or at `&` before a name ended by `;`. Android shows the text as
 * written.
 */
export function holdsHtmlText(value: ReadValue): boolean {
	const text = value.parts
		.map((part) => (part.kind === "output" ? "" : part.text))
		.join("");
	const letter = (at: string | undefined) =>
		at !== undefined && /^[A-Za-z]$/.test(at);
	const digit = (at: string | undefined) =>
		at !== undefined && at >= "0" && at <= "9";
	for (let index = 0; index < text.length; index++) {
		const next = text[index + 1];
		if (
			text[index] === "<" &&
			(letter(next) || next === "/" || next === "!" || next === "?")
		)
			return true;
		if (text[index] !== "&") continue;
		if (
			next === "#" &&
			(digit(text[index + 2]) ||
				text[index + 2] === "x" ||
				text[index + 2] === "X")
		)
			return true;
		let end = index + 1;
		while (end < text.length && (letter(text[end]) || digit(text[end])))
			end += 1;
		if (end > index + 1 && letter(next) && text[end] === ";") return true;
	}
	return false;
}

/** The template a value's parts make, each output that is no literal a placeholder value. */
export function placeholderTemplate(
	parts: readonly ValuePart[],
): ProseTemplate {
	return canonicalProseTemplate(
		parts.map(
			(part): ProsePart =>
				part.kind === "output"
					? { kind: "value", expression: pendingPlaceholder("value") }
					: { kind: "text", text: part.text },
		),
	);
}

interface ValueContext {
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly scope: (element: Element) => NamespaceScope;
	readonly place: HqPlace;
}

/** A `value` element's children: its parts, and the elements no part is made of, an XHTML
 *  element apart from any other. Claims nothing. */
export function valueChildren(
	value: Element,
	scope: (element: Element) => NamespaceScope,
): {
	readonly parts: readonly ValuePart[];
	readonly xhtml: readonly Element[];
	readonly other: readonly Element[];
} {
	const children: (
		| { readonly kind: "text"; readonly text: string }
		| { readonly kind: "output"; readonly output: SourceOutput }
	)[] = [];
	const xhtml: Element[] = [];
	const other: Element[] = [];
	for (const child of value.children) {
		if (child.type === "text") {
			if (!isConsumerWhitespace(child.data))
				children.push({ kind: "text", text: child.data });
			continue;
		}
		if (!isTag(child)) continue;
		const namespace = elementNamespace(child, scope(child));
		if (namespace === XHTML_NS) xhtml.push(child);
		else if (
			namespace !== XFORMS_NS ||
			splitName(child.name).local !== "output"
		)
			other.push(child);
		else {
			const attribute = Object.hasOwn(child.attribs, "ref") ? "ref" : "value";
			children.push({
				kind: "output",
				output: {
					element: child,
					attribute,
					text: child.attribs[attribute] ?? "",
				},
			});
		}
	}
	return { parts: valueParts(children), xhtml, other };
}

/**
 * Reads a `value` element's children into parts and, where `claim` holds, claims what needs no
 * binding: an XHTML child refused, another element inert, each literal output read past as the
 * text it spells. An output that is no literal is left to its language's reader.
 */
function readValue(
	value: Element,
	context: ValueContext,
	claim: boolean,
): ReadValue {
	const { cursor, scope, place } = context;
	const read = valueChildren(value, scope);
	if (claim) {
		for (const child of read.xhtml)
			cursor.refuseSubtree(child, X.xhtmlChild, place);
		for (const child of read.other) cursor.dropSubtree(child, X.otherChild);
		for (const part of read.parts)
			if (part.kind === "literal") claimLiteral(cursor, part.output);
	}
	return { element: value, parts: read.parts };
}

/** Claims an output element and its namespace, which Core reads of every element a value
 *  holds. */
function claimOutputElement(cursor: XmlCursor, element: Element): void {
	cursor.derived({ element }, X.output);
	cursor.derived({ element, attribute: "xmlns" }, X.outputNamespace);
}

function claimLiteral(cursor: XmlCursor, output: SourceOutput): void {
	claimOutputElement(cursor, output.element);
	if (output.attribute === "ref")
		cursor.take({ element: output.element, attribute: "ref" }, X.outputRef)
			.value;
	else
		cursor.derived(
			{ element: output.element, attribute: "value" },
			X.literalOutput,
		);
}

/** Claims an output of the source language registered for the expression stage: its element,
 *  and a `ref` it is written with. The value is the expression stage's to claim. */
function claimSourceOutput(cursor: XmlCursor, output: SourceOutput): void {
	claimOutputElement(cursor, output.element);
	if (output.attribute === "ref")
		cursor.take({ element: output.element, attribute: "ref" }, X.outputRef)
			.value;
}

// ── The texts of a form ──────────────────────────────────────────────────

/** One slot's text as the form stage read it. */
export interface SlotText {
	readonly owner: ItextOwner;
	readonly place: HqPlace;
	/** The itext id it references; undefined for a label written inline. */
	readonly id: string | undefined;
	/** Whether this slot is the first that references its id: it claims the text. */
	readonly first: boolean;
	/** The language whose value the slot holds: the source language, or the form's default
	 *  language where the source's value is blank beside the default's text (the form builder's
	 *  fill) or the form holds no source value (Core shows the default's there). */
	readonly own: LanguageTag;
	/** Each app language's default value, the source language's among them. */
	readonly values: ReadonlyMap<LanguageTag, ReadValue>;
	/** The outputs of the slot's own value registered for the expression stage, in part order. */
	readonly registered: readonly SourceOutput[];
	/** Whether the slot holds media Nova reads (a question's label and help, a choice). */
	readonly media: "label_media" | "help_media" | "option_media" | "unheld";
	/** Every value of each form but the default, by language: what the media reader reads. */
	readonly forms: ReadonlyMap<LanguageTag, ReadonlyMap<string, Element>>;
	/** Set where the text holds a finding that leaves its translations unread. */
	readonly refused: boolean;
	/** Each markdown copy that stands beside its language's value, read into parts: each output
	 *  it holds is claimed as its value's twin is, once the expression stage bound the source's. */
	readonly copies: readonly ReadValue[];
}

/** A validation message Nova composes in its question's bind: the question, the text its
 *  carrier owns, and the bind attribute that holds the composed expression, which stage 10
 *  compares once the text's outputs are bound. */
export interface ProtectedMessage {
	readonly field: DraftField;
	readonly textId: string;
	readonly bind: Element;
	readonly attribute: string;
}

export interface FormText {
	readonly slots: readonly SlotText[];
	readonly protectedMessages: readonly ProtectedMessage[];
	readonly itext: ItextReading;
	/** The values blank in a language other than the first whose first-language text is not. */
	readonly blankTranslations: number;
	readonly blankTranslationSlots?: readonly ItextRecipient[];
	readonly cursor: XmlCursor;
}

const FORM_TEXTS = new WeakMap<ReadXForm, FormText>();

/** Keeps a form's text for the stages after the forms stage. */
export function rememberFormText(xform: ReadXForm, text: FormText): void {
	FORM_TEXTS.set(xform, text);
}

/** What the forms stage read of a form's text; undefined before it ran. */
export function formText(xform: ReadXForm): FormText | undefined {
	return FORM_TEXTS.get(xform);
}

/** The itext values blank in a non-first language that read as no translation, for
 *  `ReadFormFacts.blankTranslations`. */
export function formBlankTranslations(xform: ReadXForm) {
	const text = FORM_TEXTS.get(xform);
	return {
		blankTranslations: text?.blankTranslations ?? 0,
		...(text?.blankTranslationSlots?.length && {
			blankTranslationSlots: text.blankTranslationSlots,
		}),
	};
}

/**
 * The document without each validation message no export holds: the message of a question whose
 * bind carries no constraint, with its translations. The emitter writes no message there
 * (`constraintMessage.ts::bindCarriesConstraint`), since no runtime shows one, so the reading of
 * the export has none.
 */
export function messagesWithNoConditionAbsent(doc: BlueprintDoc): BlueprintDoc {
	const unwritten: Uuid[] = [];
	for (const formUuid of Object.keys(doc.forms) as Uuid[]) {
		const guards = caseScalarTextGuards(doc, formUuid, {
			placedBasic: placedBasic(doc, formUuid),
		});
		const walk = (parent: Uuid) => {
			for (const uuid of doc.fieldOrder[parent] ?? []) {
				const field = doc.fields[uuid];
				if (
					field !== undefined &&
					(field as { validate_msg?: unknown }).validate_msg !== undefined &&
					!bindCarriesConstraint(
						field.kind,
						expressionSlotValue(doc, {
							entity: "field",
							uuid,
							slot: "validate",
						}),
						guards.get(uuid),
					)
				)
					unwritten.push(uuid);
				walk(uuid);
			}
		};
		walk(formUuid);
	}
	if (unwritten.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const uuid of unwritten) {
			delete (draft.fields[uuid] as { validate_msg?: unknown }).validate_msg;
			const unit = makeTranslationUnitId("field", uuid, "validate_msg");
			for (const entries of Object.values(
				draft.localization?.translations ?? {},
			))
				delete entries[unit];
		}
	});
}

/** The text slots a question may leave unset, each printed as nothing where it is blank. */
const OPTIONAL_TEXT: ReadonlySet<ItextOwner["slot"]> = new Set([
	"hint",
	"help",
	"validate_msg",
	"addFirstLabel",
	"addLabel",
]);

/**
 * Whether a text blank in every language prints as none does, so a reading reads it as none: a
 * hint, a help text or a validation message, and a group's, repeat's or section's label, which
 * `builder.ts` writes no `<label>` for (the canonical row `blank-container-label-is-absent`).
 */
function blankPrintsAsNone(owner: ItextOwner): boolean {
	return (
		OPTIONAL_TEXT.has(owner.slot) ||
		(owner.slot === "label" &&
			(CONTAINER_KINDS as ReadonlySet<string>).has(owner.field.kind))
	);
}

/**
 * The document without each hint, help text and validation message blank in every language, and
 * without its translations. `builder.ts::buildFieldParts` gives an unset text the template of no
 * parts, so the two print one source: no entry for a blank text, and for a help text with media
 * the entry of its media alone. A reading reads such a text as unset (`readSlotText`).
 */
export function blankOptionalTextAbsent(doc: BlueprintDoc): BlueprintDoc {
	const translations = Object.values(doc.localization?.translations ?? {});
	const blank: { uuid: Uuid; slot: ItextOwner["slot"] }[] = [];
	for (const [uuid, field] of Object.entries(doc.fields) as [
		Uuid,
		BlueprintDoc["fields"][Uuid],
	][])
		for (const slot of OPTIONAL_TEXT) {
			const template = (field as Record<string, unknown>)[slot] as
				| ProseTemplate
				| undefined;
			if (template === undefined || !proseTemplateIsEmpty(template)) continue;
			const unit = makeTranslationUnitId("field", uuid, slot);
			if (
				translations.every((entries) => {
					const entry = entries[unit];
					return (
						entry === undefined ||
						proseTemplateIsEmpty(entry.value as ProseTemplate)
					);
				})
			)
				blank.push({ uuid, slot });
		}
	if (blank.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const { uuid, slot } of blank) {
			delete (draft.fields[uuid] as Record<string, unknown>)[slot];
			const unit = makeTranslationUnitId("field", uuid, slot);
			for (const entries of Object.values(
				draft.localization?.translations ?? {},
			))
				delete entries[unit];
		}
	});
}

/** The slot of a question's text, by its translation role. */
const FILL_SLOT_OF: SourceTable<TextSlot> = tableOf({
	"field-label": "label",
	"field-hint": "hint",
	"field-help": "help",
	"field-validation-message": "validate_msg",
	"field-first-add-label": "addFirstLabel",
	"field-add-label": "addLabel",
});

/** Writes a form text's source value into its slot: a question's label, hint, help text or
 *  validation message, or a choice's label. */
function writeSourceProse(
	draft: Draft<BlueprintDoc>,
	unit: TranslationUnit,
	value: ProseTemplate,
): void {
	const owner = unit.owner;
	if (owner.kind === "select-option") {
		const field = draft.fields[owner.fieldUuid] as
			| { optionsSource?: { options?: { uuid: Uuid; label: unknown }[] } }
			| undefined;
		const option = field?.optionsSource?.options?.find(
			(one) => one.uuid === owner.optionUuid,
		);
		if (option !== undefined) option.label = value;
		return;
	}
	if (owner.kind !== "field") return;
	const slot = FILL_SLOT_OF.get(unit.role);
	const field = draft.fields[owner.fieldUuid] as
		| Record<string, unknown>
		| undefined;
	if (slot !== undefined && field !== undefined) field[slot] = value;
}

/**
 * The document with each blank value of a form's text in a language replaced by the text a
 * worker reads there, the form builder's fill (`translationFill.ts::filledProse`): a blank source
 * value takes the filled text into its slot, and a blank translation the filled text, which is
 * then no translation where it equals the source. The export writes every language's filled text
 * (`builder.ts`), so both documents print one source, and a reading of it reads the filled text in
 * every language. A text blank in every language is left as it is; each other translation of a
 * text whose source changed is kept, fingerprinted to the new source and read as reviewed, as the
 * reading gives it.
 */
export function blankItextFilled(doc: BlueprintDoc): BlueprintDoc {
	const localization = doc.localization;
	if (localization === undefined) return doc;
	const order = effectiveAppLocalization(localization).languageOrder;
	const source = localization.sourceLanguage;
	const changes: {
		readonly unit: TranslationUnit;
		readonly filled: ReadonlyMap<LanguageTag, ProseTemplate>;
	}[] = [];
	for (const unit of snapshotTranslationUnits(doc).values()) {
		if (!TRANSLATION_FILL_ROLES.has(unit.role)) continue;
		if (
			!order.some(
				(language) => translationFillSource(doc, unit, language) !== undefined,
			)
		)
			continue;
		changes.push({
			unit,
			filled: new Map(
				order.map((language) => [language, filledProse(doc, unit, language)]),
			),
		});
	}
	if (changes.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const { unit, filled } of changes) {
			const next = filled.get(source);
			if (next === undefined) continue;
			if (!sameJson(next, unit.source)) writeSourceProse(draft, unit, next);
			const sourceFingerprint = translationSourceFingerprint("prose", next);
			for (const [language, value] of filled) {
				if (language === source) continue;
				const entries = draft.localization?.translations[language];
				if (entries === undefined) continue;
				if (sameJson(value, next)) {
					delete entries[unit.id];
					continue;
				}
				const held = entries[unit.id];
				if (
					held !== undefined &&
					sameJson(held.value, value) &&
					held.sourceFingerprint === sourceFingerprint
				)
					continue;
				entries[unit.id] = {
					value,
					sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: source,
				} as Draft<TranslationEntry>;
			}
		}
	});
}

export interface ReadTextInput {
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly scope: (element: Element) => NamespaceScope;
	readonly formPlace: HqPlace;
	/** Every field of the form, in document order. */
	readonly fields: readonly DraftField[];
	readonly binds: ReadonlyMap<DraftField["node"], BindFacts>;
	/** Every bind and every control of the form, for the ids a node no field owns references. */
	readonly allBinds: readonly Element[];
	readonly body: Element;
	readonly setvalues: readonly { readonly value: string | undefined }[];
	readonly itext: ItextReading;
	/** The form's text formatting switch is off (`vellum:ignore` holds `markdown`). */
	readonly plainText: boolean;
	/** The control of the generated carrier that owns a question's protected validation
	 *  message, by the question's node. */
	readonly carrierOf: (owner: DataNode) => ControlNode | undefined;
	/** The refusals the form's reading made, which a text a refused control names stands under. */
	readonly refusals: FormRefusals;
}

/** A reference a slot makes: the element that holds it and, where it is one, its `ref`. */
interface Reference {
	readonly owner: ItextOwner;
	readonly place: HqPlace;
	/** The element that holds the reference. */
	readonly element?: Element;
	readonly id?: string;
	/** A label written inline: its text in the source language. */
	readonly inline?: string;
	/** Claims the reference: `plain` where the text holds no markdown copy, `inline` where the
	 *  element holds its text itself. */
	readonly claim: (cursor: XmlCursor, plain: boolean, inline: boolean) => void;
}

function xformsChildren(
	element: Element,
	scope: (element: Element) => NamespaceScope,
): { readonly element: Element; readonly local: string }[] {
	return element.children
		.filter(isTag)
		.filter((child) => elementNamespace(child, scope(child)) === XFORMS_NS)
		.map((child) => ({ element: child, local: splitName(child.name).local }));
}

const CONTAINER_KINDS = new Set(["group", "repeat", "section"]);

/** Every jr:itext id the form's logic, setvalues, outputs, itemset nodesets and repeat counts
 *  read: every text the expression stage is handed. */
function idsReadByExpressions(input: ReadTextInput): Set<string> {
	const read = new Set<string>();
	for (const bind of input.allBinds)
		for (const name of [
			"relevant",
			"constraint",
			"calculate",
			"required",
			"readonly",
		])
			if (bind.attribs[name] !== undefined)
				itextIdsRead(bind.attribs[name] as string, read);
	for (const setvalue of input.setvalues)
		if (setvalue.value !== undefined) itextIdsRead(setvalue.value, read);
	const walk = (element: Element) => {
		const local = splitName(element.name).local;
		if (local === "output")
			for (const name of ["value", "ref"])
				if (element.attribs[name] !== undefined)
					itextIdsRead(element.attribs[name] as string, read);
		if (local === "itemset" && element.attribs.nodeset !== undefined)
			itextIdsRead(element.attribs.nodeset, read);
		if (local === "repeat")
			for (const [name, value] of Object.entries(element.attribs))
				if (splitName(name).local === "count" && splitName(name).prefix !== "")
					itextIdsRead(value, read);
		for (const child of element.children) if (isTag(child)) walk(child);
	};
	const itext = input.itext;
	for (const id of itext.ids())
		for (const text of itext.texts(id).values()) walk(text);
	// The body's outputs, itemset nodesets and repeat counts.
	walk(input.body);
	return read;
}

/** Whether a `jr:constraintMsg` is a protected message: it reads an itext form whose
 *  name Nova's protected message gives. That reader claims it. */
function isProtectedMessage(text: string): boolean {
	const ids = new Set<string>();
	itextIdsRead(text, ids);
	return [...ids].some((id) => id.includes(";__nova_"));
}

/** The ids every control and every `jr:constraintMsg` of the form references, each with the
 *  nodes that reference it. */
function referencesAnywhere(input: ReadTextInput): Map<string, XmlNode[]> {
	const sites = new Map<string, XmlNode[]>();
	const add = (id: string, node: XmlNode) => {
		const known = sites.get(id);
		if (known === undefined) sites.set(id, [node]);
		else known.push(node);
	};
	const walk = (element: Element) => {
		const ref = element.attribs.ref;
		const local = splitName(element.name).local;
		if (
			ref !== undefined &&
			(local === "label" ||
				local === "hint" ||
				local === "help" ||
				local === "alert")
		) {
			const reference = itextReference(ref);
			if (reference.kind !== "other")
				add(reference.id, { element, attribute: "ref" });
		}
		for (const child of element.children) if (isTag(child)) walk(child);
	};
	walk(input.body);
	for (const bind of input.allBinds)
		for (const [name, value] of Object.entries(bind.attribs))
			if (splitName(name).local === "constraintMsg") {
				const reference = itextReference(value);
				if (reference.kind !== "other")
					add(reference.id, { element: bind, attribute: name });
				else {
					const read = new Set<string>();
					itextIdsRead(value, read);
					for (const id of read) add(id, { element: bind, attribute: name });
				}
			}
	return sites;
}

/**
 * The refusal a text no slot owns stands under: the one over every node that references it,
 * where each does stand under one, since a text a refused control or message names belongs to
 * what was refused. Undefined where some reference stands under none (a node Nova generates,
 * whose reader claims the text).
 */
function refusedReferences(
	input: ReadTextInput,
	sites: ReadonlyMap<string, readonly XmlNode[]>,
): (id: string) => StandingRefusal | undefined {
	return (id) => {
		const nodes = sites.get(id) ?? [];
		let first: StandingRefusal | undefined;
		for (const node of nodes) {
			const refusal = input.refusals.over(node);
			if (refusal === undefined) return undefined;
			first ??= refusal;
		}
		return first;
	};
}

function controlTag(field: DraftField): TextControl | undefined {
	const tag = field.control?.tag;
	return TEXT_CONTROLS.includes(tag as TextControl)
		? (tag as TextControl)
		: undefined;
}

/**
 * Reads the references every field's control and bind make, the texts they name, and each
 * text's forms but media, which `media.ts` reads. Sets each slot's source-language template on
 * its draft, with a placeholder where an output waits for the expression stage, and pushes
 * each such output as the field's draft expression.
 */
export function readText(input: ReadTextInput): FormText {
	const { cursor, scope, itext } = input;
	const references: Reference[] = [];
	const protectedMessages: ProtectedMessage[] = [];

	for (const field of input.fields) {
		if (field.standIn) {
			coverStandIn(input, field);
			continue;
		}
		const control = field.control;
		const place = field.place;
		const container = CONTAINER_KINDS.has(field.kind);
		const tag = controlTag(field);
		// The label of a repeat stands on its wrapper group.
		const labelHolder =
			field.kind === "repeat" &&
			control?.parent !== undefined &&
			control.parent !== null
				? control.parent.element
				: control?.element;
		if (labelHolder !== undefined)
			for (const child of xformsChildren(labelHolder, scope)) {
				if (child.local !== "label") continue;
				references.push(
					reference(
						input,
						{ field, slot: "label" },
						place,
						child.element,
						(c, _plain, inline) => {
							if (container) {
								c.take({ element: child.element }, X.groupLabel.label).value;
								claimRef(c, child.element, X.groupLabel.ref);
							} else if (tag !== undefined && inline)
								c.take({ element: child.element }, X.inlineLabel[tag]).value;
							else if (tag !== undefined) {
								c.take({ element: child.element }, X.labelRef[tag]).value;
								claimRef(c, child.element, X.labelRef[`${tag}Ref`]);
							}
						},
					),
				);
			}
		if (field.kind === "repeat" && control !== undefined) {
			for (const child of control.element.children.filter(isTag)) {
				if (elementNamespace(child, scope(child)) !== JAVAROSA_NS) continue;
				const tag = splitName(child.name).local;
				if (tag !== "addCaption" && tag !== "addEmptyCaption") continue;
				references.push(
					reference(
						input,
						{
							field,
							slot: tag === "addEmptyCaption" ? "addFirstLabel" : "addLabel",
						},
						place,
						child,
						(c) => {
							c.take({ element: child }, X.addCaptions[tag]).value;
							claimRef(
								c,
								child,
								X.addCaptions[
									tag === "addEmptyCaption"
										? "addEmptyCaptionRef"
										: "addCaptionRef"
								],
							);
						},
					),
				);
			}
		}
		if (control !== undefined && tag !== undefined) {
			let alert: Element | undefined;
			for (const child of xformsChildren(control.element, scope)) {
				if (child.local === "hint") {
					const hint = field.kind === "label" ? X.hintOnLabel : X.hint;
					references.push(
						reference(
							input,
							{ field, slot: "hint" },
							place,
							child.element,
							(c) => {
								c.take({ element: child.element }, hint[tag]).value;
								claimRef(c, child.element, hint[`${tag}Ref`]);
							},
						),
					);
				} else if (child.local === "help") {
					const help =
						field.kind === "label" || isCaptureFieldKind(field.kind)
							? X.helpOnCapture
							: X.help;
					// A help text that holds its own content and no `ref` is the text Core shows
					// (`FormEntryPrompt.localizeText` reads the inner text where the element names
					// no text id), a text CommCare HQ's form builder loses on load
					// (`javaRosa/plugin.js` reads a help element's `ref` alone, and `createHelp`
					// writes a help only through its text). No entry names it, so it is left for the
					// close to report, as an alert written inline is.
					if (
						child.element.attribs.ref === undefined &&
						holdsContent(child.element)
					)
						continue;
					references.push(
						reference(
							input,
							{ field, slot: "help" },
							place,
							child.element,
							(c) => {
								c.take({ element: child.element }, help[tag]).value;
								claimRef(c, child.element, help[`${tag}Ref`]);
							},
						),
					);
				} else if (child.local === "alert") alert = child.element;
				else if (child.local === "setvalue" || child.local === "send")
					cursor.refuseSubtree(
						child.element,
						X.actionInControl[child.local],
						place,
					);
			}
			for (const child of control.element.children.filter(isTag))
				if (splitName(child.name).local === "pollsensor")
					cursor.refuseSubtree(child, X.actionInControl.pollsensor, place);
			readValidationMessage(
				input,
				field,
				tag,
				alert,
				references,
				protectedMessages,
			);
			field.items?.forEach((item, option) => {
				const label = xformsChildren(item, scope).find(
					(child) => child.local === "label",
				);
				const select = control.tag === "select1" ? "select1" : "select";
				// The choices reader refused an item with no label; every item it read holds one.
				if (label === undefined) return;
				references.push(
					reference(
						input,
						{ field, slot: "option_label", option },
						place,
						label.element,
						(c, plain) => {
							const claims = plain ? X.choiceLabelPlain : X.choiceLabel;
							c.take({ element: label.element }, claims[select]).value;
							claimRef(c, label.element, claims[`${select}Ref`]);
						},
					),
				);
			});
		}
	}

	const slots: SlotText[] = [];
	let blankTranslations = 0;
	const blankTranslationSlots: ItextRecipient[] = [];
	const firstOwner = new Map<string, Reference>();
	for (const ref of references) {
		if (ref.id !== undefined && !firstOwner.has(ref.id))
			firstOwner.set(ref.id, ref);
		if (ref.id !== undefined) itext.own(ref.id, ref.owner);
	}
	for (const ref of references) {
		const first = firstOwner.get(ref.id ?? "") === ref || ref.id === undefined;
		const read = readSlotText(input, ref, first);
		// One physical itext value can supply several questions or choices.
		if (first) blankTranslations += read.blanks.length;
		for (const language of read.blanks)
			blankTranslationSlots.push(itextRecipient(ref.owner, language));
		if (read.slot !== undefined) slots.push(read.slot);
	}

	const elsewhere = referencesAnywhere(input);
	settleItext(itext, {
		cursor,
		formPlace: input.formPlace,
		placeOf: (owner) => owner.field.place,
		readByExpressions: idsReadByExpressions(input),
		elsewhere: new Set(elsewhere.keys()),
		refusedReferences: refusedReferences(input, elsewhere),
	});

	return {
		slots,
		protectedMessages,
		itext,
		blankTranslations,
		blankTranslationSlots,
		cursor,
	};
}

function claimRef(
	cursor: XmlCursor,
	element: Element,
	claim: Parameters<XmlCursor["take"]>[1],
): void {
	if (Object.hasOwn(element.attribs, "ref"))
		cursor.take({ element, attribute: "ref" }, claim).value;
}

/** A reference of one text child: its id, or its inline text. */
function reference(
	input: ReadTextInput,
	owner: ItextOwner,
	place: HqPlace,
	element: Element,
	claim: Reference["claim"],
): Reference {
	const ref = element.attribs.ref;
	// A label, hint or choice label written inline holds its own text, which Core shows where
	// the element names no text id (`FormEntryPrompt.localizeText`); a help text reaches here
	// written inline only where it holds no content, and reads as blank. An element
	// inside it (an `<output>`) is a construct no manifest entry names there, left for the
	// close to report: neither Nova nor CommCare HQ's form builder writes one
	// (`writer.js::createLabel` writes an inline label as escaped text).
	if (ref === undefined)
		return { owner, place, element, inline: ownText(element), claim };
	const read = itextReference(ref);
	if (read.kind === "other") return { owner, place, element, claim };
	if (read.kind === "double-quoted")
		input.accounting.finding(X.duplicateTextId, place);
	return { owner, place, element, id: read.id, claim };
}

/**
 * The validation message: the bind's `jr:constraintMsg` and the control's `alert`, which name
 * one text. A message on a kind that holds none, or on a bind with no condition, is refused; a
 * literal message is refused. A protected message is read from the text its carrier's label
 * names, the label claimed as the carrier's, and its expression is left for stage 10.
 */
function readValidationMessage(
	input: ReadTextInput,
	field: DraftField,
	tag: TextControl,
	alert: Element | undefined,
	references: Reference[],
	protectedMessages: ProtectedMessage[],
): void {
	const { cursor, accounting } = input;
	const place = field.place;
	const bind = input.binds.get(field.node);
	const messageName =
		bind === undefined
			? undefined
			: Object.keys(bind.element.attribs).find(
					(name) =>
						splitName(name).local === "constraintMsg" &&
						splitName(name).prefix !== "",
				);
	const message =
		messageName === undefined ? undefined : bind?.element.attribs[messageName];
	if (message !== undefined && isProtectedMessage(message)) {
		const carrier = input.carrierOf(field.node);
		const label =
			carrier === undefined
				? undefined
				: xformsChildren(carrier.element, input.scope).find(
						(child) => child.local === "label",
					)?.element;
		const textId = carrier === undefined ? undefined : carrierTextId(carrier);
		// A message that reads Nova's forms with no carrier of Nova's is left unclaimed.
		if (
			label === undefined ||
			textId === undefined ||
			messageName === undefined ||
			bind === undefined ||
			!fieldKindDeclaresKey(field.kind, "validate_msg")
		)
			return;
		protectedMessages.push({
			field,
			textId,
			bind: bind.element,
			attribute: messageName,
		});
		references.push({
			owner: { field, slot: "validate_msg" },
			place: field.place,
			element: label,
			id: textId,
			claim: (c) => {
				c.take({ element: label }, X.labelRef.input).value;
				claimRef(c, label, X.labelRef.inputRef);
			},
		});
		return;
	}
	const messageNode =
		messageName === undefined || bind === undefined
			? undefined
			: { element: bind.element, attribute: messageName };
	// An alert that holds its own content and no `ref` is the message Core shows
	// (`FormEntryPrompt.getConstraintText` reads the alert first, and `localizeText` its inner
	// text where it names no text id), a message CommCare HQ's form builder loses on load
	// (`javaRosa/plugin.js` reads an alert's `ref` alone). No entry names it, so it is left
	// for the close to report, whatever the bind's message names.
	const held =
		alert !== undefined &&
		alert.attribs.ref === undefined &&
		holdsContent(alert)
			? undefined
			: alert;
	const claimAlert = (c: XmlCursor) => {
		if (held === undefined) return;
		c.take({ element: held }, X.alert[tag]).value;
		claimRef(c, held, X.alert[`${tag}Ref`]);
	};
	// A refused message is refused whole: the bind's message and the control's alert, and the
	// text they name (`itext.ts::settleItext`), stand under one finding.
	const refuseMessage = (
		claim: typeof X.messageWithoutConstraint | typeof X.literalConstraintMsg,
	) => {
		if (messageNode !== undefined) cursor.refuse(messageNode, claim, place);
		if (held !== undefined) cursor.refuseSubtree(held, claim, place);
	};

	if (
		bind?.logic.constraint === undefined &&
		(messageNode !== undefined || held !== undefined)
	) {
		refuseMessage(X.messageWithoutConstraint);
		return;
	}
	const messageRef =
		message === undefined ? undefined : itextReference(message);
	if (messageRef?.kind === "other" && messageNode !== undefined) {
		refuseMessage(X.literalConstraintMsg);
		return;
	}
	const alertRef =
		held?.attribs.ref === undefined
			? undefined
			: itextReference(held.attribs.ref);
	const ids = [messageRef, alertRef]
		.filter((one) => one !== undefined && one.kind !== "other")
		.map((one) => (one as { id: string }).id);
	if (new Set(ids).size > 1) return; // two ids for one message: left unclaimed
	const id = ids[0];
	if (id === undefined) {
		claimAlert(cursor);
		return;
	}
	if ([messageRef, alertRef].some((one) => one?.kind === "double-quoted"))
		accounting.finding(X.duplicateTextId, place);
	references.push({
		owner: { field, slot: "validate_msg" },
		place,
		id,
		claim: (c) => {
			if (messageNode !== undefined) {
				const kind = field.kind;
				c.take(
					messageNode,
					kind === "label" || kind === "geopoint" || isCaptureFieldKind(kind)
						? X.messageOnCapture
						: X.constraintMsg,
				).value;
			}
			claimAlert(c);
		},
	});
}

/** Whether an element holds content Core reads as its text: a child element, or a text node
 *  Core keeps (`XFormParser.getXMLDocument` removes one that is whitespace only). */
function holdsContent(element: Element): boolean {
	return element.children.some(
		(child) =>
			isTag(child) ||
			(child.type === "text" && !isConsumerWhitespace(child.data)),
	);
}

/** A stand-in's text and its validation message, covered by the stand-in's finding: the texts
 *  of its control and, for a refused repeat, its wrapper group's label, each that its refusal
 *  has not already claimed. The itext they name stands under the same refusal
 *  (`itext.ts::settleItext`). */
function coverStandIn(input: ReadTextInput, field: DraftField): void {
	const refusal = standInRefusal(field);
	if (refusal === undefined) return;
	const { cursor, scope } = input;
	const control = field.control;
	const holders =
		control === undefined
			? []
			: control.tag === "repeat" &&
					control.parent !== null &&
					control.parent !== undefined
				? [control.element, control.parent.element]
				: [control.element];
	for (const holder of holders)
		for (const child of xformsChildren(holder, scope))
			if (
				["label", "hint", "help", "alert"].includes(child.local) &&
				!input.refusals.claimed({ element: child.element })
			)
				cursor.refuseSubtree(
					child.element,
					refusal.claim,
					refusal.place,
					refusal.detail,
				);
	const bind = input.binds.get(field.node);
	if (bind !== undefined)
		for (const name of Object.keys(bind.element.attribs))
			if (
				splitName(name).local === "constraintMsg" &&
				!input.refusals.claimed({ element: bind.element, attribute: name })
			)
				cursor.refuse(
					{ element: bind.element, attribute: name },
					refusal.claim,
					refusal.place,
					refusal.detail,
				);
}

const MEDIA_FORMS = new Set(["image", "audio", "video"]);

/** The media a slot holds, by the kind of its field. */
function mediaHolding(owner: ItextOwner): SlotText["media"] {
	const kind = owner.field.kind;
	if (owner.slot === "option_label") return "option_media";
	if (owner.slot === "label")
		return CONTAINER_KINDS.has(kind)
			? "unheld"
			: fieldKindDeclaresKey(kind, "label_media")
				? "label_media"
				: "unheld";
	if (owner.slot === "help")
		return fieldKindDeclaresKey(kind, "help_media") ? "help_media" : "unheld";
	return "unheld";
}

/** Whether a slot that holds media (a question's label or help text, a choice) carries an image,
 *  an audio or a video form in some language. */
function writesMedia(
	owner: ItextOwner,
	forms: ReadonlyMap<LanguageTag, ReadonlyMap<string, Element>>,
): boolean {
	const holding = mediaHolding(owner);
	if (holding === "unheld") return false;
	for (const held of forms.values())
		for (const form of held.keys()) if (MEDIA_FORMS.has(form)) return true;
	return false;
}

/** Writes a slot's source-language template on its draft. */
function setTemplate(owner: ItextOwner, template: ProseTemplate): void {
	const slots = owner.field.field;
	if (owner.slot !== "option_label") {
		slots[owner.slot] = template;
		return;
	}
	const option = (
		slots.optionsSource as { options?: Record<string, unknown>[] } | undefined
	)?.options?.[owner.option ?? -1];
	if (option !== undefined) option.label = template;
}

/** Sets a slot's flag that it shows as typed: `plainLabel` on a label, a container's label or a
 *  choice, `plainHelp` on a help text. */
function setPlain(owner: ItextOwner): void {
	const slots = owner.field.field;
	if (owner.slot === "help") {
		if (fieldKindDeclaresKey(owner.field.kind, "plainHelp"))
			slots.plainHelp = true;
		return;
	}
	if (owner.slot === "option_label") {
		const option = (
			slots.optionsSource as { options?: Record<string, unknown>[] } | undefined
		)?.options?.[owner.option ?? -1];
		if (option !== undefined) option.plainLabel = true;
		return;
	}
	if (
		owner.slot === "label" &&
		fieldKindDeclaresKey(owner.field.kind, "plainLabel")
	)
		slots.plainLabel = true;
}

/** Pushes each source-language output that is no literal as the slot's draft expression. */
function registerOutputs(
	owner: ItextOwner,
	outputs: readonly SourceOutput[],
): void {
	for (const output of outputs)
		owner.field.expressions.push({
			slot: owner.slot,
			...(owner.option === undefined ? {} : { option: owner.option }),
			text: output.text,
			at: { element: output.element, attribute: output.attribute },
			key: OUTPUT_VALUE_KEY,
			mode: XFORM_MODE,
		});
}

/** Pushes each output a text holds in a language the app does not hold as an expression whose
 *  uses alone are claimed (`PendingExpression.usesOnly`): its translation is dropped, and Core
 *  parses each output's value as the form opens. */
function registerOtherLanguageOutputs(
	owner: ItextOwner,
	texts: readonly Element[],
	scope: (element: Element) => NamespaceScope,
): void {
	for (const text of texts)
		for (const value of text.children.filter(isTag)) {
			if (splitName(value.name).local !== "value") continue;
			for (const part of valueChildren(value, scope).parts)
				if (part.kind === "output" || part.kind === "literal")
					owner.field.expressions.push({
						slot: owner.slot,
						...(owner.option === undefined ? {} : { option: owner.option }),
						text: part.output.text,
						at: {
							element: part.output.element,
							attribute: part.output.attribute,
						},
						key: OUTPUT_VALUE_KEY,
						mode: XFORM_MODE,
						usesOnly: true,
					});
		}
}

/** Reads one slot's text: its claims (made once, by the first slot of an id), its template and
 *  its outputs. */
function readSlotText(
	input: ReadTextInput,
	ref: Reference,
	first: boolean,
): {
	readonly slot: SlotText | undefined;
	readonly blanks: readonly LanguageTag[];
} {
	const { cursor, accounting, itext, scope } = input;
	const owner = ref.owner;
	const place = ref.place;
	const context: ValueContext = { cursor, accounting, scope, place };
	const empty = new Map<LanguageTag, ReadValue>();
	const none = { slot: undefined, blanks: [] };

	if (ref.id === undefined) {
		// A text written inline (a label, a hint, a help text or a choice's label) holds its
		// text in every language, claimed by its slot's own claim; a `ref` that is no
		// `jr:itext` call is left unclaimed.
		if (ref.inline === undefined) return none;
		ref.claim(cursor, true, true);
		const blank = isConsumerWhitespace(ref.inline);
		if (!(blank && blankPrintsAsNone(owner)))
			setTemplate(
				owner,
				canonicalProseTemplate(
					blank ? [] : [{ kind: "text", text: ref.inline }],
				),
			);
		// An inline label holds no markdown copy in any language: shown as typed.
		if (!blank && !input.plainText) setPlain(owner);
		// A choice whose inline label is blank holds no media either: it shows nothing, the
		// item CommCare HQ's form builder cannot keep.
		if (blank && owner.slot === "option_label")
			accounting.finding(
				owner.field.control?.tag === "select"
					? X.choiceMissingValue.selectItem
					: X.choiceMissingValue.select1Item,
				place,
			);
		return none;
	}
	const id = ref.id;
	const { source, defaultLanguage } = itext;
	const values = itext.values(id);
	// The text must hold the form's default language's value: Core refuses a text id the default
	// locale lacks (`XFormParser.verifyTextMappings`), and the form builder fills a blank from
	// it. A language whose translation holds no value of the text, or that the form holds no
	// translation of, shows the default's (`Localizer.getLocaleData` loads the default locale's
	// keys under every locale, `FormDef.initLocale` shows the default locale for a language the
	// form lacks), the source language among them.
	const defaultForms =
		defaultLanguage === undefined ? undefined : values?.get(defaultLanguage);
	// Where the reading holds no language (each the app names got a finding), no text is read,
	// and the languages' finding stands for every one.
	if (source === undefined || defaultLanguage === undefined) {
		ref.claim(cursor, false, false);
		return none;
	}
	if (defaultForms === undefined) {
		ref.claim(cursor, false, false);
		// A text a translation holds twice is refused at the form, and a reference to it stands
		// under that one finding.
		accounting.finding(
			X.duplicateTextId,
			itext.duplicated(id) ? input.formPlace : place,
		);
		if (first)
			for (const text of itext.texts(id).values())
				cursor.refuseSubtree(text, X.duplicateTextId, place);
		return none;
	}
	// A text the default translation holds no default value of shows nothing on Core, and HQ's
	// build refuses a label whose text in the source's first `<translation>` holds none. Any
	// other language's text without a default value, the source's included, shows the default's
	// (`XFormParser.verifyTextMappings` only warns for a locale that is not the default,
	// `Localizer.getLocaleData` falls back per key), as a language without the text does.
	if (
		!defaultForms.has("default") ||
		((owner.slot === "label" || owner.slot === "option_label") &&
			itext.buildRefusesLabel(id))
	) {
		ref.claim(cursor, false, false);
		if (first)
			for (const text of itext.texts(id).values())
				cursor.refuseSubtree(text, X.firstWithoutDefault, place);
		else accounting.finding(X.firstWithoutDefault, place);
		return none;
	}

	// Each language's default value, read into parts.
	const read = new Map<LanguageTag, ReadValue>();
	const forms = new Map<LanguageTag, ReadonlyMap<string, Element>>();
	for (const language of itext.languages) {
		const held = values?.get(language);
		if (held === undefined) continue;
		forms.set(language, held);
		const value = held.get("default");
		if (value === undefined) continue;
		read.set(language, readValue(value, context, first));
	}

	// Markdown.
	const markdown = new Map<LanguageTag, Element>();
	for (const [language, held] of forms) {
		const value = held.get("markdown");
		if (value !== undefined) markdown.set(language, value);
	}
	const plain = markdown.size === 0;
	ref.claim(cursor, plain, false);

	// The blank rules are the form builder's, which fills a blank value from the default
	// language on every save: a blank there beside another language's text is refused, and a
	// blank in any other language beside the default's text is held, filled from it. So a blank
	// source value beside the default's text reads as the default's text, as a source value the
	// form does not hold does.
	const defaultBlank = valueIsBlank(read.get(defaultLanguage) as ReadValue);
	const sourceValue = read.get(source);
	const own =
		sourceValue === undefined || (valueIsBlank(sourceValue) && !defaultBlank)
			? defaultLanguage
			: source;
	const ownValue = read.get(own) as ReadValue;
	const blankEverywhere = [...read.values()].every(valueIsBlank);
	const blanks = [...read]
		.filter(
			([language, value]) =>
				language !== defaultLanguage && !defaultBlank && valueIsBlank(value),
		)
		.map(([language]) => language);
	let refused = false;
	const copies: ReadValue[] = [];

	if (first) {
		const textClaim =
			plain && owner.slot === "label"
				? X.labelPlain
				: plain && owner.slot === "help"
					? X.helpPlain
					: X.itext.text;
		for (const text of itext.texts(id).values())
			cursor.take({ element: text }, textClaim).value;

		const firstBlankRefused = defaultBlank && !blankEverywhere;
		if (firstBlankRefused) refused = true;
		for (const [language, value] of read) {
			const blank = valueIsBlank(value);
			if (firstBlankRefused && blank)
				cursor.refuse({ element: value.element }, X.blankFirstLanguage, place);
			else if (language !== defaultLanguage && blank && !defaultBlank) {
				cursor.take({ element: value.element }, X.blankTranslation).value;
			} else
				cursor.take(
					{ element: value.element },
					plain && owner.slot === "label" && holdsHtmlText(value)
						? X.htmlLabel
						: X.itext.value,
				).value;
		}

		if (claimMarkdown(input, owner, place, read, markdown, defaultLanguage))
			for (const copy of markdown.values()) {
				const parts = valueChildren(copy, scope).parts;
				copies.push({ element: copy, parts });
				// A literal output needs no twin, so it is claimed here, before the expression stage
				// opens, which registers the uses its value makes (`attributeUses.ts`).
				for (const part of parts)
					if (part.kind === "literal") claimLiteral(cursor, part.output);
			}
		for (const values of itext.allValues(id).values())
			for (const value of values) claimOtherForm(input, owner, place, value);
	}

	// A text blank everywhere is an entry Nova writes only where its slot carries media, and
	// there its markdown copy is the flag's to decide; anywhere else the flag prints nothing.
	if (
		plain &&
		(!blankEverywhere || writesMedia(owner, forms)) &&
		!input.plainText
	)
		setPlain(owner);
	// A hint, a help text or a validation message blank in every language prints as none does
	// (`builder.ts::buildFieldParts` writes its entry only for its media), and so does a
	// container's label, so it reads as none.
	if (!(blankEverywhere && blankPrintsAsNone(owner)))
		setTemplate(owner, placeholderTemplate(ownValue.parts));
	const registered: SourceOutput[] = [];
	for (const part of ownValue.parts)
		if (part.kind === "output") registered.push(part.output);
	if (first) {
		for (const output of registered) claimSourceOutput(cursor, output);
		registerOutputs(owner, registered);
		registerOtherLanguageOutputs(owner, itext.otherLanguageTexts(id), scope);
	}
	return {
		slot: {
			owner,
			place,
			id,
			first,
			own,
			values: read.size === 0 ? empty : read,
			registered,
			media: mediaHolding(owner),
			forms,
			refused,
			copies,
		},
		blanks,
	};
}

/**
 * The markdown copy of a text, held or refused by what each language shows of it; whether the
 * copies stand, held or read past (a hint's and a validation message's, which no runtime reads),
 * so each output in them, which Core parses as the form opens, is claimed as its twin is.
 *
 * Core shows a language the default language's copy where the language's own text holds none
 * (`Localizer.getLocaleData` lays the language's keys over the default locale's, and
 * `FormEntryCaption.getMarkdownText` reads `<id>;markdown` from that merge), while the places
 * that read the text without its copy show the language's own value (Android's form hierarchy,
 * `FormHierarchyBuilder` through `getLongText`; Web Apps' `caption`), and the default's where
 * the language holds a copy and no value of its own (the same merge; the form's localizer is
 * `new Localizer(true, true)`, `XFormParser`). So a copy some languages lack, or a copy a
 * language holds beside no value, is held only where each language that lacks the copy holds
 * the default's copy as its value, or a blank the form builder fills from the default, and each
 * language that lacks the value holds the default's value as its copy: every place then shows
 * one text, the language read as untranslated where it holds no value, which Nova writes with
 * markdown on in every language, what the first publish adds a spelling of the same text
 * (`forms-and-settings-rewritten`). A copy the default lacks breaks the language that holds it
 * (`getLocaleData` refuses a key the default locale lacks), and a language whose copy and shown
 * value differ shows two texts in one language.
 */
function claimMarkdown(
	input: ReadTextInput,
	owner: ItextOwner,
	place: HqPlace,
	read: ReadonlyMap<LanguageTag, ReadValue>,
	markdown: ReadonlyMap<LanguageTag, Element>,
	defaultLanguage: LanguageTag,
): boolean {
	const { cursor } = input;
	if (markdown.size === 0) return false;
	for (const value of markdown.values())
		claimFormValue(input.accounting, value, place);
	if (owner.slot === "hint") {
		for (const value of markdown.values())
			cursor.dropSubtree(value, X.hintMarkdown);
		return true;
	}
	if (owner.slot === "validate_msg") {
		for (const value of markdown.values())
			cursor.dropSubtree(value, X.validationMarkdown);
		return true;
	}
	const refuseAll = (claim: Parameters<XmlCursor["refuseSubtree"]>[1]) => {
		for (const value of markdown.values())
			cursor.refuseSubtree(value, claim, place);
	};
	if (input.plainText) {
		refuseAll(X.markdownFormattingOff);
		return false;
	}
	const defaultCopy = markdown.get(defaultLanguage);
	const defaultValue = read.get(defaultLanguage);
	const lacking = [...read].filter(([language]) => !markdown.has(language));
	const bare = [...markdown].filter(([language]) => !read.has(language));
	const showsOneText =
		defaultCopy !== undefined &&
		defaultValue !== undefined &&
		bare.every(([, copy]) => sameValueNodes(defaultValue.element, copy)) &&
		lacking.every(
			([, value]) =>
				sameValueNodes(value.element, defaultCopy) ||
				(valueIsBlank(value) && !valueIsBlank(defaultValue)),
		);
	if (!showsOneText) {
		refuseAll(X.markdownSomeLanguages);
		return false;
	}
	const equal = [...markdown].every(([language, value]) => {
		const own = read.get(language);
		return own === undefined || sameValueNodes(own.element, value);
	});
	if (!equal) {
		refuseAll(X.markdownDiffering);
		return false;
	}
	// A held copy is the one the emitter writes, `form` its only attribute (`xform/builder.ts`,
	// `addItext`), its content compared with the value's above; a copy holding more is left for
	// the close to report.
	const emitted = new Map([[" form", "markdown"]]);
	if (
		[...markdown.values()].some(
			(value) =>
				!sameAttributeMaps(
					attributesByName(value, input.scope(value)),
					emitted,
				),
		)
	)
		return false;
	const claim =
		lacking.length === 0 && bare.length === 0
			? X.markdownEqual
			: X.markdownSomeLanguagesOneText;
	for (const value of markdown.values()) cursor.takeSubtree(value, claim).value;
	return true;
}

/** A value of a form other than the default, markdown and media, claimed by the form it names. */
function claimOtherForm(
	input: ReadTextInput,
	owner: ItextOwner,
	place: HqPlace,
	value: Element,
): void {
	const { cursor } = input;
	const form = value.attribs.form;
	if (
		form === undefined ||
		form === "default" ||
		form === "markdown" ||
		MEDIA_FORMS.has(form)
	)
		return;
	if (form.startsWith("__nova_")) return;
	claimFormValue(input.accounting, value, place);
	if (form === "video-inline")
		cursor.refuseSubtree(value, X.videoInline, place);
	else if (form === "long") cursor.refuseSubtree(value, X.longForm, place);
	else if (form === "short") cursor.accountSubtree(value, X.shortForm, place);
	else if (form === "big-image")
		cursor.refuseSubtree(
			value,
			owner.slot === "option_label" ? X.choiceBigImage : X.labelBigImage,
			place,
		);
	else if (form === "qrcode") cursor.refuseSubtree(value, X.qrcode, place);
	else if (form === "tts") cursor.refuseSubtree(value, X.tts, place);
	else cursor.accountSubtree(value, X.customForm, place);
}

/** The surface key of a text's `<value>` element. */
const VALUE_KEY = "xform:model/itext/translation/text/value";

/**
 * A `<value>` that names a form is one of its text's values whatever form it names: the element
 * itself is claimed under the text value's claim, beside the form's claim its subtree stands
 * under, which is recorded at its `form` (`xmlCursor.ts::recordedNode`).
 */
export function claimFormValue(
	accounting: Accounting,
	value: Element,
	place: HqPlace,
): void {
	accounting.claimEntry(
		{ element: value },
		X.itext.value.entry,
		VALUE_KEY,
		place,
	);
}

// ── Stage 9: translations ─────────────────────────────────────────────────

const ROLE_OF: Readonly<
	Record<TextSlot, Exclude<ItextUnit["role"], "select-option-label">>
> = {
	label: "field-label",
	hint: "field-hint",
	help: "field-help",
	validate_msg: "field-validation-message",
	addFirstLabel: "field-first-add-label",
	addLabel: "field-add-label",
};

/** The translation unit of a slot, where its field and option have their UUIDs. */
export function unitOf(owner: ItextOwner): ItextUnit | undefined {
	const uuid = owner.field.uuid;
	if (uuid === undefined) return undefined;
	if (owner.slot !== "option_label")
		return { field: uuid, role: ROLE_OF[owner.slot] };
	const options = (
		owner.field.field.optionsSource as
			| { options?: { uuid?: Uuid }[] }
			| undefined
	)?.options;
	const option = options?.[owner.option ?? -1]?.uuid;
	return option === undefined
		? undefined
		: { field: uuid, option, role: "select-option-label" };
}

/** The template a slot holds in a document. */
function templateIn(
	doc: BlueprintDoc,
	owner: ItextOwner,
	unit: ItextUnit,
): ProseTemplate | undefined {
	const field = doc.fields[unit.field] as Record<string, unknown> | undefined;
	if (field === undefined) return undefined;
	if (unit.role !== "select-option-label")
		return field[owner.slot] as ProseTemplate | undefined;
	const options = (
		field.optionsSource as
			| { options?: { uuid: Uuid; label: ProseTemplate }[] }
			| undefined
	)?.options;
	return options?.find((option) => option.uuid === unit.option)?.label;
}

function writeTemplate(
	doc: BlueprintDoc,
	owner: ItextOwner,
	unit: ItextUnit,
	template: ProseTemplate,
): void {
	const field = doc.fields[unit.field] as Record<string, unknown> | undefined;
	if (field === undefined) return;
	if (unit.role !== "select-option-label") {
		field[owner.slot] = template;
		return;
	}
	const options = (
		field.optionsSource as
			| { options?: { uuid: Uuid; label: ProseTemplate }[] }
			| undefined
	)?.options;
	const option = options?.find((one) => one.uuid === unit.option);
	if (option !== undefined) option.label = template;
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>))
			deepFreeze(child);
	}
	return value;
}

/** The registration index of each output the forms stage registered, by its element. */
function registrations(ctx: ReadContext): Map<Element, number> {
	const byElement = new Map<Element, number>();
	ctx.pending.list().forEach((_, index) => {
		const at = ctx.pending.site(index).at;
		if ("element" in at && !byElement.has(at.element))
			byElement.set(at.element, index);
	});
	return byElement;
}

/** The entry a form's texts are read under, which a text-outputs record names. */
const TEXT_ENTRY = "questions/label-default-text-itext-value";

/**
 * Records, once per form, a form text whose source spells in a text node a
 * character Nova's print writes as a literal output: a no-break space, or the
 * bracket of an `instance(` CommCare HQ's build would read as a data source
 * (`builder.ts::literalLabelNodes`). Every runtime shows the output as the
 * same character, so the text is held as it stands, and the first publish
 * writes the form's source again with the output, which CommCare HQ's form
 * builder draws as one. Nova's own print of a text records nothing: each of
 * its literal outputs is read as the text it spells.
 */
function recordTextOutputs(
	ctx: ReadContext,
	form: DraftForm,
	slots: readonly SlotText[],
): void {
	const spelled = slots.some((slot) =>
		[...slot.values.values()].some((value) =>
			value.parts.some(
				(part) =>
					part.kind === "text" &&
					// Only these two print an output from a text node; the print decides.
					(part.text.includes("\u00a0") || part.text.includes("instance")) &&
					printedNodes(part.text).some(isTag),
			),
		),
	);
	if (!spelled) return;
	const readId =
		ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
	ctx.facts.sameStateRewrites.push({
		entry: TEXT_ENTRY,
		path: `/_attachments/${pointerToken(`${readId ?? form.xmlns}.xml`)}`,
		register: "form-text-characters-written-as-outputs",
	});
}

/**
 * Stage 9: each text's translations, from the bound outputs. An output of another language is
 * never bound on its own: it takes the bound part of the source output it equals, each source
 * output used once, and its value is claimed under the entry its twin was claimed under. A text
 * whose languages show different values is a finding at the question; every other language's
 * template becomes a translation entry where `translationEntryFor` gives one. A text a second
 * slot references takes the first slot's bound template as its own.
 */
export function finishText(ctx: ReadContext): void {
	const doc = ctx.doc;
	if (doc === undefined) return;
	const next = structuredClone(doc) as BlueprintDoc;
	const localization = next.localization;
	const source = localization?.sourceLanguage;
	const indexOf = registrations(ctx);
	const written: {
		unit: string;
		language: LanguageTag;
		entry: TranslationEntry;
		place: HqPlace;
		role: ItextUnit["role"];
	}[] = [];
	/** Each unit's written texts by language, as `written` gains them. */
	const writtenByUnit = new Map<string, Map<LanguageTag, ProseTemplate>>();
	let changed = false;

	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const xform = form.xform;
			if (xform === null) continue;
			const text = formText(xform);
			if (text === undefined) continue;
			recordTextOutputs(ctx, form, text.slots);
			const firstOf = new Map<string, { slot: SlotText; unit: ItextUnit }>();
			for (const slot of text.slots) {
				if (slot.first) claimCopyOutputs(ctx, text.cursor, slot, indexOf);
				const unit = unitOf(slot.owner);
				if (unit === undefined) continue;
				if (slot.id !== undefined && slot.first)
					firstOf.set(slot.id, { slot, unit });
				const shared =
					slot.first || slot.id === undefined
						? undefined
						: firstOf.get(slot.id);
				const bound =
					shared === undefined
						? undefined
						: templateIn(next, shared.slot.owner, shared.unit);
				if (bound !== undefined) {
					writeTemplate(next, slot.owner, unit, structuredClone(bound));
					changed = true;
				}
				const template = templateIn(next, slot.owner, unit);
				if (template === undefined || slot.refused) continue;
				if (localization === undefined || source === undefined) continue;
				const atoms = template.parts.filter((part) => part.kind !== "text");
				const unitId = itextUnitTranslationId(unit);
				const sourceValue = slot.values.get(slot.own);
				const sourceBlank =
					sourceValue === undefined || valueIsBlank(sourceValue);
				const formDefault = text.itext.defaultLanguage;
				for (const language of text.itext.languages) {
					if (language === slot.own) continue;
					const targets = localization.translations[language];
					if (targets === undefined) continue;
					// A language the text holds no value in shows the form's default language's
					// text, and a value left blank there beside the source's text is the form
					// builder's to fill from it; either reads as the default's text, a value
					// the default language's own pass claims, so this pass claims nothing of it.
					let value = slot.values.get(language);
					const borrowed =
						language !== formDefault &&
						(value === undefined || (valueIsBlank(value) && !sourceBlank));
					if (borrowed)
						value =
							formDefault === undefined
								? undefined
								: slot.values.get(formDefault);
					if (value === undefined) continue;
					// The default's own text is the slot's: no translation.
					if (borrowed && formDefault === slot.own) continue;
					const claims = slot.first && !borrowed;
					const used = new Set<number>();
					const parts: ProsePart[] = [];
					let differs = false;
					for (const part of value.parts) {
						if (part.kind !== "output") {
							parts.push({ kind: "text", text: part.text });
							continue;
						}
						const twin = slot.registered.findIndex(
							(candidate, index) =>
								!used.has(index) &&
								sameXPathText(part.output.text, candidate.text, {
									ruleSet: "form",
								}),
						);
						if (twin < 0 || atoms[twin] === undefined) {
							if (claims)
								text.cursor.refuseSubtree(
									part.output.element,
									X.outputsDiffer,
									slot.place,
								);
							differs = true;
							continue;
						}
						used.add(twin);
						parts.push(structuredClone(atoms[twin] as ProsePart));
						if (claims)
							claimTwin(
								ctx,
								text.cursor,
								part.output,
								slot.registered[twin] as SourceOutput,
								indexOf,
								slot.place,
							);
					}
					if (used.size < slot.registered.length) {
						if (claims) ctx.accounting.finding(X.outputsDiffer, slot.place);
						differs = true;
					}
					if (differs) continue;
					const target = canonicalProseTemplate(parts);
					const entry = translationEntryFor("prose", template, target, source);
					if (entry === undefined) continue;
					targets[unitId] = entry;
					changed = true;
					written.push({
						unit: unitId,
						language,
						entry,
						place: slot.place,
						role: unit.role,
					});
					let ofUnit = writtenByUnit.get(unitId);
					if (ofUnit === undefined) {
						ofUnit = new Map();
						writtenByUnit.set(unitId, ofUnit);
					}
					ofUnit.set(language, entry.value as ProseTemplate);
				}
				const byLanguage = writtenByUnit.get(unitId);
				if (byLanguage !== undefined && byLanguage.size > 0)
					ctx.translations.set(unitId, "prose", new Map(byLanguage));
			}
		}

	// A question whose label is blank in every language and carries no media
	// has no `<label>` (`builder.ts::buildLabelNodes`, as HQ's form builder
	// saves it); every question kind holds a label, so it holds the blank one.
	for (const field of Object.values(next.fields)) {
		const slots = field as { label?: ProseTemplate };
		if (
			slots.label === undefined &&
			!CONTAINER_KINDS.has(field.kind) &&
			fieldKindDeclaresKey(field.kind, "label")
		) {
			slots.label = structuredClone(EMPTY_PROSE_TEMPLATE);
			changed = true;
		}
	}

	if (!changed) return;
	const units = snapshotTranslationUnits(next);
	const order = localization?.languageOrder ?? [];
	for (const one of written) {
		const unit = units.get(one.unit as never);
		if (unit === undefined) continue;
		const issue = translationValueIntegrityIssue(unit, one.entry.value);
		if (issue === undefined) continue;
		ctx.accounting.defect(
			one.place,
			"xform:model/itext/translation/text/value",
			readerDefect.translation(
				one.place,
				one.role,
				order.indexOf(one.language),
				issue,
			),
		);
	}
	ctx.doc = deepFreeze(next);
}

/** Claims an output another language or a markdown copy holds as its twin was claimed: the
 *  element, its namespace, a `ref`, and its value under each claim the expression stage made of
 *  the twin, the value's own and each use its text makes, since Core parses the one as it parses
 *  the other. A refusal a claim carries beside its own key stands at this output too. */
function claimTwin(
	ctx: ReadContext,
	cursor: XmlCursor,
	output: SourceOutput,
	twin: SourceOutput,
	indexOf: ReadonlyMap<Element, number>,
	place: HqPlace,
): void {
	claimOutputElement(cursor, output.element);
	if (output.attribute === "ref")
		cursor.take({ element: output.element, attribute: "ref" }, X.outputRef)
			.value;
	const index = indexOf.get(twin.element);
	if (index === undefined) return;
	const site = { element: output.element, attribute: output.attribute };
	for (const claim of ctx.pending.outcome(index).claims) {
		ctx.accounting.claimEntry(site, claim.entryId, claim.key, place);
		if (claim.refusal !== undefined)
			ctx.accounting.claimEntry(
				site,
				claim.refusal.entryId,
				claim.refusal.key,
				place,
			);
	}
}

/** Claims the outputs of each markdown copy a slot holds that are no literal (the form stage
 *  claims a literal as the text it spells), each as its twin among the source's outputs, each
 *  twin used once. */
function claimCopyOutputs(
	ctx: ReadContext,
	cursor: XmlCursor,
	slot: SlotText,
	indexOf: ReadonlyMap<Element, number>,
): void {
	for (const copy of slot.copies) {
		const used = new Set<number>();
		for (const part of copy.parts) {
			if (part.kind !== "output") continue;
			const twin = slot.registered.findIndex(
				(candidate, index) =>
					!used.has(index) &&
					sameXPathText(part.output.text, candidate.text, { ruleSet: "form" }),
			);
			if (twin < 0) continue;
			used.add(twin);
			claimTwin(
				ctx,
				cursor,
				part.output,
				slot.registered[twin] as SourceOutput,
				indexOf,
				slot.place,
			);
		}
	}
}
