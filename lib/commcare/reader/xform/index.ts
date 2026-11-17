/**
 * The form reader: each form's source read into the draft's fields (stage 3),
 * then each field minted in document order and its expressions registered for
 * the expression stage (stage 5b). Parsing, the model, the body and their
 * join are this directory's other modules; this one runs them per form and
 * holds what a form's reading gives the later stages.
 */

import type { Element } from "domhandler";
import { cloneNode, isTag } from "domhandler";
import type { FieldKind, Uuid } from "@/lib/domain";
import type { FormStructureConnect } from "@/lib/domain/expression/formStructure";
import type {
	FieldExpressionSlotRef,
	ItextUnit,
	ProseSlotRef,
	SlotContextRef,
} from "@/lib/domain/expression/types";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	type GeneratedNodePurpose,
	generatedBaseName,
} from "../../xform/generatedNodes";
import { splitName } from "../../xmlNamespaces";
import { heldXmlParse } from "../../xmlParse";
import type { ClaimSite } from "../accounting";
import { applicationReading } from "../appShell";
import { numericSortColumns } from "../caseList/details";
import type { Claim } from "../claims";
import type { DraftForm, ReadContext } from "../context";
import { readerDefect } from "../defects";
import type { ExpressionReadEnv, GeneratedValue } from "../expressions";
import { externalKey } from "../identity";
import { pointerToken } from "../jsonCursor";
import type { DefaultEvent, ReadMode } from "../pendingExpressions";
import { placeKey, whereText } from "../place";
import { dateRangeGuesses } from "../search/dateRangeGuesses";
import type { ReadGeneratedNode } from "../types";
import type { XmlCursor } from "../xmlCursor";
import type { AppearanceForm } from "./appearances";
import { type ControlNode, readControls } from "./body";
import { X } from "./claims";
import { CONNECT_READS, readConnectBlocks, readConnectType } from "./connect";
import { labelCarriesMedia, readContainers, rootSections } from "./containers";
import {
	absolutePath,
	claimGeneratedNode,
	DATETIME_SIBLING_ENTRY,
	datetimeSpelling,
	isAllocatedName,
} from "./generated";
import { EMPTY_ITEXT_TABLE, type ItextTable, readItext } from "./itext";
import { joinForm } from "./join";
import { pendingLogic } from "./logic";
import { readMediaForms } from "./media";
import {
	type BindFacts,
	type DataNode,
	type DataTree,
	formPathOf,
	type NodeRefusal,
	readBinds,
	readDataTree,
	readInstances,
	readSetvalues,
	type SetvalueFacts,
} from "./model";
import type { CaseChoicesProposal } from "./options";
import {
	claimModelChildren,
	intentIdsOf,
	type ParsedXForm,
	parseXFormSource,
} from "./parse";
import { readText, rememberFormText, unitOf } from "./prose";
import { judgeShadows } from "./shadow";

export type NodeRole =
	| { readonly kind: "field"; readonly field: DraftField }
	| {
			readonly kind: "generated";
			readonly purpose: GeneratedNodePurpose;
			readonly owner: DataNode;
	  }
	/** Proposed by the form stage, settled by the case management stage. The purposes are
	 *  `GeneratedNodePurpose`'s own names. */
	| {
			readonly kind: "generated-candidate";
			readonly purpose: "url" | "datetime" | "trimmed" | "owner";
			readonly owner: DataNode | null;
			/** For `owner`: which of the two trees its calculate is. */
			readonly ownerValue?: "acting-user" | "unowned";
	  }
	| { readonly kind: "query-row"; readonly repeat: DraftField }
	| {
			readonly kind: "connect";
			readonly block: "learn_module" | "assessment" | "deliver_unit" | "task";
	  }
	/** A node of the case region, with the container it is where its name and shape tell. */
	| {
			readonly kind: "case-region";
			readonly container?:
				| "operations"
				| "condition"
				| "keyed"
				| "keyed-count"
				| "guard"
				| "selected-cases"
				| "selected-case"
				| "subcases";
	  }
	/** A root node named `case`, which the case management stage claims. */
	| { readonly kind: "root-case" };

