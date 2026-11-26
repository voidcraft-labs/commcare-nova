import { availableCasesNodeset } from "../../caseOptions";
import {
	bindLookupRead,
	lookupReadNames,
	lookupReadPath,
} from "../../lookup/readPath";
/**
 * A select's choices: its inline `item`s, or one `itemset` over a lookup table (ordered by
 * one of its columns where the itemset holds a `<sort ref>`) or over
 * the worker's cases in the shape Nova writes for a question's case choices. An itemset's
 * nodeset is read with the XPath grammar, and its filter is registered for the expression
 * stage, never read here.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import type { AvailableCasesOptionsSource } from "@/lib/domain/fields";
import { instanceScanRead } from "@/lib/domain/hqInstanceRead";
import { questionChoiceReadIssue } from "@/lib/domain/lookupRead";
import { selectOptionValueProblemAmong } from "@/lib/domain/selectOptionValue";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { elementNamespace, splitName, XFORMS_NS } from "../../xmlNamespaces";
import { type FormSyntax, literalInstanceId } from "../../xpath/formSyntax";
import { instanceForRead } from "../../xpath/instanceSources";
import { w } from "../../xpath/wire/builders";
import { casePropertyStep } from "../../xpath/wire/rowScope";
import type { Accounting } from "../accounting";
import { lookupNameRefusal } from "../lookupNames";
import { readFormSyntax, readStoredNameSyntax } from "../syntaxRead";
import type { ReaderLookupCatalog, UnreadTable } from "../types";
import { ownText, type XmlCursor, type XmlNode } from "../xmlCursor";
import type { ControlNode } from "./body";
import { X } from "./claims";
import { sameTree } from "./generated";
import type { DraftField } from "./index";
import type { ParsedXForm } from "./parse";

/** A select's case choices as the form stage proposes them, decided once the filter is bound. */
export interface CaseChoicesProposal {
	readonly itemset: Element;
	/** The `label` and the `value` the proposal was read from, the only parts of the itemset a
	 *  held reading claims. Core keeps the last `label` and the last `value` an itemset holds
	 *  (`XFormParser.parseItemset`, `ItemSetParsingUtils.setLabel`, `setValue`), so any other is
	 *  left unclaimed and reported. */
	readonly label: Element;
	readonly value: Element;
	readonly sort?: Element;
	readonly select: "select1" | "select";
	readonly caseType?: string;
	readonly status?: AvailableCasesOptionsSource["status"];
	readonly labelProperty: string;
	/** Whether the nodeset holds a filter, registered for the expression stage, which claims
	 *  the nodeset with it. */
	readonly filtered: boolean;
}

export interface ReadChoicesInput {
	readonly control: ControlNode;
	readonly field: DraftField;
	readonly parsed: ParsedXForm;
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly place: HqPlace;
	readonly lookup: ReaderLookupCatalog;
	readonly instanceSources: ReadonlyMap<string, string>;
	/** Appends a table the catalog does not hold, handed to project data. */
	readonly unreadTable: (table: UnreadTable) => void;
	/** Notes an instance a choice list's itemset reads, whose declaration the
	 *  read stands for (`provisional.ts::claimDeclarations`). */
	readonly carrierRead: (id: string) => void;
}

/** The entry an instance a choice list's lookup itemset reads is claimed
 *  under: Nova's typed lookup carrier. */
const TYPED_CARRIER =
	"expressions-and-data/item-list-tag-read-through-nova-s-typed-lookup-carriers";

function xformsChildren(
	element: Element,
	parsed: ParsedXForm,
	local: string,
): Element[] {
	return element.children
		.filter(isTag)
		.filter(
			(child) =>
				elementNamespace(child, parsed.scope(child)) === XFORMS_NS &&
				splitName(child.name).local === local,
		);
}

function plain(element: Element, name: string): string | undefined {
	return Object.hasOwn(element.attribs, name)
		? element.attribs[name]
		: undefined;
}

