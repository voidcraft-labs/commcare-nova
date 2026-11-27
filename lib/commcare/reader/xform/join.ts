import type { Uuid } from "@/lib/domain";
import { CONNECT_XMLNS } from "../../xform/connectActivity";
import { readNodePath } from "./model";
/**
 * The join of a form's model and body, as HQ's form builder makes it
 * (Vellum `parser.js`): every data node takes one `NodeRole`, in this order,
 * so a node another reader owns never becomes a field:
 *
 * 1. role nodes (`SaveToCase`, Connect, a model-iteration row) and everything under them;
 * 2. the case scaffolding of the case region;
 * 3. generated question siblings, proposed against the fields: the fields
 *    with a control are found first, then each node with no control is
 *    proposed against them and the Hidden Values found before it;
 * 4. every node a control names: a field of the kind the kind table gives;
 * 5. every remaining node with no element child: a Hidden Value;
 * 6. a remaining node with element children and no control: refused.
 *
 * Steps 2 and 3 are `generated.ts`'s readers; a node either assigns no field.
 * A node proposed as generated whose purpose the case management stage
 * settles is a candidate until it does (`settleField`).
 */

import { type Element, isTag } from "domhandler";
import { type FieldKind, isCaptureFieldKind } from "@/lib/domain/fields";
import {
	questionIdProblem,
	RESERVED_QUESTION_IDS,
} from "@/lib/domain/questionId";
import { NO_ENTRIES } from "@/lib/domain/records";
import { answerRequiresAndroid } from "@/lib/domain/submittedAnswerName";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { type SourceTable, tableOf } from "../../sourceKeys";
import { hiddenAnswerTypeOf } from "../../xform/bindType";
import {
	elementNamespace,
	isElement,
	JAVAROSA_NS,
	splitName,
	VELLUM_NS,
} from "../../xmlNamespaces";
import type { Accounting } from "../accounting";
import type { Claim } from "../claims";
import type { GeneratedValue } from "../expressions";
import { questionPlace } from "../place";
import type { ReaderInput, ReaderLookupCatalog, UnreadTable } from "../types";
import type { XmlCursor } from "../xmlCursor";
import { readAndroidApp, registerAndroidAppInputs } from "./androidApp";
import {
	type AppearanceForm,
	claimAppearance,
	classifyAppearance,
	INTENT_NAMING_ORPHAN,
	triggerStaysLabel,
} from "./appearances";
import {
	type ControlNode,
	isFieldListAppearance,
	type ReadControls,
	wrapsRepeat,
} from "./body";
import { type KindSites, X } from "./claims";
import { connectRoleSite } from "./connect";
import {
	absolutePath,
	type CaseRegionContainer,
	claimGeneratedNode,
	claimGeneratedSetvalue,
	G,
	type QueryPlacementParts,
	readCaseRegion,
	readQueryPlacement,
	recognizeConstraintMessage,
	recognizeGenerated,
} from "./generated";
import { hqQuestionType } from "./hqQuestionType";
import type { DraftField, NodeRole } from "./index";
import {
	type FieldKindFacts,
	type FieldKindRow,
	fieldKindOf,
	stripXsd,
} from "./kinds";
import {
	type AttributeBind,
	attributeNameIn,
	type BindFacts,
	type DataNode,
	type DataTree,
	type SetvalueFacts,
} from "./model";
import { type CaseChoicesProposal, readChoices } from "./options";
import { intentIdsOf, ODK_NS, type ParsedXForm } from "./parse";
import {
	type FormRefusals,
	refuseBindLogic,
	type StandingRefusal,
} from "./refusals";
import { type RepeatRead, readRepeat, settleRepeatCount } from "./repeats";

/** The intent class of CommCare's print action, which the form builder reads as its print
 *  question (`intentManager.js::syncMugWithIntent`). */
const PRINT_ACTION = "org.commcare.dalvik.action.PRINT";

type FormPlace = Extract<HqPlace, { kind: "form" }>;

type QueryPurpose =
	| "query-ids"
	| "query-count"
	| "query-position"
	| "query-id"
	| "query-index";

const XFORM = { target: "xform", constraint: false } as const;

/** The Connect roles HQ's form builder writes on a block (`commcareConnect.js`), by the block. */
const CONNECT_ROLES: SourceTable<
	Extract<NodeRole, { kind: "connect" }>["block"]
> = tableOf({
	ConnectLearnModule: "learn_module",
	ConnectAssessment: "assessment",
	ConnectDeliverUnit: "deliver_unit",
	ConnectTask: "task",
});

export interface JoinInput {
	readonly parsed: ParsedXForm;
	readonly tree: DataTree;
	readonly binds: ReadonlyMap<DataNode, BindFacts>;
	readonly attributeBinds: readonly AttributeBind[];
	readonly setvalues: readonly SetvalueFacts[];
	readonly controls: ReadControls;
	readonly cursor: XmlCursor;
	/** The refusals the form's cursor has made, whose binds a refused block refuses with it. */
	readonly refusals: FormRefusals;
	readonly accounting: Accounting;
	readonly formPlace: FormPlace;
	readonly lookup: ReaderLookupCatalog;
	readonly instanceSources: ReadonlyMap<string, string>;
	readonly intents: AppearanceForm;
	readonly unreadTable: (table: UnreadTable) => void;
	/** Notes an instance a choice list's itemset reads. */
	readonly carrierRead: (id: string) => void;
	/** `ReaderInput.target`, which a capture's link node names. */
	readonly target: ReaderInput["target"];
}

/** A generated node the join recognized, with its owner's node. */
export interface JoinedGenerated {
	readonly node: DataNode;
	readonly role: Extract<
		NodeRole,
		{ kind: "generated" | "generated-candidate" }
	>;
}