/** One `vellum:role="SaveToCase"` element, as the case management stage takes it. */
export interface ReadSaveToCaseBlock {
	readonly element: Element;
	/** Its data path from the form's root. */
	readonly path: readonly string[];
	/** The repeat it stands in, by that repeat's draft field; null at the root. */
	readonly repeat: DraftField | null;
	/** Every bind and setvalue whose target is the block or lies under it. */
	readonly binds: readonly BindFacts[];
	readonly setvalues: readonly SetvalueFacts[];
	/** Its ancestors between its scope and itself, outermost first, each a `case-region` node. */
	readonly wrappers: readonly DataNode[];
	/** The refusal of the data tree that covers the block (two siblings of one name in it or
	 *  at it), which has claimed it with its binds and setvalues: the case management stage
	 *  reads nothing of it and refuses what stands around it for it alone under that refusal. */
	readonly refusal?: NodeRefusal;
}

/** One Connect element, read here and listed for the case management stage's `connectType`. */
export interface ReadConnectBlock {
	readonly block: "learn_module" | "assessment" | "deliver_unit" | "task";
	readonly id: string;
	readonly path: readonly string[];
}

/** One expression read from a field's source, registered once the field has its UUID. */
export interface DraftExpression {
	/** An expression slot, or a prose slot for a value one of its texts shows. */
	readonly slot: FieldExpressionSlotRef["slot"] | ProseSlotRef["slot"];
	/** For a choice's label, the option's position in the field's inline options. */
	readonly option?: number;
	/** HQ's text, as the source holds it. */
	readonly text: string;
	/** The node it was read from. */
	readonly at: ClaimSite;
	/** The surface key its claim is logged under. */
	readonly key: string;
	readonly mode: ReadMode;
	/** A default's event. */
	readonly event?: DefaultEvent;
}

/** A field as the form reader builds it: its kind's slots, less its logic, which is pending. */
export interface DraftField {
	readonly node: DataNode;
	/** A root Question List becomes a section once the form's root is known. */
	kind: FieldKind;
	readonly id: string;
	readonly parent: DraftField | null;
	/** True for the stand-in of a question that got a finding; never in a returned document. */
	readonly standIn: boolean;
	/** The refusal a stand-in's kind got, which covers its logic and its text; the stand-in of a
	 *  question id the grammar refuses carries none, its id's finding covering them. */
	standInClaim?: Claim<"refuse">;
	/** For a select with inline choices: the `item` each option was read from, in option order. */
	items?: Element[];
	/** Set by `mintFields`. */
	uuid: Uuid | undefined;
	/** The slots stages set. The assembly parses the whole with the kind's schema. */
	readonly field: Record<string, unknown>;
	/** Which scalar check its constraint carried. */
	scalarCheck?: "allow" | "reject";
	/** The control that draws it; undefined for a Hidden Value. */
	readonly control: ControlNode | undefined;
	/** Its place: the question at its data path. */
	readonly place: HqPlace;
	/** Its expressions, which `mintFields` registers under its UUID. */
	readonly expressions: DraftExpression[];
}

/** The names the source gives its nodes, which the expression stage binds a source's paths by. */
export interface ReadSourceNames {
	/** The data root's element name. */
	readonly root: string;
	/** Each field's path in the source, from the root. */
	fieldPath(uuid: Uuid): readonly string[] | undefined;
	/** What a source path names, or undefined where the form holds nothing there. */
	at(path: readonly string[]): SourceNodeRef | undefined;
	/** The inverse of `at`: the source path of a node, or undefined where the source names no
	 *  such node. A generated node is named by it, whose name the source may have suffixed
	 *  otherwise than Nova's allocator would. */
	nodePath(node: SourceNodeRef): readonly string[] | undefined;
}

export type SourceNodeRef =
	| { readonly kind: "field"; readonly uuid: Uuid }
	| { readonly kind: "query-row"; readonly repeat: Uuid }
	| {
			readonly kind: "repeat-attribute";
			readonly repeat: Uuid;
			readonly attribute: "ids" | "count" | "current_index" | "id" | "index";
	  }
	| {
			readonly kind: "generated";
			readonly purpose: GeneratedNodePurpose;
			readonly owner: Uuid;
	  };