/** Reads a select's choices into `optionsSource`, or the proposal stage 10 decides. */
export function readChoices(
	input: ReadChoicesInput,
): CaseChoicesProposal | undefined {
	const { control, parsed, cursor, place } = input;
	const select = control.tag === "select1" ? "select1" : "select";
	const items = xformsChildren(control.element, parsed, "item");
	const itemsets = xformsChildren(control.element, parsed, "itemset");
	if (items.length > 0 === itemsets.length > 0) {
		const claim = X.choicesBothOrNeither[select];
		if (items.length === 0) input.accounting.finding(claim, place);
		for (const element of [...items, ...itemsets])
			cursor.refuseSubtree(element, claim, place);
		return undefined;
	}
	if (itemsets.length > 1) {
		for (const element of itemsets.slice(1))
			cursor.refuseSubtree(element, X.choicesBothOrNeither[select], place);
	}
	if (items.length > 0) {
		readItems(input, select, items);
		return undefined;
	}
	return readItemset(input, select, itemsets[0] as Element);
}

function readItems(
	input: ReadChoicesInput,
	select: "select1" | "select",
	items: readonly Element[],
): void {
	const { parsed, cursor, place } = input;
	const sites = select === "select1" ? X.choice.single : X.choice.multi;
	const options: { value: string }[] = [];
	const optionItems: Element[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const value = xformsChildren(item, parsed, "value")[0];
		// Core will not parse an item with no `<label>` ("<item> without proper <label>",
		// `XFormParser.parseItem`), as it will not one with no `<value>`.
		const label = xformsChildren(item, parsed, "label")[0];
		if (value === undefined || label === undefined) {
			cursor.refuseSubtree(
				item,
				select === "select1"
					? X.choiceMissingValue.select1Item
					: X.choiceMissingValue.selectItem,
				place,
			);
			continue;
		}
		cursor.take({ element: item }, sites.item).value;
		const text = ownText(value);
		const problem = value.children.some(isTag)
			? "children"
			: selectOptionValueProblemAmong(text, seen);
		if (problem === "children") continue;
		// Only the instance read names what it read; a refused value is never quoted. A choice
		// whose value is refused is refused whole: its label, and the text the label names,
		// stand under the value's refusal.
		const refusal =
			problem === "instance-read"
				? {
						claim: X.choiceValueInstance,
						detail: { name: instanceScanRead(text) ?? text },
					}
				: problem !== undefined
					? { claim: X.choiceValueRefused, detail: undefined }
					: undefined;
		if (refusal !== undefined) {
			cursor.refuseSubtree(value, refusal.claim, place, refusal.detail);
			cursor.refuseSubtree(label, refusal.claim, place, refusal.detail);
		} else {
			const apostrophe = text.includes("'");
			const doubleQuote = text.includes('"');
			const taken = cursor.take(
				{ element: value },
				apostrophe && doubleQuote
					? X.choiceValueBothQuotes[select]
					: apostrophe || doubleQuote
						? X.choiceValueQuote[select]
						: sites.value,
			).value;
			options.push({ value: taken });
			optionItems.push(item);
		}
		seen.add(text);
	}
	input.field.field.optionsSource = { kind: "inline", options };
	input.field.items = optionItems;
}

/** The steps of a chain `instance('<id>')/a/b…`, its last step's predicates apart. */
function instanceChain(node: FormSyntax):
	| {
			readonly id: string;
			readonly steps: readonly string[];
			readonly predicates: readonly FormSyntax[];
	  }
	| undefined {
	const predicates: FormSyntax[] = [];
	let at = node;
	while (at.kind === "filter") {
		predicates.unshift(at.where);
		at = at.base;
	}
	const steps: string[] = [];
	while (at.kind === "child" && !at.descendant) {
		if (at.step.kind !== "name" || at.step.wildcard) return undefined;
		steps.unshift(at.step.name);
		if (at.left === undefined) return undefined;
		at = at.left;
	}
	const id = literalInstanceId(at);
	return id === undefined ? undefined : { id: id.value, steps, predicates };
}