export interface JoinedForm {
	readonly roles: ReadonlyMap<DataNode, NodeRole>;
	/** Every field in data-tree order. */
	readonly fields: readonly DraftField[];
	/** A container's fields in order; `null` is the form's root. */
	childrenOf(parent: DraftField | null): readonly DraftField[];
	/** Every group field with its control, in data-tree order, for the containers' claims. */
	readonly groups: readonly {
		readonly field: DraftField;
		readonly control: ControlNode;
	}[];
	/** The data path of every control whose appearance was accounted under an inert entry, in
	 *  body order. */
	readonly inertAppearances: readonly string[];
	/** The data path of every control whose appearance's settings Nova writes in another spelling. */
	readonly respelledAppearances: readonly string[];
	/** Each select's case choices, decided once its filter is bound. */
	readonly caseChoices: ReadonlyMap<DraftField, CaseChoicesProposal>;
	/** The model-iteration repeats, by field. */
	readonly modelIterations: ReadonlyMap<
		DraftField,
		Extract<RepeatRead, { kind: "model-iteration" }>
	>;
	/** Every node recognized as generated or proposed as a candidate, in data-tree order. */
	readonly generated: readonly JoinedGenerated[];
	/** Each validation count's calculate, by its absolute path, for the expression stage. */
	readonly generatedValues: ReadonlyMap<string, GeneratedValue>;
	/** Reads a candidate the case management stage did not settle as generated: the node becomes
	 *  the Hidden Value it is, with the claims any Hidden Value takes. */
	settleField(node: DataNode): DraftField;
	attachActivity(node: DataNode, activity: Record<string, unknown>): DraftField;
	attachCaseChange(node: DataNode, operationUuid: Uuid): void;
}

/**
 * A question's data node's claim under the type CommCare HQ's question reader gives it
 * (`hqQuestionType.ts`), the type the lane's question reading records there: the row's own,
 * or the row's claim under the other type HQ gives a question of the row (`KindSites.nodeAs`). A
 * question with no control, a Hidden Value, is HQ's `DataBindOnly`, the row's own. HQ's index
 * gives a type to every control of a row the reader holds (`kinds.ts` leaves an upload whose bind
 * is not `binary` unclaimed), and a control it gives none keeps the row's own claim.
 */
function nodeClaimOf(
	sites: KindSites,
	control: ControlNode | undefined,
	bindType: string | undefined,
): Claim<"take"> {
	if (control === undefined) return sites.node;
	const type = hqQuestionType({
		tag: control.tag,
		type: bindType,
		mediaType: control.mediaType,
		appearance: control.appearance,
	});
	if (type === null || sites.node.key === `mug:${type}`) return sites.node;
	return sites.nodeAs?.[type] ?? sites.node;
}

/** A control's tag as the kind table names it. */
function controlFact(tag: ControlNode["tag"]): FieldKindFacts["control"] {
	return tag === "group" || tag === "repeat" ? "none" : tag;
}

/** The node's namespace differs from its parent's by a default declaration of its own. */
export function ownNamespace(node: DataNode, parsed: ParsedXForm): boolean {
	if (!Object.hasOwn(node.element.attribs, "xmlns")) return false;
	if (splitName(node.element.name).prefix !== "") return false;
	const parent = node.element.parent;
	const parentNamespace =
		parent !== null && isTag(parent)
			? elementNamespace(parent, parsed.scope(parent))
			: null;
	return (
		elementNamespace(node.element, parsed.scope(node.element)) !==
		parentNamespace
	);
}

/**
 * Registers a generated node's calculate, which the emitter writes and no slot holds, for the
 * uses its syntax makes alone (`PendingExpression.usesOnly`), read in its owner field's logic.
 */
export function registerGeneratedUses(
	owner: DraftField,
	bind: BindFacts | undefined,
): void {
	const calculate = bind?.logic.calculate;
	if (bind === undefined || calculate === undefined) return;
	owner.expressions.push({
		slot: "relevant",
		text: calculate,
		at: { element: bind.element, attribute: "calculate" },
		key: "xform:model/bind@calculate",
		mode: XFORM,
		usesOnly: true,
	});
}

/** Whether Java's `String.trim()` empties a text, which is when Core drops it as no value
 *  (`XFormParser.getXMLDocument`): every code unit at or below U+0020. A no-break space is a
 *  value. */
function javaTrimEmpty(text: string): boolean {
	for (let index = 0; index < text.length; index++)
		if (text.charCodeAt(index) > 0x20) return false;
	return true;
}

/** The surface key a data node is named by in the form's instance: a child of the data root,
 *  or one deeper. */
function dataNodeKey(node: DataNode): string {
	return node.path.length === 1
		? "xform:model/instance/*/*"
		: "xform:model/instance//*";
}