export interface ReadXForm {
	readonly parsed: ParsedXForm;
	readonly cursor: XmlCursor;
	/** Every data node by its path joined with "/". */
	readonly nodes: ReadonlyMap<string, DataNode>;
	readonly roles: ReadonlyMap<DataNode, NodeRole>;
	readonly binds: ReadonlyMap<DataNode, BindFacts>;
	readonly setvalues: readonly SetvalueFacts[];
	/** A container's fields in order; `null` is the form's root. */
	childrenOf(parent: DraftField | null): readonly DraftField[];
	/** Nodes proposed as generated and not yet settled. */
	readonly candidates: readonly DataNode[];
	/** Settles a candidate: Nova's node, its parts claimed as the generated node of its purpose,
	 *  or the person's own Hidden Value. `operation` is the id of the case operation an `owner`
	 *  node serves, which its record keys it by; an `owner` node whose name is not the
	 *  allocator's for that id, or settled with none, is settled as the person's. */
	settle(
		node: DataNode,
		verdict: "generated" | "field",
		operation?: string,
	): void;
	/** Every generated node folded so far, in the order each was folded: what
	 *  `ReadFormFacts.generated` lists. */
	readonly generated: readonly ReadGeneratedNode[];
	/** Each validation count's calculate, by its absolute path: what the expression stage's
	 *  `generatedValues` holds for the form. */
	readonly generatedValues: ReadonlyMap<string, GeneratedValue>;
	/** The data path of every case region container and every Save to Case block, in document
	 *  order: what `ReadFormFacts.caseRegionPaths` lists. */
	readonly caseRegionPaths: readonly string[];
	/** Every node of the case region, in document order. */
	readonly caseRegion: readonly DataNode[];
	/** Every Save to Case block of the form, in document order, wherever it stands. */
	readonly saveToCaseBlocks: readonly ReadSaveToCaseBlock[];
	readonly connectBlocks: readonly ReadConnectBlock[];
	readonly connect: FormStructureConnect;
	readonly itext: ItextTable;
	/** Each declared secondary instance id to its `src`. */
	readonly instanceSources: ReadonlyMap<string, string>;
	/** Set by `mintFields`. */
	sourceNames: ReadSourceNames | undefined;
	/** The data path of every control whose appearance was accounted under an inert entry, in
	 *  body order: what `ReadFormFacts.inertAppearances` lists. */
	readonly inertAppearances: readonly string[];
	/** Each select's case choices, which stage 10 settles over the bound filter. */
	readonly caseChoices: ReadonlyMap<DraftField, CaseChoicesProposal>;
	/** The model-iteration repeats, which stage 10 holds to where model iteration is held. */
	readonly modelIterations: ReadonlySet<DraftField>;
}

type FormPlace = Extract<HqPlace, { kind: "form" }>;

/** The Save to Case blocks of a form, by the role the join gave their nodes: each block of the
 *  case region, and each the data tree refused, which no other role holds. */
function saveToCaseBlocks(
	tree: DataTree,
	roles: ReadonlyMap<DataNode, NodeRole>,
	binds: ReadonlyMap<DataNode, BindFacts>,
	setvalues: readonly SetvalueFacts[],
): ReadSaveToCaseBlock[] {
	const under = (path: readonly string[], target: readonly string[]) =>
		target.length >= path.length && path.every((step, i) => target[i] === step);
	return tree.order
		.filter(
			(node) =>
				node.role === "SaveToCase" &&
				(roles.get(node)?.kind === "case-region" ||
					(tree.refused.has(node) && !roles.has(node))),
		)
		.map((node) => {
			const refusal = tree.refused.get(node);
			let repeat: DraftField | null = null;
			const wrappers: DataNode[] = [];
			for (let at = node.parent; at !== null; at = at.parent) {
				const role = roles.get(at);
				if (role?.kind === "case-region") wrappers.unshift(at);
				else if (role?.kind === "query-row") {
					repeat = role.repeat;
					break;
				} else if (role?.kind === "field") {
					if (role.field.kind === "repeat") repeat = role.field;
					break;
				}
			}
			return {
				element: node.element,
				path: node.path,
				repeat,
				binds: [...binds]
					.filter(([at]) => under(node.path, at.path))
					.map(([, facts]) => facts),
				setvalues: setvalues.filter(
					(one) => one.target !== undefined && under(node.path, one.target),
				),
				wrappers,
				...(refusal === undefined ? {} : { refusal }),
			};
		});
}

