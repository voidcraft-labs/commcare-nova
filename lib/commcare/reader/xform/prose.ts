/**
 * A form's text, read by the slot that references it (12.2, 12.3), and, once
 * the expression stage bound the source language's outputs, its translations
 * (12.5). A `value` element's children become prose parts in order: a text
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
import { placedBasic } from "../../placement";
import { buildLabelNodes } from "../../xform/builder";
import { bindCarriesConstraint } from "../../xform/constraintMessage";
import { isConsumerWhitespace } from "../../xform/consumerWhitespace";
import {
	elementNamespace,
	type NamespaceScope,
	splitName,
	XFORMS_NS,
	XHTML_NS,
} from "../../xmlNamespaces";
import { InstanceSink } from "../../xpath/wire/instances";
import type { Accounting } from "../accounting";
import { withCandidate } from "../candidate";
import type { ReadContext } from "../context";
import { readerDefect } from "../defects";
import { sameJson } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import { translationEntryFor } from "../translations";
import { ownText, type XmlCursor } from "../xmlCursor";
import type { ControlNode } from "./body";
import { TEXT_CONTROLS, type TextControl, X } from "./claims";
import { carrierTextId } from "./generated";
import type { DraftField, ReadXForm } from "./index";
import {
	type ItextOwner,
	type ItextReading,
	itextIdsRead,
	itextReference,
	sameValueNodes,
	settleItext,
	type TextSlot,
} from "./itext";
import { standInRefusal } from "./logic";
import type { BindFacts, DataNode } from "./model";

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
		parsed = JSON.parse(node.args[0].value);
	} catch {
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

function claimLiteral(cursor: XmlCursor, output: SourceOutput): void {
	cursor.derived({ element: output.element }, X.output);
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
	cursor.derived({ element: output.element }, X.output);
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
	readonly media:
		| "label_media"
		| "help_media"
		| "option_media"
		| "unheld"
		| "refused";
	/** Every value of each form but the default, by language: what the media reader reads. */
	readonly forms: ReadonlyMap<LanguageTag, ReadonlyMap<string, Element>>;
	/** Set where the text holds a finding that leaves its translations unread. */
	readonly refused: boolean;
}

/** A validation message Nova composes in its question's bind (13.2): the question, the text its
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
export function formBlankTranslations(xform: ReadXForm): number {
	return FORM_TEXTS.get(xform)?.blankTranslations ?? 0;
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
]);

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
const FILL_SLOT_OF: Readonly<Record<string, TextSlot>> = {
	"field-label": "label",
	"field-hint": "hint",
	"field-help": "help",
	"field-validation-message": "validate_msg",
};

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
	const slot = FILL_SLOT_OF[unit.role];
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

/** Whether a `jr:constraintMsg` is a protected message (13.2): it reads an itext form whose
 *  name Nova's protected message gives. That reader claims it. */
function isProtectedMessage(text: string): boolean {
	const ids = new Set<string>();
	itextIdsRead(text, ids);
	return [...ids].some((id) => id.includes(";__nova_"));
}