export function joinForm(input: JoinInput): JoinedForm {
	const { tree, cursor, accounting, formPlace, parsed } = input;
	const roles = new Map<DataNode, NodeRole>();
	const fields: DraftField[] = [];
	const fieldOf = new Map<DataNode, DraftField>();
	const controlField = new Map<ControlNode, DraftField>();
	const groups: { field: DraftField; control: ControlNode }[] = [];
	const inertAppearances: string[] = [];
	const respelledAppearances: string[] = [];
	const caseChoices = new Map<DraftField, CaseChoicesProposal>();
	const modelIterations = new Map<
		DraftField,
		Extract<RepeatRead, { kind: "model-iteration" }>
	>();
	const counted: {
		field: DraftField;
		control: ControlNode;
		read: Extract<RepeatRead, { kind: "count" }>;
	}[] = [];
	const placeOf = (node: DataNode) => questionPlace(formPlace, node.path);
	/** Nodes a refusal of their role covers, which take no role and no field. */
	const covered = new Set<DataNode>();

	// 1. Role nodes.
	const under = (node: DataNode, role: NodeRole) => {
		roles.set(node, role);
		for (const child of node.children) under(child, role);
	};
	for (const node of tree.order) {
		if (roles.has(node) || tree.refused.has(node) || covered.has(node))
			continue;
		if (node.role === undefined) continue;
		const block = CONNECT_ROLES.get(node.role);
		if (node.role === "SaveToCase") under(node, { kind: "case-region" });
		else if (block !== undefined) under(node, { kind: "connect", block });
		else if (node.role === "ConnectWorkAreaUpdate") {
			const [update] = node.children;
			const leaves = [
				"work_area_id",
				"status",
				"reason",
				"additional_details",
				"photo_evidence",
			];
			const forwardingLosesPhoto =
				node.children.length === 1 &&
				update?.name === "work_area_update" &&
				elementNamespace(update.element, parsed.scope(update.element)) ===
					CONNECT_XMLNS &&
				update.element.attribs.id === node.name &&
				update.children.length === leaves.length &&
				update.children.every(
					(child, index) =>
						child.name === leaves[index] &&
						elementNamespace(child.element, parsed.scope(child.element)) ===
							CONNECT_XMLNS &&
						child.children.length === 0,
				);
			const refusal: StandingRefusal = {
				claim: forwardingLosesPhoto
					? X.connectWorkAreaPhotoNotForwarded
					: X.connectWorkAreaUpdate,
				place: placeOf(node),
			};
			cursor.refuseSubtreeAt(
				node.element,
				connectRoleSite(node.element, parsed.scope) ?? {
					element: node.element,
				},
				refusal.claim,
				refusal.place,
			);
			// The update is refused whole: its nodes, and what each node's bind
			// says it does (the expressions the form builder writes on its leaves).
			const cover = (at: DataNode) => {
				covered.add(at);
				const bind = input.binds.get(at);
				if (bind !== undefined)
					refuseBindLogic(cursor, input.refusals, bind.element, refusal);
				for (const child of at.children) cover(child);
			};
			cover(node);
		}
	}

	// 2. The case region, which the case management stage reads.
	const region = readCaseRegion({
		order: tree.order,
		binds: input.binds,
		setvalues: input.setvalues,
		controlOf: input.controls.byNode,
		taken: (node) =>
			(roles.has(node) && roles.get(node)?.kind !== "case-region") ||
			tree.refused.has(node) ||
			covered.has(node),
	});
	for (const [node, container] of region)
		roles.set(
			node,
			container === undefined
				? { kind: "case-region" }
				: { kind: "case-region", container: container as CaseRegionContainer },
		);

	const generated: JoinedGenerated[] = [];
	const generatedValues = new Map<string, GeneratedValue>();
	const root = parsed.dataRoot.name;
	const setGenerated = (node: DataNode, role: JoinedGenerated["role"]) => {
		roles.set(node, role);
		generated.push({ node, role });
	};

	/** The field a node's data parent makes: the nearest ancestor that is a field, a model-iteration
	 *  row standing for its repeat. */
	const dataParent = (node: DataNode): DraftField | null => {
		for (let at = node.parent; at !== null; at = at.parent) {
			const role = roles.get(at);
			if (role?.kind === "query-row") return role.repeat;
			const field = fieldOf.get(at);
			if (field !== undefined) return field;
		}
		return null;
	};

	const make = (
		node: DataNode,
		parent: DraftField | null,
		control: ControlNode | undefined,
		kind: DraftField["kind"],
		standIn: boolean,
		slots: Readonly<Record<string, unknown>> = {},
	): DraftField => {
		const bind = input.binds.get(node)?.element;
		const dataLock = attributeNameIn(node.element, parsed, VELLUM_NS, "lock");
		const bindLock =
			bind === undefined
				? undefined
				: attributeNameIn(bind, parsed, VELLUM_NS, "lock");
		const locked =
			(kind === "hidden" &&
				dataLock !== undefined &&
				node.element.attribs[dataLock] === "all") ||
			(bind !== undefined &&
				bindLock !== undefined &&
				bind.attribs[bindLock] === "all");
		for (const [element, attribute, site] of [
			[node.element, dataLock, "node"],
			[bind, bindLock, "bind"],
		] as const) {
			if (element === undefined || attribute === undefined) continue;
			if (locked && element.attribs[attribute] === "all")
				cursor.take({ element, attribute }, X.vellumLock[site]).value;
			else
				cursor.refuse(
					{ element, attribute },
					X.unrecognizedLock[site],
					placeOf(node),
				);
		}
		const field: DraftField = {
			node,
			kind,
			id: node.name,
			parent,
			dataParent: parent,
			standIn,
			uuid: undefined,
			field: {
				kind,
				id: node.name,
				...slots,
				...(locked && { lockedInHq: true }),
			},
			control,
			place: placeOf(node),
			expressions: [],
		};
		fields.push(field);
		fieldOf.set(node, field);
		roles.set(node, { kind: "field", field });
		if (control !== undefined) controlField.set(control, field);
		return field;
	};

	/** The question id rule, at the question's data node: an id that passes is held there, and
	 *  one that fails is refused there, and the field stands in. The node's key is the one the
	 *  form's instance spells it by: a child of the data root, or one deeper. */
	const idFinding = (node: DataNode): boolean => {
		const key = dataNodeKey(node);
		const problem = questionIdProblem(node.name);
		if (problem === undefined) {
			accounting.claimEntry(
				{ element: node.element },
				answerRequiresAndroid(
					node.name,
					elementNamespace(node.element, parsed.scope(node.element)),
				)
					? X.androidAnswer.entry
					: node.name.toLowerCase() === "script"
						? X.questionIdReserved.entry
						: X.questionId.top.entry,
				key,
				placeOf(node),
			);
			return false;
		}
		const lowered = node.name.toLowerCase();
		const reservedAnyCase =
			problem === "reserved-name" &&
			RESERVED_QUESTION_IDS.anyCase.has(lowered) &&
			lowered !== "meta";
		const refusal = reservedAnyCase ? X.submittedCase : X.questionIdGrammar;
		accounting.claimEntry(
			{ element: node.element },
			refusal.entry,
			key,
			placeOf(node),
			{ name: node.name },
		);
		return true;
	};

	/** Claims what stands on a field's data node whatever its kind. */
	const claimNode = (
		node: DataNode,
		holdsNamespace = false,
		kind?: FieldKind,
	) => {
		if (ownNamespace(node, parsed) && !holdsNamespace)
			cursor.refuse(
				{ element: node.element, attribute: "xmlns" },
				X.dataNodeXmlns,
				placeOf(node),
			);
		if (node.children.length === 0 && !javaTrimEmpty(node.text))
			accounting.findingAtNode(
				kind !== undefined && isCaptureFieldKind(kind)
					? X.captureDefaultDataValue
					: X.defaultDataValue,
				placeOf(node),
				{ element: node.element },
				dataNodeKey(node),
				{ name: node.name },
			);
	};

	const inRepeat = (parent: DraftField | null): boolean =>
		parent !== null && (parent.kind === "repeat" || inRepeat(parent.parent));

	const hasDefault = (node: DataNode) =>
		input.setvalues.some(
			(one) =>
				(one.event === "xforms-ready" || one.event === "jr-insert") &&
				one.target !== undefined &&
				one.target.length === node.path.length &&
				one.target.every((step, i) => step === node.path[i]),
		);

	// The head's `odkx:intent`s by id, the first of each: a callout question is refused by what its
	// intent says, the print action (the form builder's print question) or `appearance="quick"`
	// (which no editor writes) before the callout kind, so its one finding names the decisive cause.
	const ambiguousActions = new Set<string>();
	const callouts = new Map<string, ControlNode>();
	const naming = new Map<string, ControlNode>();
	for (const control of input.controls.all) {
		const appearance = control.appearance;
		if (control.tag !== "input" || !appearance?.startsWith("intent:")) continue;
		const id = appearance.slice("intent:".length);
		const type =
			control.node === undefined
				? undefined
				: input.binds.get(control.node)?.type;
		const into =
			type !== undefined && stripXsd(type) === "intent" ? callouts : naming;
		if (!into.has(id)) into.set(id, control);
		else if (into === callouts) ambiguousActions.add(id);
	}
	const intentsById = new Map<string, Element>();
	for (const element of parsed.head.children) {
		if (!isTag(element)) continue;
		if (!isElement(element, parsed.scope(element), ODK_NS, "intent")) continue;
		const id = element.attribs.id;
		if (id === undefined) continue;
		if (intentsById.has(id)) ambiguousActions.add(id);
		else intentsById.set(id, element);
	}
	const calloutClaim = (control: ControlNode | undefined) => {
		const appearance = control?.appearance;
		const intent = appearance?.startsWith("intent:")
			? intentsById.get(appearance.slice("intent:".length))
			: undefined;
		if (intent && ambiguousActions.has(intent.attribs.id ?? ""))
			return X.refusedKind.intent;
		if (intent?.attribs.class === PRINT_ACTION)
			return X.refusedKind.printCallout;
		if (intent?.attribs.appearance === "quick")
			return X.refusedKind.quickCallout;
		return X.refusedKind.intent;
	};

	/** A question's kind row and its claims. */
	const readQuestion = (
		node: DataNode,
		control: ControlNode | undefined,
		parent: DraftField | null,
	): DraftField => {
		const bind = input.binds.get(node);
		const place = placeOf(node);
		const facts: FieldKindFacts = {
			control: control === undefined ? "none" : controlFact(control.tag),
			bindType: bind?.type === undefined ? undefined : stripXsd(bind.type),
			mediaType: control?.mediaType,
			appearance: control?.appearance,
			hasCalculate: bind?.logic.calculate !== undefined,
			hasDefault: hasDefault(node),
			inRepeat: inRepeat(parent),
		};
		let row: FieldKindRow | undefined = fieldKindOf(facts);
		const appHead = control?.appearance?.startsWith("intent:")
			? intentsById.get(control.appearance.slice("intent:".length))
			: undefined;
		const app =
			row?.sites === X.kind.androidApp &&
			calloutClaim(control) === X.refusedKind.intent &&
			appHead &&
			!ambiguousActions.has(appHead.attribs.id ?? "")
				? readAndroidApp(appHead, node, parsed, tree)
				: undefined;
		if (row?.sites === X.kind.androidApp && !app)
			row = {
				matches: row.matches,
				kind: undefined,
				claim: calloutClaim(control),
			};

		// A trigger whose appearance is not exactly `minimal` is a label only where its
		// appearance leaves Android's widget no acknowledge. Otherwise it is a confirmation.
		if (
			control?.tag === "trigger" &&
			row?.sites === X.kind.acknowledge &&
			control.appearance !== undefined
		) {
			const verdict = classifyAppearance(
				control,
				bind,
				control.appearance,
				input.intents,
			);
			if (
				verdict.kind === "claim" &&
				triggerStaysLabel(verdict, control.appearance)
			) {
				row = fieldKindOf({ ...facts, appearance: "minimal" });
			}
		}
		const stood = idFinding(node);
		const namespace =
			row?.kind === "hidden" && ownNamespace(node, parsed)
				? node.element.attribs.xmlns
				: undefined;
		const holdsNamespace = namespace !== undefined && namespace.length > 0;
		if (holdsNamespace)
			cursor.take(
				{ element: node.element, attribute: "xmlns" },
				X.hiddenNamespace,
			).value;
		claimNode(node, holdsNamespace, row?.kind);
		if (row === undefined) return make(node, parent, control, "hidden", true);
		if (row.kind === undefined || row.sites === undefined) {
			const claim =
				row.claim === X.refusedKind.intent
					? calloutClaim(control)
					: (row.claim as Claim<"refuse">);
			// A bind type Vellum does not write is named by the type as written.
			const detail =
				claim === X.refusedKind.inputOtherType && bind?.type !== undefined
					? { name: bind.type }
					: undefined;
			cursor.refuse({ element: node.element }, claim, place, detail);
			if (control !== undefined)
				cursor.refuseSubtree(control.element, claim, place, detail);
			if (bind?.type !== undefined)
				cursor.refuse(
					{ element: bind.element, attribute: "type" },
					claim,
					place,
					detail,
				);
			const standIn = make(node, parent, control, "hidden", true);
			standIn.standInRefusal =
				detail === undefined ? { claim, place } : { claim, place, detail };
			return standIn;
		}
		const sites = row.sites;
		// A Hidden Value with both sources outside every repeat is claimed once the bound
		// document says whether a runtime reads its default (`afterBinding.ts::settleBothSources`).
		const bothSources = sites === X.kind.hiddenBothUnread;
		if (!bothSources)
			cursor.take(
				{ element: node.element },
				nodeClaimOf(sites, control, bind?.type),
			).value;
		if (control !== undefined) {
			if (sites.control !== undefined)
				cursor.take({ element: control.element }, sites.control).value;
			if (
				(control.path === "ref" || control.path === "nodeset") &&
				sites.ref !== undefined
			)
				cursor.take(
					{ element: control.element, attribute: control.path },
					sites.ref,
				).value;
			if (control.mediaType !== undefined && sites.mediatype !== undefined)
				cursor.take(
					{ element: control.element, attribute: "mediatype" },
					sites.mediatype,
				).value;
		}
		const typeClaim = row.typeClaim ?? sites.type;
		if (
			bind?.type !== undefined &&
			typeClaim !== undefined &&
			!(bothSources && typeClaim === sites.type)
		) {
			const typeSite = { element: bind.element, attribute: "type" };
			cursor.take(typeSite, typeClaim).value;
			if (row.kind === "hidden" && facts.bindType === "string")
				cursor.within(typeSite, typeClaim, ["jr-type:string"]);
		}
		const field = make(
			node,
			parent,
			control,
			row.kind,
			stood,
			holdsNamespace
				? { ...row.slots, answerNamespace: namespace }
				: (row.slots ?? NO_ENTRIES),
		);
		// A text or date-and-time class is one Nova's automatic type can write;
		// whether it does here needs the bound document's writes and calculate,
		// so `afterBinding.ts::settleHiddenAnswerTypes` decides it. Every other
		// class, an absent type among them, is the author's choice.
		if (row.kind === "hidden") {
			const answerType = hiddenAnswerTypeOf(bind?.type);
			if (answerType !== "text" && answerType !== "datetime")
				field.field.answerType = answerType;
		}
		if (app) field.androidApp = { kind: "open-app", app };
		if (bothSources)
			field.bothSources = {
				typeDeferred: bind?.type !== undefined && typeClaim === sites.type,
			};
		if (control === undefined) return field;
		const actionId =
			control.tag === "input" && control.appearance?.startsWith("intent:")
				? control.appearance.slice("intent:".length)
				: undefined;
		// A matching action is claimed once its source and every named result
		// have been identified. An unusable action must account for its input
		// appearance as refused at the same place.
		const pendingApp =
			actionId !== undefined &&
			input.intents.callouts.has(actionId) &&
			intentsById.has(actionId);
		if (!pendingApp && control.appearance !== undefined) {
			const verdict = classifyAppearance(
				control,
				bind,
				control.appearance,
				input.intents,
			);
			if (verdict.kind === "held") {
				if (sites.appearance !== undefined)
					cursor.take(
						{ element: control.element, attribute: "appearance" },
						sites.appearance,
					).value;
			} else {
				const claimed = claimAppearance(
					cursor,
					accounting,
					control,
					verdict,
					place,
					field,
				);
				if (claimed.inert) inertAppearances.push(node.path.join("/"));
				if (claimed.respelled) respelledAppearances.push(node.path.join("/"));
			}
		}
		if (control.tag === "upload") readImageDimension(control, field, place);
		if (control.tag === "select" || control.tag === "select1") {
			const proposal = readChoices({
				control,
				field,
				parsed,
				cursor,
				accounting,
				place,
				lookup: input.lookup,
				instanceSources: input.instanceSources,
				unreadTable: input.unreadTable,
				carrierRead: input.carrierRead,
			});
			if (proposal !== undefined) caseChoices.set(field, proposal);
		}
		return field;
	};

	/** `jr:imageDimensionScaledMax` on an upload. */
	const readImageDimension = (
		control: ControlNode,
		field: DraftField,
		place: HqPlace,
	) => {
		const name = attributeNameIn(
			control.element,
			parsed,
			JAVAROSA_NS,
			"imageDimensionScaledMax",
		);
		if (name === undefined) return;
		const node = { element: control.element, attribute: name };
		const written = control.element.attribs[name] ?? "";
		const digits = written.endsWith("px") ? written.slice(0, -2) : written;
		// Core reads the value with `Integer.parseInt`, which takes one leading sign.
		const number = /^[+-]?\d+$/.test(digits) ? Number(digits) : undefined;
		const image = field.kind === "image";
		let entry: string;
		if (
			number === undefined ||
			number > 2147483647 ||
			number < -2147483648 ||
			(image && (number === 0 || number < -1))
		) {
			cursor.refuse(node, X.imageMaxDimensionInvalid, place, { name: written });
			entry = X.imageMaxDimensionInvalid.entry;
		} else if (image && number > 0) {
			cursor.take(node, X.imageMaxDimension).value;
			field.field.maxDimension = number;
			entry = X.imageMaxDimension.entry;
		}
		// Any integer on another upload, and `-1` on an image, Android's own no-limit value
		// (`ImageWidget`), the state with none.
		else {
			cursor.account(node, X.imageMaxDimensionElsewhere, place);
			entry = X.imageMaxDimensionElsewhere.entry;
		}
		// The extension parser's claim stands at the control (`xmlCursor.ts::recordedNode`);
		// Core's parser also reads the attribute by name, a use of its own at the attribute.
		accounting.claimEntry(
			node,
			entry,
			"xform:upload@jr:imageDimensionScaledMax",
			place,
			{ name: written },
		);
	};

	/** A control's field, by the nearest ancestor control that made a container field. */
	const controlParent = (control: ControlNode): DraftField | null => {
		for (let at = control.parent; at !== null; at = at.parent) {
			const field = controlField.get(at);
			if (field !== undefined) return field;
		}
		return null;
	};

	/** The nearest repeat at or above a field. */
	const repeatOf = (field: DraftField | null): DraftField | null => {
		for (let at = field; at !== null; at = at.parent)
			if (at.kind === "repeat") return at;
		return null;
	};

	/** The control just before one among its parent's controls. */
	const previousControl = (control: ControlNode): ControlNode | undefined => {
		const siblings = control.parent?.children ?? input.controls.roots;
		const index = siblings.indexOf(control);
		return index > 0 ? siblings[index - 1] : undefined;
	};

	/** A query repeat's count placement, by its wrapper: read where a repeat names the wrapper's
	 *  row and its `jr:count` the wrapper's count node. */
	const queryPlacements = new Map<DataNode, QueryPlacementParts>();
	const countPlacementOf = (
		wrapper: DataNode,
	): QueryPlacementParts | undefined => {
		if (queryPlacements.has(wrapper)) return queryPlacements.get(wrapper);
		const row = wrapper.children.find((child) => child.name === "item");
		const parts =
			row === undefined || wrapper.role !== undefined
				? undefined
				: readQueryPlacement(wrapper, row, input.binds, input.setvalues);
		if (parts !== undefined) {
			accounting.noteRebuild();
			queryPlacements.set(wrapper, parts);
		}
		return parts;
	};
	/** The `<group ref="…/r">` around a count-placement repeat's group, which no runtime draws:
	 *  claimed here, and no field. */
	const queryWrapperGroup = (control: ControlNode): boolean => {
		const node = control.node;
		if (
			node === undefined ||
			control.tag !== "group" ||
			control.appearance !== undefined ||
			control.children.length !== 1
		)
			return false;
		const inner = control.children[0] as ControlNode;
		const repeat = inner.children.length === 1 ? inner.children[0] : undefined;
		if (
			inner.tag !== "group" ||
			repeat?.tag !== "repeat" ||
			repeat.node?.parent !== node ||
			countPlacementOf(node) === undefined
		)
			return false;
		if (
			(control.element.children.filter(isTag) as { name: string }[]).some(
				(child) => splitName(child.name).local === "label",
			)
		)
			return false;
		cursor.derived({ element: control.element }, G.queryWrapperGroup);
		if (control.path === "ref" || control.path === "nodeset")
			cursor.derived(
				{ element: control.element, attribute: control.path },
				G.queryWrapperGroupRef,
			);
		return true;
	};

	/** A count-placement query repeat's wrapper, row and generated nodes. */
	const readCountPlacement = (
		field: DraftField,
		wrapper: DataNode,
		row: DataNode,
		parts: QueryPlacementParts,
	) => {
		cursor.take({ element: wrapper.element }, G.queryWrapper).value;
		roles.set(row, { kind: "query-row", repeat: field });
		const nodes: readonly [DataNode | undefined, QueryPurpose][] = [
			[parts.ids, "query-ids"],
			[parts.count, "query-count"],
			[parts.position, "query-position"],
			[parts.id, "query-id"],
			[parts.index, "query-index"],
		];
		for (const [node, purpose] of nodes) {
			if (node === undefined) continue;
			setGenerated(node, { kind: "generated", purpose, owner: wrapper });
			idFinding(node);
			claimGeneratedNode(cursor, node, input.binds.get(node), {
				calculate: purpose !== "query-ids",
			});
			if (purpose !== "query-ids")
				registerGeneratedUses(field, input.binds.get(node));
		}
		for (const setvalue of parts.setvalues)
			claimGeneratedSetvalue(cursor, setvalue);
		field.expressions.push({
			slot: "ids_query",
			text: parts.query.text,
			at: { element: parts.query.at, attribute: "calculate" },
			key: "xform:model/bind@calculate",
			mode: XFORM,
		});
		const rowBind = input.binds.get(row);
		if (rowBind === undefined) return;
		if (parts.condition === undefined)
			cursor.derived(
				{ element: rowBind.element, attribute: "relevant" },
				G.relevant,
			);
		else
			field.expressions.push({
				slot: "relevant",
				text: parts.condition,
				at: { element: rowBind.element, attribute: "relevant" },
				key: "xform:model/bind@relevant",
				mode: XFORM,
			});
	};

	// The node a control refused whole names, and every node under it, belongs to that control:
	// refused with it, each standing in at its data path under the control's finding, so its bind
	// and setvalues stand under that finding and a path another expression writes still binds.
	const underRefusedControl = new Map<DataNode, StandingRefusal>();
	for (const node of tree.order) {
		const inherited =
			node.parent === null ? undefined : underRefusedControl.get(node.parent);
		const refusal = inherited ?? input.controls.refusedNodes.get(node);
		if (refusal === undefined) continue;
		if (roles.has(node) || tree.refused.has(node) || covered.has(node))
			continue;
		if (inherited === undefined)
			cursor.refuseSubtree(
				node.element,
				refusal.claim,
				refusal.place,
				refusal.detail,
			);
		underRefusedControl.set(node, refusal);
		make(
			node,
			dataParent(node),
			undefined,
			node.children.length === 0 ? "hidden" : "group",
			true,
		).standInRefusal = refusal;
	}

	/** Nodes with element children refused whole, whose fields stand in as groups, each with the
	 *  refusal a container under it stands under. */
	const refusedContainers = new Map<DataNode, StandingRefusal>();
	/** Every field a control made, for the agreement of its two places. */
	const placed: DraftField[] = [];
	// 4. Every node a control names, in body order.
	for (const control of input.controls.all) {
		const node = control.node;
		if (node === undefined || roles.has(node) || fieldOf.has(node)) continue;
		if (tree.refused.has(node) || covered.has(node)) continue;
		const carrier = recognizeConstraintMessage(
			control,
			input.binds,
			previousControl(control),
		);
		if (carrier !== undefined) {
			accounting.noteRebuild();
			setGenerated(node, carrier);
			claimGeneratedNode(cursor, node, input.binds.get(node));
			cursor.derived({ element: control.element }, G.carrierControl);
			if (control.path === "ref")
				cursor.derived(
					{ element: control.element, attribute: "ref" },
					G.carrierRef,
				);
			continue;
		}
		const parent = controlParent(control);
		let made: DraftField | undefined;
		if (control.tag === "group") {
			if (queryWrapperGroup(control)) continue;
			// A repeat's wrapping group with a `ref`: the repeat makes the field.
			if (wrapsRepeat(control)) continue;
			const stood = idFinding(node);
			claimNode(node);
			made = make(
				node,
				parent,
				control,
				"group",
				stood,
				isFieldListAppearance(control.appearance) ? { fieldList: true } : {},
			);
			groups.push({ field: made, control });
		} else if (control.tag === "repeat") {
			const wrapper = control.parent as ControlNode;
			const stub: DraftField = {
				node,
				kind: "repeat",
				id: node.name,
				parent,
				dataParent: dataParent(node),
				standIn: false,
				uuid: undefined,
				field: {},
				control,
				place: placeOf(node),
				expressions: [],
			};
			const read = readRepeat(
				{
					wrapper,
					repeat: control,
					parsed,
					tree,
					setvalues: input.setvalues,
					attributeBinds: input.attributeBinds,
					cursor,
					accounting,
					place: placeOf(node),
				},
				stub,
			);
			const placement =
				read.kind === "count" &&
				read.node.parent !== null &&
				read.target.parent === read.node.parent
					? countPlacementOf(read.node.parent)
					: undefined;
			const queryCounted =
				placement !== undefined &&
				read.kind === "count" &&
				placement.count === read.target;
			const at = queryCounted ? (read.node.parent as DataNode) : read.node;
			if (fieldOf.has(at)) continue;
			const stood = idFinding(at) || read.kind === "stand-in";
			claimNode(at);
			const field = make(
				at,
				parent,
				control,
				read.kind === "stand-in" ? "group" : "repeat",
				stood,
				read.kind === "stand-in" ? NO_ENTRIES : stub.field,
			);
			if (read.kind === "stand-in" && read.refusal !== undefined)
				field.standInRefusal = read.refusal;
			field.expressions.push(...stub.expressions);
			// The wrapper group and the repeat are one field: its path is listed once, whichever
			// of the two carries an inert appearance.
			let inert = false;
			for (const appearing of [wrapper, control])
				if (
					appearing.appearance !== undefined &&
					claimAppearance(
						cursor,
						accounting,
						appearing,
						classifyAppearance(
							appearing,
							undefined,
							appearing.appearance,
							input.intents,
						),
						field.place,
					).inert
				)
					inert = true;
			if (inert) inertAppearances.push(at.path.join("/"));
			if (read.kind === "model-iteration") {
				modelIterations.set(field, read);
				roles.set(read.row, { kind: "query-row", repeat: field });
				// The repeat's condition stands on its row's bind, where the
				// form builder writes a model-iteration repeat's display
				// condition and Nova's export writes it (`buildQueryRepeat`).
				// One on the container's own bind is refused where the logic
				// stage reads the container's bind (`logic.ts::readBindLogic`).
				const rowRelevant = input.binds.get(read.row);
				const condition = rowRelevant?.logic.relevant;
				if (rowRelevant !== undefined && condition !== undefined)
					field.expressions.push({
						slot: "relevant",
						text: condition,
						at: { element: rowRelevant.element, attribute: "relevant" },
						key: "xform:model/bind@relevant",
						mode: XFORM,
					});
			}
			if (read.kind === "count") counted.push({ field, control, read });
			if (queryCounted && placement !== undefined)
				readCountPlacement(field, at, read.node, placement);
			made = field;
		} else if (node.children.length > 0) {
			// A question's control on a node with element children: refused whole at the
			// question, and the node stands in as a group, so each node under it reads as a
			// field under that group, at the data path it has.
			const place = placeOf(node);
			cursor.refuseSubtree(control.element, X.questionWithChildren, place);
			cursor.refuseSubtree(node.element, X.questionWithChildren, place);
			const refusal = { claim: X.questionWithChildren, place };
			refusedContainers.set(node, refusal);
			made = make(node, parent, undefined, "group", true);
			made.standInRefusal = refusal;
		} else made = readQuestion(node, control, parent);
		if (made !== undefined) placed.push(made);
	}

	// A control can draw a value kept under a different group in the same
	// repeat row. Vellum compares the nearest repeat in each tree.
	for (const made of placed) {
		const parent = dataParent(made.node);
		if (parent === made.parent) continue;
		let dataRepeat = parent;
		while (dataRepeat !== null && dataRepeat.kind !== "repeat")
			dataRepeat = dataParent(dataRepeat.node);
		const crossing = dataRepeat !== repeatOf(made.parent);
		const control = made.control;
		// The form designer's parser names a value kept at the form's root
		// under a grouped question `#form`, which its own check of a data
		// parent then reports as no valid path on every open
		// (`parser.js::parseControlElement`, `baseSpecs.js::dataParent`); and
		// it writes a group's own answers only under the group's place, so a
		// group kept under another group loses them on its next save
		// (`form.js::dataTree`).
		const refusal = crossing
			? X.dataParentCrossingRepeat
			: parent === null
				? X.dataParentAtFormRoot
				: made.kind === "group" || made.kind === "repeat"
					? X.dataParentOfAGroup
					: undefined;
		if (refusal !== undefined) {
			made.dataParentRefused = true;
			if (control === undefined) accounting.finding(refusal, made.place);
			else
				accounting.findingAtNode(
					refusal,
					made.place,
					{ element: control.element },
					`xform:${control.tag}@${control.tag === "repeat" ? "nodeset" : "ref"}`,
				);
		} else if (control !== undefined) {
			const attribute = control.tag === "repeat" ? "nodeset" : "ref";
			cursor.within(
				{ element: control.element, attribute },
				X.dataParentOtherGroup,
				[`xform:${control.tag}@${attribute}`],
			);
		}
	}

	// The head's `odkx:intent`s an input's `intent:<id>` names: a callout question's own
	// is refused with the callout, at its question, and one no callout writes with the
	// appearance that names it.
	const named = intentIdsOf(parsed.html);
	const controlPlace = (control: ControlNode) =>
		control.node === undefined ? formPlace : placeOf(control.node);
	for (const element of parsed.head.children) {
		if (!isTag(element)) continue;
		if (!isElement(element, parsed.scope(element), ODK_NS, "intent")) continue;
		const id = element.attribs.id;
		if (id === undefined || !named.has(id)) continue;
		const callout = callouts.get(id);
		const by = naming.get(id);
		const source = callout && controlField.get(callout);
		if (
			source?.androidApp?.kind === "open-app" &&
			intentsById.get(id) === element
		) {
			registerAndroidAppInputs(source.androidApp.app, source);
			for (const [ctrl, other] of controlField) {
				if (
					ctrl === callout ||
					ctrl.tag !== "input" ||
					ctrl.appearance !== `intent:${id}` ||
					other.standIn
				)
					continue;
				const reachable = source.androidApp.app.receive.every(
					({ ref, node }) => {
						const target = readNodePath(ref, tree, other.node);
						return target.kind === "node" && target.node === node;
					},
				);
				if (reachable) other.androidApp = { kind: "use-question", source };
				else
					cursor.refuse(
						{ element: ctrl.element, attribute: "appearance" },
						X.androidAppRefused.appearance,
						other.place,
					);
			}
		} else if (callout !== undefined) {
			const claim = calloutClaim(callout);
			if (intentsById.get(id) === element) {
				for (const [ctrl, other] of controlField) {
					if (
						ctrl !== callout &&
						!other.standIn &&
						ctrl.tag === "input" &&
						ctrl.appearance === `intent:${id}`
					)
						cursor.refuse(
							{ element: ctrl.element, attribute: "appearance" },
							claim === X.refusedKind.intent
								? X.androidAppRefused.appearance
								: claim,
							other.place,
						);
				}
			}
			cursor.refuseSubtree(
				element,
				calloutClaim(callout),
				controlPlace(callout),
			);
		} else
			cursor.refuseSubtree(
				element,
				INTENT_NAMING_ORPHAN,
				by === undefined ? formPlace : controlPlace(by),
				{ name: by?.appearance ?? `intent:${id}` },
			);
	}

	// 3, 5 and 6. The nodes no control names. Every generated name starts `nova_`, which
	// orders the proposals and proves none: the other leaves are Hidden Values first, so a
	// generated node is proposed against every field it could serve, and a `nova_` leaf no
	// rule rebuilds is a Hidden Value in its turn, which a later one may serve.
	const open = (node: DataNode) =>
		!roles.has(node) &&
		!fieldOf.has(node) &&
		!tree.refused.has(node) &&
		!covered.has(node);
	// 6 first: a node with element children and no control is refused whole and stands in as a
	// group, before the leaves are read, so each leaf under it stands under that group, at the
	// data path it has. A container under one already refused stands in under it.
	// Each such node's bind and setvalues stand under the refusal that covers it.
	for (const node of tree.order) {
		if (!open(node) || node.children.length === 0) continue;
		let within: StandingRefusal | undefined;
		for (
			let at = node.parent;
			at !== null && within === undefined;
			at = at.parent
		)
			within = refusedContainers.get(at);
		const refusal = within ?? {
			claim: X.hiddenWithChildren,
			place: placeOf(node),
		};
		if (within === undefined)
			cursor.refuseSubtree(node.element, refusal.claim, refusal.place);
		refusedContainers.set(node, refusal);
		make(node, dataParent(node), undefined, "group", true).standInRefusal =
			refusal;
	}
	for (const node of tree.order)
		if (
			open(node) &&
			node.children.length === 0 &&
			!node.name.startsWith("nova_")
		)
			readQuestion(node, undefined, dataParent(node));
	for (const node of tree.order) {
		if (!open(node) || node.children.length > 0) continue;
		accounting.noteRebuild();
		const role = recognizeGenerated(node, input.binds, fields, input.target);
		if (role === undefined) {
			readQuestion(node, undefined, dataParent(node));
			continue;
		}
		setGenerated(node, role);
		if (role.kind === "generated") {
			// A generated node's name is the allocator's, which the question id grammar takes, and
			// its data node is a question's as HQ's reader counts one (a Hidden Value).
			idFinding(node);
			const bind = input.binds.get(node);
			claimGeneratedNode(cursor, node, bind, {
				calculate: role.purpose !== "count",
			});
			const owner = fieldOf.get(role.owner);
			if (role.purpose !== "count" && owner !== undefined)
				registerGeneratedUses(owner, bind);
			const calculate = bind?.logic.calculate;
			if (role.purpose === "constraint-count" && calculate !== undefined)
				generatedValues.set(absolutePath(node, root), {
					purpose: "constraint-count",
					calculate,
				});
		}
	}

	// A refused data node stands in, so a path another expression writes to it still binds.
	// A refused Save to Case block, and what it holds, is no question: the case management
	// stage reads it as a change it refuses.
	const caseScaffolding = (node: DataNode): boolean => {
		for (let at: DataNode | null = node; at !== null; at = at.parent) {
			if (at.role === "SaveToCase") return true;
			if (!tree.refused.has(at)) return roles.get(at)?.kind === "case-region";
		}
		return false;
	};
	for (const [node] of tree.refused) {
		if (fieldOf.has(node) || roles.has(node)) continue;
		if (node.name.toLowerCase() === "meta" && node.parent === null) continue;
		if (caseScaffolding(node)) continue;
		const path = node.path.join("/");
		if (tree.nodes.get(path) !== node) continue;
		const parent = dataParent(node);
		const refusal = tree.refused.get(node);
		const standIn = make(
			node,
			parent,
			undefined,
			node.children.length === 0 ? "hidden" : "group",
			true,
		);
		if (refusal !== undefined)
			standIn.standInRefusal = {
				claim: refusal.claim,
				place: refusal.place ?? formPlace,
				...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
			};
	}

	// Counted repeats, now that what each count names is known.
	for (const { field, control, read } of counted) {
		const targetRole = roles.get(read.target);
		settleRepeatCount({
			repeat: control,
			read,
			field,
			target: fieldOf.get(read.target),
			queryCount:
				targetRole?.kind === "generated" &&
				targetRole.purpose === "query-count",
			generatedCount:
				targetRole?.kind === "generated" && targetRole.purpose === "count"
					? input.binds.get(read.target)
					: undefined,
			parsed,
			cursor,
			accounting,
			place: field.place,
		});
	}

	const dataOrder = new Map(tree.order.map((node, index) => [node, index]));
	const bodyOrder = new Map(
		input.controls.all.map((control, index) => [control, index]),
	);
	/** Each container's fields in order, made again once a candidate settles as a field. */
	let ordered: Map<DraftField | null, readonly DraftField[]> | undefined;
	const order = (): Map<DraftField | null, readonly DraftField[]> => {
		if (ordered !== undefined) return ordered;
		fields.sort(
			(a, b) => (dataOrder.get(a.node) ?? 0) - (dataOrder.get(b.node) ?? 0),
		);
		const byParent = new Map<DraftField | null, DraftField[]>();
		for (const field of fields) {
			field.dataParent = dataParent(field.node);
			const list = byParent.get(field.parent) ?? [];
			list.push(field);
			byParent.set(field.parent, list);
		}
		// Each group's questions as the form designer's question tree holds
		// them (`parser.js::parseControlTree`): its own values in the order they
		// stand under it, then each question whose value stands under another
		// group, as the parser reads it from the body; where the body shows the
		// group's questions in another order than that (`merge`'s `fixOrder`),
		// its questions in body order and then its values with no question.
		const made = new Map<DraftField | null, readonly DraftField[]>();
		for (const [parent, list] of byParent) {
			const byBody = (a: DraftField, b: DraftField) =>
				(bodyOrder.get(a.control as ControlNode) ?? 0) -
				(bodyOrder.get(b.control as ControlNode) ?? 0);
			const own = list.filter((field) => field.dataParent === parent);
			const away = list
				.filter(
					(field) => field.dataParent !== parent && field.control !== undefined,
				)
				.sort(byBody);
			const controls = list
				.filter((field) => field.control !== undefined)
				.sort(byBody);
			const seen = new Set<DraftField>();
			let reordered = false;
			for (let read = 0, shown = 0; shown < controls.length; ) {
				if (read < own.length) {
					if (own[read] === controls[shown]) shown++;
					seen.add(own[read]);
					read++;
				} else {
					if (seen.has(controls[shown])) reordered = true;
					shown++;
				}
			}
			made.set(
				parent,
				reordered
					? [...controls, ...own.filter((field) => field.control === undefined)]
					: [...own, ...away],
			);
		}
		ordered = made;
		return made;
	};
	order();
	return {
		roles,
		fields,
		childrenOf: (parent) => order().get(parent) ?? [],
		groups,
		inertAppearances,
		respelledAppearances,
		caseChoices,
		modelIterations,
		generated,
		generatedValues,
		attachActivity(node, activity) {
			const field = make(
				node,
				dataParent(node),
				undefined,
				"connect_activity",
				false,
				{ activity },
			);
			ordered = undefined;
			return field;
		},
		attachCaseChange(node, operationUuid) {
			const region = roles.get(node);
			make(node, dataParent(node), undefined, "case_change", false, {
				operationUuid,
			});
			if (region !== undefined) roles.set(node, region);
			ordered = undefined;
		},
		settleField(node) {
			const field = readQuestion(node, undefined, dataParent(node));
			ordered = undefined;
			return field;
		},
	};
}