/** Reads one form's source into its draft. */
function readForm(
	ctx: ReadContext,
	form: DraftForm,
	source: string | undefined,
): ReadXForm | null {
	const accounting = ctx.accounting;
	const formPlace = form.place as FormPlace;
	if (source === undefined || source === "") {
		accounting.finding(X.blankSource, formPlace);
		return null;
	}
	const parsedXml = heldXmlParse(source);
	if ("issue" in parsedXml) {
		if (parsedXml.kind === "doctype") accounting.finding(X.doctype, formPlace);
		else
			accounting.defect(
				formPlace,
				"xform:h:html",
				readerDefect.formSource(formPlace, parsedXml.kind),
			);
		return null;
	}
	/* The parse is shared and never written (`xmlParse.ts::heldXmlParse`);
	 * the ledger tells forms apart by their document, so a second form of the
	 * same text reads a copy. */
	const document = accounting.readsXml(parsedXml.doc)
		? cloneNode(parsedXml.doc, true)
		: parsedXml.doc;
	const cursor = accounting.xml(document, form.menu, form.index, formPlace);
	const root = document.children.find(isTag);
	const parsed = parseXFormSource({
		document,
		cursor,
		accounting,
		formPlace,
		xmlns: form.xmlns,
		intentIds: root === undefined ? new Set() : intentIdsOf(root),
	});
	if (parsed === undefined) return null;
	if (parsed.ignore.includes("markdown")) form.form.plainText = true;
	const tree = readDataTree(parsed, cursor, formPlace);
	claimModelChildren(parsed, tree, cursor, accounting, formPlace);
	const inCaseRegion = (node: DataNode) => {
		for (let at: DataNode | null = node; at !== null; at = at.parent)
			if (at.role === "SaveToCase") return true;
		return false;
	};
	const binds = readBinds(
		parsed,
		tree,
		cursor,
		formPlace,
		(node) =>
			node.role === "Repeat" ||
			node.parent?.role === "Repeat" ||
			inCaseRegion(node),
	);
	const setvalues = readSetvalues(parsed, tree);
	const instanceSources = readInstances(parsed, cursor, formPlace);
	const controls = readControls({
		parsed,
		tree,
		binds: binds.byNode,
		cursor,
		accounting,
		formPlace,
	});
	const intents: AppearanceForm = {
		intents: new Set(
			parsed.head.children
				.filter(isTag)
				.filter((child) => splitName(child.name).local === "intent")
				.map((child) => child.attribs.id)
				.filter((id): id is string => id !== undefined),
		),
		callouts: new Set(
			controls.all
				.filter((control) => {
					const type =
						control.node === undefined
							? undefined
							: binds.byNode.get(control.node)?.type;
					return (
						control.tag === "input" &&
						type !== undefined &&
						(type === "intent" || type === "xsd:intent") &&
						control.appearance?.startsWith("intent:") === true
					);
				})
				.map((control) =>
					(control.appearance as string).slice("intent:".length),
				),
		),
	};
	const joined = joinForm({
		parsed,
		tree,
		binds: binds.byNode,
		attributeBinds: binds.onAttributes,
		setvalues,
		controls,
		cursor,
		accounting,
		formPlace,
		lookup: ctx.input.lookup,
		instanceSources,
		intents,
		unreadTable: (table) => ctx.facts.unreadTables.push(table),
		target: ctx.input.target,
	});
	const sectioned = rootSections({
		root: joined.childrenOf(null),
		binds: binds.byNode,
		childrenOf: joined.childrenOf,
		labelMedia: (field) =>
			field.control !== undefined && labelCarriesMedia(field.control, parsed),
	});
	const inertAppearances = [...joined.inertAppearances];
	readContainers({
		cursor,
		accounting,
		scope: parsed.scope,
		groups: joined.groups,
		sectioned,
		childrenOf: joined.childrenOf,
		placeOf: (field) => field.place,
		intents,
		inertAppearance: (path) => inertAppearances.push(path),
	});
	const bodyIndex = new Map<string, number>();
	for (const field of joined.fields)
		if (field.control !== undefined)
			bodyIndex.set(
				field.node.path.join("/"),
				controls.all.indexOf(field.control),
			);
	inertAppearances.sort(
		(a, b) => (bodyIndex.get(a) ?? 0) - (bodyIndex.get(b) ?? 0),
	);

	// A finding on a node stands at the nearest question, else at the form: a data node, its
	// bind, its control and its setvalues stand for it, and a generated node for its owner.
	const nodeOfElement = new Map<Element, DataNode>();
	for (const node of tree.order) nodeOfElement.set(node.element, node);
	for (const [node, bind] of binds.byNode)
		nodeOfElement.set(bind.element, node);
	for (const control of controls.all)
		if (control.node !== undefined)
			nodeOfElement.set(control.element, control.node);
	for (const setvalue of setvalues) {
		const target = setvalue.target?.filter((step) => !step.startsWith("@"));
		const node =
			target === undefined ? undefined : tree.nodes.get(target.join("/"));
		if (node !== undefined) nodeOfElement.set(setvalue.element, node);
	}
	const placeOfNode = (node: DataNode): HqPlace | undefined => {
		const role = joined.roles.get(node);
		if (role?.kind === "field") return role.field.place;
		if (
			(role?.kind === "generated" || role?.kind === "generated-candidate") &&
			role.owner !== null
		) {
			const owner = joined.roles.get(role.owner);
			return owner?.kind === "field" ? owner.field.place : undefined;
		}
		return undefined;
	};
	const placeOf = (element: Element): HqPlace => {
		for (
			let at: Element | null = element;
			at !== null;
			at =
				at.parent !== null && at.parent.type === "tag"
					? (at.parent as Element)
					: null
		) {
			const node = nodeOfElement.get(at);
			const place = node === undefined ? undefined : placeOfNode(node);
			if (place !== undefined) return place;
		}
		return formPlace;
	};
	cursor.placeUnclaimed(placeOf);

	const controlOfElement = new Map<Element, ControlNode>();
	for (const control of controls.all)
		controlOfElement.set(control.element, control);
	judgeShadows({
		parsed,
		cursor,
		accounting,
		placeOf,
		enclosingControlPath: (element) => {
			for (
				let at: Element | null =
					element.parent !== null && element.parent.type === "tag"
						? (element.parent as Element)
						: null;
				at !== null;
				at =
					at.parent !== null && at.parent.type === "tag"
						? (at.parent as Element)
						: null
			) {
				const control = controlOfElement.get(at);
				if (control?.node !== undefined) return control.node.path;
			}
			return undefined;
		},
	});
	const connect = readConnectBlocks({
		parsed,
		order: tree.order,
		roles: joined.roles,
		binds: binds.byNode,
		cursor,
		accounting,
		formPlace,
		formUuid: form.uuid,
	});

	const caseRegion = tree.order.filter(
		(node) => joined.roles.get(node)?.kind === "case-region",
	);
	const rootName = parsed.dataRoot.name;
	const caseRegionPaths = caseRegion
		.filter((node) => {
			const role = joined.roles.get(node);
			return (
				node.role === "SaveToCase" ||
				(role?.kind === "case-region" && role.container !== undefined)
			);
		})
		.map((node) => absolutePath(node, rootName));
	const generated: ReadGeneratedNode[] = [];
	const record = (
		node: DataNode,
		purpose: GeneratedNodePurpose,
		owner: string,
	) =>
		generated.push({
			purpose,
			owner,
			path: absolutePath(node, rootName),
			name: node.name,
		});
	const candidates: DataNode[] = [];
	for (const { node, role } of joined.generated) {
		if (role.kind === "generated-candidate") candidates.push(node);
		else record(node, role.purpose, absolutePath(role.owner, rootName));
	}
	const settle: ReadXForm["settle"] = (node, verdict, operation) => {
		const at = candidates.indexOf(node);
		const role = joined.roles.get(node);
		if (at < 0 || role?.kind !== "generated-candidate")
			throw new Error(
				`The form reader was asked to settle a node of ${placeKey(formPlace)} as generated or as a field, and it proposed no such candidate. Settle only a node of ReadXForm.candidates.`,
			);
		candidates.splice(at, 1);
		// An owner node is Nova's only under the name the allocator gives the operation it
		// serves; under any other it is the person's own Hidden Value.
		const ownersName =
			role.purpose !== "owner" ||
			(operation !== undefined &&
				isAllocatedName(node.name, generatedBaseName("owner", operation)));
		if (verdict === "field" || !ownersName) {
			const field = joined.settleField(node);
			pendingLogic({
				cursor,
				fields: [field],
				binds: binds.byNode,
				setvalues: [],
				nodes: tree.nodes,
				roles: joined.roles,
				formPlace,
			});
			return;
		}
		const bind = binds.byNode.get(node);
		claimGeneratedNode(cursor, node, bind);
		const scope =
			node.parent === null
				? `/${rootName}`
				: absolutePath(node.parent, rootName);
		record(
			node,
			role.purpose,
			role.owner === null
				? `${scope}#${operation}`
				: absolutePath(role.owner, rootName),
		);
		// A date and time an app Nova published before kept the device's clock is saved as
		// CommCare HQ stores it at the first publish, which writes the form's source again: the
		// record names that source in the stored app, as the Save to Case reader's does.
		const ownerPath = role.owner === null ? undefined : formPathOf(role.owner);
		const calculate = bind?.logic.calculate;
		if (
			role.purpose === "datetime" &&
			ownerPath !== undefined &&
			calculate !== undefined &&
			datetimeSpelling(calculate, ownerPath) === "earlier"
		) {
			const readId =
				ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
			ctx.facts.sameStateRewrites.push({
				entry: DATETIME_SIBLING_ENTRY,
				path: `/_attachments/${pointerToken(`${readId ?? form.xmlns}.xml`)}`,
				register: "date-and-time-saved-as-hq-stores-it",
			});
		}
	};
	// Logic and load-time values (11), then text (12), both by the fields in document order.
	const fields = fieldsInOrder(joined.childrenOf);
	pendingLogic({
		cursor,
		fields,
		binds: binds.byNode,
		setvalues,
		nodes: tree.nodes,
		roles: joined.roles,
		formPlace,
	});
	const carriers = new Map<DataNode, ControlNode>();
	for (const { node, role } of joined.generated)
		if (role.kind === "generated" && role.purpose === "constraint-message") {
			const control = controls.all.find((one) => one.node === node);
			if (control !== undefined) carriers.set(role.owner, control);
		}
	const languages = applicationReading(ctx)?.languages;
	const itext =
		languages === undefined
			? undefined
			: readItext({
					itext: parsed.itext,
					scope: parsed.scope,
					cursor,
					accounting,
					formPlace,
					languages,
				});
	const text =
		itext === undefined
			? undefined
			: readText({
					cursor,
					accounting,
					scope: parsed.scope,
					formPlace,
					fields,
					binds: binds.byNode,
					allBinds: parsed.binds,
					body: parsed.body,
					setvalues,
					itext,
					plainText: parsed.ignore.includes("markdown"),
					carrierOf: (owner) => carriers.get(owner),
				});

	const xform: ReadXForm = {
		parsed,
		cursor,
		nodes: tree.nodes,
		roles: joined.roles,
		binds: binds.byNode,
		setvalues,
		childrenOf: joined.childrenOf,
		candidates,
		settle,
		generated,
		generatedValues: joined.generatedValues,
		caseRegionPaths,
		caseRegion,
		saveToCaseBlocks: saveToCaseBlocks(
			tree,
			joined.roles,
			binds.byNode,
			setvalues,
		),
		connectBlocks: connect.blocks,
		connect: connect.connect,
		itext: itext ?? EMPTY_ITEXT_TABLE,
		instanceSources,
		sourceNames: undefined,
		inertAppearances,
		caseChoices: joined.caseChoices,
		modelIterations: new Set(joined.modelIterations.keys()),
	};
	CONNECT_READS.set(xform, connect);
	if (text !== undefined) {
		rememberFormText(xform, text);
		readMediaForms(ctx, xform);
	}
	return xform;
}