/** The ids every control and every `jr:constraintMsg` of the form references. */
function idsReferencedAnywhere(input: ReadTextInput): Set<string> {
	const ids = new Set<string>();
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
			if (reference.kind !== "other") ids.add(reference.id);
		}
		for (const child of element.children) if (isTag(child)) walk(child);
	};
	walk(input.body);
	for (const bind of input.allBinds)
		for (const [name, value] of Object.entries(bind.attribs))
			if (splitName(name).local === "constraintMsg") {
				const reference = itextReference(value);
				if (reference.kind !== "other") ids.add(reference.id);
				else itextIdsRead(value, ids);
			}
	return ids;
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
		if (control !== undefined && tag !== undefined) {
			let alert: Element | undefined;
			for (const child of xformsChildren(control.element, scope)) {
				if (child.local === "hint") {
					if (!fieldKindDeclaresKey(field.kind, "hint")) {
						cursor.refuseSubtree(child.element, X.hintOnLabel[tag], place);
						continue;
					}
					references.push(
						reference(
							input,
							{ field, slot: "hint" },
							place,
							child.element,
							(c) => {
								c.take({ element: child.element }, X.hint[tag]).value;
								claimRef(c, child.element, X.hint[`${tag}Ref`]);
							},
						),
					);
				} else if (child.local === "help") {
					if (!fieldKindDeclaresKey(field.kind, "help")) {
						cursor.refuseSubtree(child.element, X.helpOnCapture[tag], place);
						continue;
					}
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
								c.take({ element: child.element }, X.help[tag]).value;
								claimRef(c, child.element, X.help[`${tag}Ref`]);
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
	const firstOwner = new Map<string, Reference>();
	for (const ref of references) {
		if (ref.id !== undefined && !firstOwner.has(ref.id))
			firstOwner.set(ref.id, ref);
		if (ref.id !== undefined) itext.own(ref.id, ref.owner);
	}
	for (const ref of references) {
		const read = readSlotText(
			input,
			ref,
			firstOwner.get(ref.id ?? "") === ref || ref.id === undefined,
		);
		blankTranslations += read.blanks;
		if (read.slot !== undefined) slots.push(read.slot);
	}

	settleItext(itext, {
		cursor,
		formPlace: input.formPlace,
		placeOf: (owner) => owner.field.place,
		readByExpressions: idsReadByExpressions(input),
		elsewhere: idsReferencedAnywhere(input),
	});

	return { slots, protectedMessages, itext, blankTranslations, cursor };
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
	if (!fieldKindDeclaresKey(field.kind, "validate_msg")) {
		if (messageNode !== undefined)
			cursor.refuse(messageNode, X.messageOnCapture, place);
		else if (held !== undefined) accounting.finding(X.messageOnCapture, place);
		claimAlert(cursor);
		return;
	}
	if (bind?.logic.constraint === undefined) {
		if (messageNode !== undefined)
			cursor.refuse(messageNode, X.messageWithoutConstraint, place);
		else if (held !== undefined)
			accounting.finding(X.messageWithoutConstraint, place);
		if (messageNode !== undefined || held !== undefined) {
			claimAlert(cursor);
			return;
		}
	}
	const messageRef =
		message === undefined ? undefined : itextReference(message);
	if (messageRef?.kind === "other" && messageNode !== undefined) {
		cursor.refuse(messageNode, X.literalConstraintMsg, place);
		claimAlert(cursor);
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
			if (messageNode !== undefined) c.take(messageNode, X.constraintMsg).value;
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

/** A stand-in's text and its validation message, covered by the stand-in's finding. */
function coverStandIn(input: ReadTextInput, field: DraftField): void {
	const refusal = standInRefusal(field);
	if (refusal === undefined) return;
	const { cursor, scope } = input;
	const control = field.control;
	if (control !== undefined)
		for (const child of xformsChildren(control.element, scope))
			if (["label", "hint", "help", "alert"].includes(child.local))
				cursor.refuseSubtree(
					child.element,
					refusal.claim,
					field.place,
					refusal.detail,
				);
	const bind = input.binds.get(field.node);
	if (bind !== undefined)
		for (const name of Object.keys(bind.element.attribs))
			if (splitName(name).local === "constraintMsg")
				cursor.refuse(
					{ element: bind.element, attribute: name },
					refusal.claim,
					field.place,
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
		return fieldKindDeclaresKey(kind, "help_media") ? "help_media" : "refused";
	return "unheld";
}

/** Whether a slot that holds media (a question's label or help text, a choice) carries an image,
 *  an audio or a video form in some language. */
function writesMedia(
	owner: ItextOwner,
	forms: ReadonlyMap<LanguageTag, ReadonlyMap<string, Element>>,
): boolean {
	const holding = mediaHolding(owner);
	if (holding === "unheld" || holding === "refused") return false;
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

/** Reads one slot's text: its claims (made once, by the first slot of an id), its template and
 *  its outputs. */
function readSlotText(
	input: ReadTextInput,
	ref: Reference,
	first: boolean,
): { readonly slot: SlotText | undefined; readonly blanks: number } {
	const { cursor, accounting, itext, scope } = input;
	const owner = ref.owner;
	const place = ref.place;
	const context: ValueContext = { cursor, accounting, scope, place };
	const empty = new Map<LanguageTag, ReadValue>();
	const none = { slot: undefined, blanks: 0 };

	if (ref.id === undefined) {
		// A text written inline (a label, a hint, a help text or a choice's label) holds its
		// text in every language, claimed by its slot's own claim; a `ref` that is no
		// `jr:itext` call is left unclaimed.
		if (ref.inline === undefined) return none;
		ref.claim(cursor, true, true);
		const blank = isConsumerWhitespace(ref.inline);
		if (!(blank && OPTIONAL_TEXT.has(owner.slot)))
			setTemplate(
				owner,
				canonicalProseTemplate(
					blank ? [] : [{ kind: "text", text: ref.inline }],
				),
			);
		// An inline label holds no markdown copy in any language: shown as typed (12.2).
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
	if (
		source === undefined ||
		defaultLanguage === undefined ||
		defaultForms === undefined
	) {
		ref.claim(cursor, false, false);
		accounting.finding(X.duplicateTextId, place);
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
	let blanks = 0;
	let refused = false;

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
				blanks += 1;
			} else cursor.take({ element: value.element }, X.itext.value).value;
		}

		claimMarkdown(input, owner, place, read, markdown, defaultLanguage);
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
	// (`builder.ts::buildFieldParts` writes its entry only for its media), so it reads as none.
	if (!(blankEverywhere && OPTIONAL_TEXT.has(owner.slot)))
		setTemplate(owner, placeholderTemplate(ownValue.parts));
	const registered: SourceOutput[] = [];
	for (const part of ownValue.parts)
		if (part.kind === "output") registered.push(part.output);
	if (first) {
		for (const output of registered) claimSourceOutput(cursor, output);
		registerOutputs(owner, registered);
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
		},
		blanks,
	};
}

/**
 * The markdown copy of a text, by the table of 12.2.
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
): void {
	const { cursor } = input;
	if (markdown.size === 0) return;
	if (owner.slot === "hint") {
		for (const value of markdown.values())
			cursor.dropSubtree(value, X.hintMarkdown);
		return;
	}
	if (owner.slot === "validate_msg") {
		for (const value of markdown.values())
			cursor.dropSubtree(value, X.validationMarkdown);
		return;
	}
	const refuseAll = (claim: Parameters<XmlCursor["refuseSubtree"]>[1]) => {
		for (const value of markdown.values())
			cursor.refuseSubtree(value, claim, place);
	};
	if (input.plainText) {
		refuseAll(X.markdownFormattingOff);
		return;
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
		return;
	}
	const equal = [...markdown].every(([language, value]) => {
		const own = read.get(language);
		return own === undefined || sameValueNodes(own.element, value);
	});
	if (!equal) {
		refuseAll(X.markdownDiffering);
		return;
	}
	const claim =
		lacking.length === 0 && bare.length === 0
			? X.markdownEqual
			: X.markdownSomeLanguagesOneText;
	for (const value of markdown.values()) cursor.takeSubtree(value, claim).value;
}

/** A value of a form other than the default, markdown and media: by the table of 12.2. */
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

// ── Stage 9: translations ─────────────────────────────────────────────────

const ROLE_OF: Readonly<
	Record<TextSlot, Exclude<ItextUnit["role"], "select-option-label">>
> = {
	label: "field-label",
	hint: "field-hint",
	help: "field-help",
	validate_msg: "field-validation-message",
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
	let changed = false;

	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const xform = form.xform;
			if (xform === null) continue;
			const text = formText(xform);
			if (text === undefined) continue;
			const firstOf = new Map<string, { slot: SlotText; unit: ItextUnit }>();
			for (const slot of text.slots) {
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
					// builder's to fill from it (12.2); either reads as the default's text, a value
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
				}
				const byLanguage = new Map<LanguageTag, ProseTemplate>();
				for (const entry of written)
					if (entry.unit === unitId)
						byLanguage.set(entry.language, entry.entry.value as ProseTemplate);
				if (byLanguage.size > 0)
					ctx.translations.set(unitId, "prose", byLanguage);
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

/** Claims another language's output as its twin was claimed: the element, a `ref`, and its value
 *  under the twin's entry. */
function claimTwin(
	ctx: ReadContext,
	cursor: XmlCursor,
	output: SourceOutput,
	twin: SourceOutput,
	indexOf: ReadonlyMap<Element, number>,
	place: HqPlace,
): void {
	cursor.derived({ element: output.element }, X.output);
	if (output.attribute === "ref")
		cursor.take({ element: output.element, attribute: "ref" }, X.outputRef)
			.value;
	const index = indexOf.get(twin.element);
	const claim =
		index === undefined ? undefined : ctx.pending.outcome(index).claim;
	if (claim === undefined) return;
	ctx.accounting.claimEntry(
		{ element: output.element, attribute: output.attribute },
		claim.entryId,
		OUTPUT_VALUE_KEY,
		place,
	);
}