function ungroupSyntax(node: FormSyntax): FormSyntax {
	while (node.kind === "group") node = node.value;
	return node;
}

/** Core's one-argument position() casts its argument to a nodeset.
 * A literal number in a direct predicate or comparison is evaluated
 * for every candidate row. This does not inspect conditional branches. */
function positionOfNumber(predicate: FormSyntax): boolean {
	const node = ungroupSyntax(predicate);
	const directly = (expression: FormSyntax) => {
		const at = ungroupSyntax(expression);
		if (at.kind !== "call" || at.name !== "position" || at.args.length !== 1)
			return false;
		const argument = ungroupSyntax(at.args[0]);
		return (
			argument.kind === "number" ||
			(argument.kind === "negative" &&
				ungroupSyntax(argument.value).kind === "number")
		);
	};
	return (
		directly(node) ||
		(node.kind === "binary" &&
			["=", "!=", "<", "<=", ">", ">="].includes(node.op) &&
			(directly(node.left) || directly(node.right)))
	);
}

/** A ref that is one name step: the column's or the property's name. */
function singleName(text: string, storedName = false): string | undefined {
	const read = storedName ? readStoredNameSyntax(text) : readFormSyntax(text);
	if (!read.ok || read.node?.kind !== "name" || read.node.wildcard)
		return undefined;
	return read.node.name;
}

/** A ref that is one attribute step `@name`. */
function singleAttribute(text: string): string | undefined {
	const read = readFormSyntax(text);
	const node = read.ok ? read.node : undefined;
	return node?.kind === "axis" &&
		node.axis === "attribute" &&
		node.value.kind === "name" &&
		!node.value.wildcard
		? node.value.name
		: undefined;
}

/** Whether a ref calls `jr:itext`. */
function callsItext(text: string): boolean {
	const read = readFormSyntax(text);
	return read.ok && read.node?.kind === "call" && read.node.name === "jr:itext";
}