/** A form's fields in document order: each container, then what it holds. */
function fieldsInOrder(
	childrenOf: (parent: DraftField | null) => readonly DraftField[],
): DraftField[] {
	const order: DraftField[] = [];
	const walk = (parent: DraftField | null) => {
		for (const field of childrenOf(parent)) {
			order.push(field);
			walk(field);
		}
	};
	walk(null);
	return order;
}

/** Stage 3: each form's source, read into its draft. */
export function readForms(ctx: ReadContext): void {
	const steps = readFormsSteps(ctx);
	while (!steps.next().done);
}

/** How many forms `readFormsSteps` reads between two stops. */
const FORMS_PER_STEP = 200;

/** `readForms`, stopping after every `FORMS_PER_STEP` forms until it is
 *  resumed, so a reading of an app at the byte cap is no one long piece. */
export function* readFormsSteps(ctx: ReadContext): Generator<void, void, void> {
	const attachments = applicationReading(ctx)?.attachments?.value;
	let read = 0;
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			if (read > 0 && read % FORMS_PER_STEP === 0) yield;
			read += 1;
			const readId =
				ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
			const value =
				readId === undefined ? undefined : attachments?.[`${readId}.xml`];
			ctx.writeDraft(() => {
				form.xform = readForm(
					ctx,
					form,
					typeof value === "string" ? value : undefined,
				);
			});
		}
	readConnectType(ctx);
}

/** A field's ids from the form's root, a query repeat's row left out: its identity key's path. */
function fieldPath(field: DraftField): string[] {
	const path: string[] = [];
	for (let at: DraftField | null = field; at !== null; at = at.parent)
		path.unshift(at.id);
	return path;
}

/** The fields of a form in document order: each container, then what it holds. */
function inDocumentOrder(xform: ReadXForm): DraftField[] {
	const order: DraftField[] = [];
	const walk = (parent: DraftField | null) => {
		for (const field of xform.childrenOf(parent)) {
			order.push(field);
			walk(field);
		}
	};
	walk(null);
	return order;
}

/**
 * Stage 5b: mints each form's fields in document order, and each inline choice once its value
 * passed, then registers every expression the form stage read from a field's source, under the
 * field's UUID.
 */
export function mintFields(ctx: ReadContext): void {
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const xform = form.xform;
			if (xform === null) continue;
			ctx.writeDraft(() => {
				// A candidate the case management stage left open is the person's Hidden Value.
				for (const node of [...xform.candidates]) xform.settle(node, "field");
				const fields = inDocumentOrder(xform);
				for (const field of fields) {
					const path = fieldPath(field);
					field.uuid = ctx.accounting.identity(
						ctx.resolver.claim(
							externalKey.field(form.xmlns, path),
							whereText(field.place),
						),
						field.place,
						"xform:model/instance//*",
					);
					const source = field.field.optionsSource as
						| { kind: string; options?: { value: string; uuid?: Uuid }[] }
						| undefined;
					if (source?.kind === "inline")
						for (const option of source.options ?? [])
							option.uuid = ctx.accounting.identity(
								ctx.resolver.claim(
									externalKey.selectOption(form.xmlns, path, option.value),
									whereText(field.place),
								),
								field.place,
								"xform:select1/item/value",
							);
				}
				for (const field of fields) {
					const uuid = field.uuid;
					if (uuid === undefined) continue;
					field.field.uuid = uuid;
					for (const expression of field.expressions) {
						const ref = draftExpressionRef(field, uuid, expression);
						if (ref === undefined) continue;
						ctx.pending.register(
							{
								ref,
								text: expression.text,
								mode: expression.mode,
								place: field.place,
								key: expression.key,
							},
							expression.at,
							expression.event === undefined
								? undefined
								: { event: expression.event },
						);
					}
				}
				xform.sourceNames = sourceNames(xform, fields);
			});
		}
}