function readItemset(
	input: ReadChoicesInput,
	select: "select1" | "select",
	itemset: Element,
): CaseChoicesProposal | undefined {
	const { parsed, cursor, place, field } = input;
	const label = xformsChildren(itemset, parsed, "label")[0];
	const value = xformsChildren(itemset, parsed, "value")[0];
	const copy = xformsChildren(itemset, parsed, "copy")[0];
	if (label === undefined || (value === undefined && copy === undefined)) {
		cursor.refuseSubtree(
			itemset,
			select === "select1"
				? X.choiceMissingValue.select1Itemset
				: X.choiceMissingValue.selectItemset,
			place,
		);
		return undefined;
	}
	if (copy !== undefined) {
		cursor.refuseSubtree(itemset, X.itemsetCopy, place);
		// The refusal is a fact about the `copy` and the path it copies, where it stands too.
		cursor.within({ element: copy }, X.itemsetCopy, [
			`xform:${select}/itemset/copy`,
		]);
		if (Object.hasOwn(copy.attribs, "ref"))
			cursor.within({ element: copy, attribute: "ref" }, X.itemsetCopy, [
				`xform:${select}/itemset/copy@ref`,
			]);
		return undefined;
	}
	const other = () => {
		cursor.refuseSubtree(itemset, X.otherItemset, place);
		return undefined;
	};
	// One `<sort ref>` in the XForms namespace, the element HQ's form builder writes
	// (Vellum `itemset.js::writeCustomXML`). Core keeps the last of several and reads a
	// sort in any namespace (`XFormParser.parseItemset`), which no Nova source states.
	const sorts = itemset.children
		.filter(isTag)
		.filter((child) => splitName(child.name).local === "sort");
	const sort = xformsChildren(itemset, parsed, "sort")[0];
	if (
		plain(itemset, "sort") !== undefined ||
		sorts.length > 1 ||
		(sorts.length === 1 && sort === undefined)
	)
		return other();
	const nodeset = plain(itemset, "nodeset") ?? "";
	const runtime = readFormSyntax(nodeset);
	const read = runtime.ok ? runtime : readStoredNameSyntax(nodeset);
	const chain =
		read.ok && read.node !== undefined ? instanceChain(read.node) : undefined;
	const labelRef = plain(label, "ref") ?? "";
	const valueRef = value === undefined ? "" : (plain(value, "ref") ?? "");
	const sortRef = sort === undefined ? undefined : (plain(sort, "ref") ?? "");
	if (chain === undefined || value === undefined) return other();

	// A lookup table: instance(id)/<tag>_list/<tag>, with at most one predicate.
	const tag = chain.steps[1];
	const bound = instanceForRead(chain.id, input.instanceSources);
	if (
		tag !== undefined &&
		bound?.kind === "table" &&
		bound.tag === tag &&
		chain.steps.length === 2 &&
		chain.steps[0] === `${tag}_list` &&
		chain.predicates.length <= 1
	) {
		const table = input.lookup.table(tag);
		if (table === undefined) {
			cursor.handOffSubtree(itemset, "lookup-table-read", tag);
			input.unreadTable({ tag, place });
			return undefined;
		}
		// Each refusal of a ref stands at the ref whose value makes its class, or at its element
		// where it holds none.
		const refOf = (element: Element): XmlNode =>
			Object.hasOwn(element.attribs, "ref")
				? { element, attribute: "ref" }
				: { element };
		if (callsItext(labelRef)) {
			cursor.refuseSubtreeAt(itemset, refOf(label), X.itemsetItextLabel, place);
			return undefined;
		}
		const labelName = lookupReadPath(labelRef, "stored-xml");
		const valueName = lookupReadPath(valueRef, "stored-xml");
		const sortName =
			sortRef === undefined ? undefined : lookupReadPath(sortRef, "stored-xml");
		if (
			labelName === undefined ||
			valueName === undefined ||
			(sort !== undefined && sortName === undefined)
		) {
			cursor.refuseSubtreeAt(
				itemset,
				labelName === undefined
					? refOf(label)
					: valueName === undefined
						? refOf(value)
						: refOf(sort as Element),
				X.itemsetRefShape,
				place,
			);
			return undefined;
		}
		const labelColumn = bindLookupRead(labelName, table);
		const valueColumn = bindLookupRead(valueName, table);
		const sortColumn =
			sortName === undefined ? undefined : bindLookupRead(sortName, table);
		// A ref to a column the table lacks reads blank for every choice on a device: one finding,
		// which the whole itemset stands behind. Its reason is the form parser's for a read of a
		// column the table lacks, so a reader of the account can tell a read of the Project's data
		// that is not there from any other.
		if (
			labelColumn === undefined ||
			valueColumn === undefined ||
			(sortName !== undefined && sortColumn === undefined)
		) {
			cursor.refuseSubtree(itemset, X.itemsetColumn, place, {
				reason: "parse:unknown-column",
			});
			return undefined;
		}
		for (const [names, part, at] of [
			[[tag], "tag", { element: itemset, attribute: "nodeset" }],
			[lookupReadNames(labelName), "column", refOf(label)],
			[lookupReadNames(valueName), "column", refOf(value)],
			...(sortName !== undefined && sort !== undefined
				? ([[lookupReadNames(sortName), "column", refOf(sort)]] as const)
				: []),
		] as const) {
			for (const name of names) {
				const refusal = lookupNameRefusal(name, "lookup_options_source", part);
				if (refusal !== undefined) {
					cursor.refuseSubtreeAt(itemset, at, refusal.claim, place, { name });
					return undefined;
				}
			}
		}
		const unreadable = questionChoiceReadIssue(labelColumn)
			? label
			: questionChoiceReadIssue(valueColumn)
				? value
				: sortColumn !== undefined && questionChoiceReadIssue(sortColumn)
					? sort
					: undefined;
		if (unreadable !== undefined) {
			cursor.refuseSubtreeAt(
				itemset,
				refOf(unreadable),
				X.itemsetRefShape,
				place,
			);
			return undefined;
		}
		const predicate = chain.predicates[0];
		if (predicate !== undefined && positionOfNumber(predicate)) {
			input.carrierRead(chain.id);
			cursor.refuseSubtreeAt(
				itemset,
				{ element: itemset, attribute: "nodeset" },
				X.itemsetScalarPosition[select],
				place,
			);
			return undefined;
		}
		const labelSites =
			typeof labelColumn === "string" ? X.lookupRefs : X.richLookupRefs;
		const valueSites =
			typeof valueColumn === "string" ? X.lookupRefs : X.richLookupRefs;
		const sites = X.lookupItemset;
		const refs = X.lookupRefs;
		const one = select === "select1";
		cursor.take({ element: itemset }, one ? sites.select1 : sites.select).value;
		// The table the itemset reads, at the read, through Nova's typed carrier.
		input.accounting.claimEntry(
			{ element: itemset, attribute: "nodeset" },
			TYPED_CARRIER,
			"instance-scheme:item-list",
			place,
		);
		input.carrierRead(chain.id);
		if (predicate === undefined)
			cursor.take(
				{ element: itemset, attribute: "nodeset" },
				one ? sites.select1Nodeset : sites.selectNodeset,
			).value;
		else
			field.expressions.push({
				slot: "lookup_options_source",
				text: nodeset.slice(predicate.from, predicate.to),
				at: { element: itemset, attribute: "nodeset" },
				key: one
					? "xform:select1/itemset@nodeset"
					: "xform:select/itemset@nodeset",
				mode: { target: "xform", constraint: false },
			});
		for (const [element, siteElement, siteRef] of [
			[
				label,
				one ? refs.select1Label : refs.selectLabel,
				one ? labelSites.select1LabelRef : labelSites.selectLabelRef,
			],
			[
				value,
				one ? refs.select1Value : refs.selectValue,
				one ? valueSites.select1ValueRef : valueSites.selectValueRef,
			],
		] as const) {
			cursor.take({ element }, siteElement).value;
			cursor.take({ element, attribute: "ref" }, siteRef).value;
		}
		if (sort !== undefined) {
			cursor.take({ element: sort }, X.itemsetSort).value;
			cursor.take({ element: sort, attribute: "ref" }, X.itemsetSort).value;
		}
		field.field.optionsSource = {
			kind: "lookup",
			tableId: table.tableId,
			labelColumnId: labelColumn,
			valueColumnId: valueColumn,
			...(sortColumn === undefined ? {} : { sortColumnId: sortColumn }),
		};
		return undefined;
	}

	// The worker's cases, in the shape Nova writes (`caseOptions.ts::caseOptionsNodeset`).
	if (
		runtime.ok &&
		bound?.kind === "native" &&
		bound.id === "casedb" &&
		chain.steps.length === 2 &&
		chain.steps[0] === "casedb" &&
		chain.steps[1] === "case" &&
		chain.predicates.length <= 2 &&
		singleAttribute(valueRef) === "case_id"
	) {
		const status =
			chain.predicates.length === 1
				? (["open", "closed"] as const).find((value) =>
						sameTree(nodeset, availableCasesNodeset(value)),
					)
				: undefined;
		if (chain.predicates.length === 0 || status !== undefined) {
			if (
				select !== "select1" ||
				sort !== undefined ||
				singleName(labelRef) !== "case_name"
			)
				return other();
			field.field.optionsSource = {
				kind: "available-cases",
				...(status !== undefined && { status }),
			};
			return {
				itemset,
				label,
				value,
				select,
				labelProperty: "case_name",
				status,
				filtered: false,
			};
		}
		const caseType = caseTypeTest(chain.predicates[0] as FormSyntax);
		const labelProperty = singleName(labelRef) ?? singleAttribute(labelRef);
		if (caseType === undefined || labelProperty === undefined) return other();
		const sortProperty =
			sortRef === undefined
				? undefined
				: (singleName(sortRef) ?? singleAttribute(sortRef));
		if (
			sortRef !== undefined &&
			(sortProperty === undefined ||
				!sameTree(sortRef, w.context([casePropertyStep(sortProperty)])))
		)
			return other();
		const filter = chain.predicates[1];
		if (filter !== undefined)
			field.expressions.push({
				slot: "lookup_options_source",
				text: nodeset.slice(filter.from, filter.to),
				at: { element: itemset, attribute: "nodeset" },
				key:
					select === "select1"
						? "xform:select1/itemset@nodeset"
						: "xform:select/itemset@nodeset",
				mode: { target: "xform", constraint: false },
			});
		field.field.optionsSource = {
			kind: "cases",
			caseType,
			labelProperty,
			...(sortProperty !== undefined && { sortProperty }),
		};
		return {
			itemset,
			label,
			value,
			select,
			caseType,
			labelProperty,
			...(sort === undefined ? {} : { sort }),
			filtered: filter !== undefined,
		};
	}
	return other();
}