/** The slot a field's expression is registered under: its own slot, or a choice's label by the
 *  option's UUID, undefined where the option got none (its value was refused). */
function draftExpressionRef(
	field: DraftField,
	uuid: Uuid,
	expression: DraftExpression,
): SlotContextRef | undefined {
	if (expression.slot !== "option_label")
		return { entity: "field", uuid, slot: expression.slot } as SlotContextRef;
	const source = field.field.optionsSource as
		| { options?: readonly { uuid?: Uuid }[] }
		| undefined;
	const optionUuid =
		expression.option === undefined
			? undefined
			: source?.options?.[expression.option]?.uuid;
	return optionUuid === undefined
		? undefined
		: { entity: "field", uuid, slot: "option_label", member: { optionUuid } };
}

function sourceNames(
	xform: ReadXForm,
	fields: readonly DraftField[],
): ReadSourceNames {
	const root = xform.parsed.dataRoot.name;
	const byUuid = new Map<Uuid, DraftField>();
	for (const field of fields)
		if (field.uuid !== undefined) byUuid.set(field.uuid, field);
	const REPEAT_ATTRIBUTES = new Set([
		"ids",
		"count",
		"current_index",
		"id",
		"index",
	]);
	return {
		root,
		fieldPath: (uuid) => {
			const field = byUuid.get(uuid);
			return field === undefined ? undefined : [root, ...field.node.path];
		},
		at: (path) => {
			if (path[0] !== root) return undefined;
			const last = path[path.length - 1];
			const attribute = last?.startsWith("@") ? last.slice(1) : undefined;
			const steps = path.slice(1, attribute === undefined ? undefined : -1);
			const node = xform.nodes.get(steps.join("/"));
			if (node === undefined) return undefined;
			const role = xform.roles.get(node);
			if (attribute !== undefined) {
				if (!REPEAT_ATTRIBUTES.has(attribute)) return undefined;
				const repeat =
					role?.kind === "query-row"
						? role.repeat.uuid
						: role?.kind === "field" && role.field.kind === "repeat"
							? role.field.uuid
							: undefined;
				return repeat === undefined
					? undefined
					: {
							kind: "repeat-attribute",
							repeat,
							attribute: attribute as
								| "ids"
								| "count"
								| "current_index"
								| "id"
								| "index",
						};
			}
			if (role?.kind === "field" && role.field.uuid !== undefined)
				return { kind: "field", uuid: role.field.uuid };
			if (role?.kind === "query-row" && role.repeat.uuid !== undefined)
				return { kind: "query-row", repeat: role.repeat.uuid };
			if (role?.kind === "generated") {
				const owner = xform.roles.get(role.owner);
				if (owner?.kind === "field" && owner.field.uuid !== undefined)
					return {
						kind: "generated",
						purpose: role.purpose,
						owner: owner.field.uuid,
					};
			}
			return undefined;
		},
		nodePath: (ref) => {
			const rowOf = (repeat: Uuid) => {
				for (const [node, role] of xform.roles)
					if (role.kind === "query-row" && role.repeat.uuid === repeat)
						return node;
				return undefined;
			};
			switch (ref.kind) {
				case "field": {
					const field = byUuid.get(ref.uuid);
					return field === undefined ? undefined : [root, ...field.node.path];
				}
				case "query-row": {
					const row = rowOf(ref.repeat);
					return row === undefined ? undefined : [root, ...row.path];
				}
				case "repeat-attribute": {
					const onRow = ref.attribute === "id" || ref.attribute === "index";
					const node = onRow ? rowOf(ref.repeat) : byUuid.get(ref.repeat)?.node;
					return node === undefined
						? undefined
						: [root, ...node.path, `@${ref.attribute}`];
				}
				case "generated":
					for (const [node, role] of xform.roles) {
						if (role.kind !== "generated" || role.purpose !== ref.purpose)
							continue;
						const owner = xform.roles.get(role.owner);
						if (owner?.kind === "field" && owner.field.uuid === ref.owner)
							return [root, ...node.path];
					}
					return undefined;
			}
		},
	};
}

/**
 * What the expression stage reads beside the document, built from each form's reading and keyed
 * by the form's UUID: the source's own names, the unit each referenced text id was read as (its
 * first owning slot in document order), the declared instances, the validation counts set
 * aside, the case id path of each Save to Case create, the form's place, and the ids an advanced
 * form's computed datums give; with the reading's table catalog, the record dialect's judge, and
 * the forms whose entry facts differ.
 */
export function expressionEnvOf(ctx: ReadContext): ExpressionReadEnv {
	const sourceNames = new Map<Uuid, ReadSourceNames>();
	const itextUnits = new Map<Uuid, ReadonlyMap<string, ItextUnit>>();
	const instanceSources = new Map<Uuid, ReadonlyMap<string, string>>();
	const generatedValues = new Map<Uuid, ReadonlyMap<string, GeneratedValue>>();
	const operationIdPaths = new Map<Uuid, ReadonlyMap<string, Uuid>>();
	const formPlaces = new Map<Uuid, HqPlace>();
	const computedDatums = new Map<Uuid, ReadonlySet<string>>();
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			operationIdPaths.set(form.uuid, form.operationIdPaths);
			formPlaces.set(form.uuid, form.place);
			if (form.docType === "AdvancedForm")
				computedDatums.set(form.uuid, computedDatumIds(form.json));
			const xform = form.xform;
			if (xform === null) continue;
			if (xform.sourceNames !== undefined)
				sourceNames.set(form.uuid, xform.sourceNames);
			instanceSources.set(form.uuid, xform.instanceSources);
			generatedValues.set(form.uuid, xform.generatedValues);
			const units = new Map<string, ItextUnit>();
			for (const id of xform.itext.ids()) {
				const owner = xform.itext.owners(id)[0];
				const unit = owner === undefined ? undefined : unitOf(owner);
				if (unit !== undefined) units.set(id, unit);
			}
			itextUnits.set(form.uuid, units);
		}
	return {
		lookup: ctx.input.lookup.definitions,
		sourceNames,
		itextUnits,
		instanceSources,
		generatedValues,
		operationIdPaths,
		recordDialect: ctx.input.recordDialect,
		entryFactsRefused: new Set(ctx.facts.entryFactsRefused),
		dateRangeGuesses: dateRangeGuesses(ctx),
		numericSortColumns: numericSortColumns(ctx),
		formPlaces,
		computedDatums,
		...(ctx.input.knownCaseTypes !== undefined && {
			knownCaseTypes: ctx.input.knownCaseTypes,
		}),
	};
}

/** The ids an advanced form's `arbitrary_datums` compute
 *  (`ArbitraryDatum.datum_id`), which its entry adds to the session. The case
 *  management reader claims the key; this reads it without claiming. */
function computedDatumIds(json: DraftForm["json"]): ReadonlySet<string> {
	const datums = json.peek("arbitrary_datums");
	const ids = new Set<string>();
	if (!Array.isArray(datums)) return ids;
	for (const datum of datums)
		if (
			typeof datum === "object" &&
			datum !== null &&
			typeof (datum as { datum_id?: unknown }).datum_id === "string"
		)
			ids.add((datum as { datum_id: string }).datum_id);
	return ids;
}