/** `@case_type = '<type>'`, the first predicate Nova writes on a case choices itemset. */
function caseTypeTest(predicate: FormSyntax): string | undefined {
	if (predicate.kind !== "binary" || predicate.op !== "=") return undefined;
	const { left, right } = predicate;
	return left.kind === "axis" &&
		left.axis === "attribute" &&
		left.value.kind === "name" &&
		left.value.name === "case_type" &&
		right.kind === "string"
		? right.value
		: undefined;
}

/**
 * Settles a case choices proposal once its filter is bound: where the nodeset Nova's own emitter
 * rebuilds from the proposal equals the source's (`same`) and the label ref is the one it prints
 * for the property, the itemset is held; otherwise it is an itemset of another shape. `filtered`
 * is whether the expression stage holds the nodeset with its filter; one with none is claimed
 * here. A held itemset claims the `label` and the `value` the proposal read and nothing else of
 * its children, so a second `label` or `value`, which Core would read in place of the first, is
 * reported at the close.
 */
export function settleCaseChoices(
	cursor: XmlCursor,
	proposal: CaseChoicesProposal,
	place: HqPlace,
	same: boolean,
	filtered: boolean,
): void {
	const { itemset, select, label, value, sort } = proposal;
	// The label ref Nova writes for the property: an attribute for a case's own attributes, a
	// child step for every other property (`builder.ts::buildFieldParts`). A source label that
	// reads the other node of the same name is no case choices of Nova's.
	const labelSame = sameTree(
		plain(label, "ref") ?? "",
		w.context([casePropertyStep(proposal.labelProperty)]),
	);
	if (!same || !labelSame) {
		cursor.refuseSubtree(itemset, X.otherItemset, place);
		return;
	}
	const one = select === "select1";
	const element = one ? X.caseChoices.select1 : X.caseChoices.select;
	cursor.take({ element: itemset }, element).value;
	if (!filtered)
		cursor.take(
			{ element: itemset, attribute: "nodeset" },
			one ? X.caseChoices.select1Nodeset : X.caseChoices.selectNodeset,
		).value;
	for (const part of [label, value]) {
		cursor.take({ element: part }, element).value;
		cursor.take({ element: part, attribute: "ref" }, element).value;
	}
	if (sort !== undefined) {
		cursor.take({ element: sort }, X.itemsetSort).value;
		cursor.take({ element: sort, attribute: "ref" }, X.itemsetSort).value;
	}
}
