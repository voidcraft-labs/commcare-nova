/**
 * Connect activities at their authored form positions, read
 * against the data shapes that Vellum saves. Each block
 * is one element in its own namespace under a wrapper named for its id, and
 * its calculates are the form's Connect slots, registered for the expression
 * stage. Connect blocks are read here and nowhere else: a second reader of
 * one element would be a second claim on every node of it.
 */

import { type Element, isTag } from "domhandler";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { connectSubmissionConflicts } from "@/lib/domain/connectSubmission";
import type {
	ConnectActivity,
	ConnectRole,
} from "@/lib/domain/fields/connectActivity";
import {
	CONNECT_ID_MAX_LENGTH,
	connectActivityIdLimit,
} from "@/lib/domain/fields/connectActivity";
import { instanceScanRead } from "@/lib/domain/hqInstanceRead";
import {
	questionIdProblem,
	RESERVED_CONNECT_BLOCK_IDS,
} from "@/lib/domain/questionId";
import { recordFromEntries } from "@/lib/domain/records";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	CONNECT_BLOCK_SHAPES,
	CONNECT_XMLNS,
	connectBlockData,
} from "../../xform/builder";
import {
	attributeNamespace,
	elementNamespace,
	splitName,
	VELLUM_NS,
} from "../../xmlNamespaces";
import type { Accounting } from "../accounting";
import { defineClaims, refuse, take } from "../claims";
import type { ReadContext } from "../context";
import { pendingPlaceholder } from "../pendingExpressions";
import { questionPlace } from "../place";
import { builtScopes, sameElementWhole } from "../sameElement";
import type { XmlCursor, XmlNode } from "../xmlCursor";
import { X } from "./claims";
import type {
	DraftExpression,
	DraftField,
	NodeRole,
	ReadConnectBlock,
} from "./index";
import type { BindFacts, DataNode } from "./model";
import type { ParsedXForm } from "./parse";
import {
	type FormRefusals,
	refuseBindLogic,
	type StandingRefusal,
} from "./refusals";

type Block = ReadConnectBlock["block"];

const Q = (id: string) => `questions/${id}`;

/** A block's wrapper, a child of the data root, as the lane names an instance's content. */
const TOP = "xform:model/instance/*/*";
/** The block's own element and its leaves, under the wrapper. */
const NESTED = "xform:model/instance//*";
/** The form builder's role on the wrapper. */
const ROLE = "vellum-markup:model/instance//*@vellum:role";
/** A data node's own namespace, and the entry that holds one the form writes. */
const NAMESPACE = "xform:model/instance//*@xmlns";
const DATA_NODE_NAMESPACE =
	"forms-and-case-writes/xmlns-form-json-and-xform-data-node";
const CALCULATE = "xform:model/bind@calculate";

/** A held block is claimed whole at its wrapper's data node, and recorded inside at each node the
 *  lane reads: the role on the wrapper, the block's element and each leaf, and the Hidden Value
 *  HQ's question reader reads each leaf as (`xform.py::XForm.get_questions`), since no control
 *  names one. HQ's reader types no question a Connect block's, so no record names a
 *  `mug:Connect*` item. */
export const C = defineClaims("xform", {
	"connect-unit-id-changed-by-form-editor": refuse(
		Q("connect-unit-id-changed-by-form-editor"),
		NESTED,
	),
	"connect-inline-assessment-score": refuse(
		Q("connect-value-that-the-editor-clears"),
		NESTED,
	),
	"connect-inline-delivery-value": refuse(
		Q("connect-value-that-the-editor-clears"),
		NESTED,
	),
	"connect-repeats-module-completion-key": refuse(
		Q("connect-repeats-module-completion-key"),
		ROLE,
	),
	"connect-deliveries-share-receiver-key": refuse(
		Q("connect-deliveries-share-receiver-key"),
		ROLE,
	),
	"connect-assessment-without-score": refuse(
		Q("connect-assessment-without-score"),
		NESTED,
	),
	"connect-estimate-outside-receiver-range": refuse(
		Q("connect-estimate-outside-receiver-range"),
		NESTED,
	),
	"connect-module-text-outside-receiver-range": refuse(
		Q("connect-estimate-outside-receiver-range"),
		NESTED,
	),
	"connect-learn-module": take(Q("connect-learn-module"), TOP),
	"connect-learn-module-nested": take(Q("connect-learn-module"), NESTED),
	"connect-assessment": take(Q("connect-assessment"), TOP),
	"connect-assessment-nested": take(Q("connect-assessment"), NESTED),
	"connect-deliver-unit": take(Q("connect-deliver-unit"), TOP),
	"connect-deliver-unit-nested": take(Q("connect-deliver-unit"), NESTED),
	"connect-task": take(Q("connect-task"), TOP),
	"connect-task-nested": take(Q("connect-task"), NESTED),
	"connect-id-too-long": refuse(
		Q("a-connect-learn-module-or-task-id-longer-than-50-characters-or"),
		ROLE,
	),
	"several-connect-assessment-blocks-in-one-form-or-one-inside-a": refuse(
		Q("several-connect-assessment-blocks-in-one-form-or-one-inside-a"),
		ROLE,
	),
	"connect-deliver-unit-work-area-id-expression": take(
		Q("connect-deliver-unit-work-area-id-expression"),
		CALCULATE,
	),
	"connect-blocks-beyond-one-of-each-kind": take(
		Q("connect-blocks-beyond-one-of-each-kind"),
		NESTED,
	),
	"connect-deliver-unit-and-task-in-one-form": refuse(
		Q("connect-deliver-unit-and-task-in-one-form"),
		ROLE,
	),
	"connect-block-text-read-as-an-instance": refuse(
		Q("connect-block-text-read-as-an-instance"),
		NESTED,
	),
	"connect-learn-and-deliver-blocks-in-one-app": take(
		Q("connect-learn-and-deliver-blocks-in-one-app"),
		ROLE,
	),
});

const HELD = {
	learn_module: [C["connect-learn-module"], C["connect-learn-module-nested"]],
	assessment: [C["connect-assessment"], C["connect-assessment-nested"]],
	deliver_unit: [C["connect-deliver-unit"], C["connect-deliver-unit-nested"]],
	task: [C["connect-task"], C["connect-task-nested"]],
} as const;

/** The role attribute marks the activity even when the source renames its namespace prefix. */
export function connectRoleSite(
	wrapper: Element,
	scope: ParsedXForm["scope"],
): XmlNode | undefined {
	const attribute = Object.keys(wrapper.attribs).find(
		(name) =>
			attributeNamespace(name, scope(wrapper)) === VELLUM_NS &&
			splitName(name).local === "role",
	);
	return attribute === undefined ? undefined : { element: wrapper, attribute };
}

/** Records a held block's nodes under its claim where the lane reads each (`C`'s comment). */
function recordBlock(
	cursor: XmlCursor,
	wrapper: Element,
	claim: (typeof C)["connect-task"],
	scope: ParsedXForm["scope"],
): void {
	const role = connectRoleSite(wrapper, scope);
	if (role) cursor.within(role, claim, [ROLE]);
	const walk = (element: Element) => {
		for (const child of element.children) {
			if (!isTag(child)) continue;
			cursor.within({ element: child }, claim, [NESTED]);
			if (!child.children.some(isTag))
				cursor.within({ element: child }, claim, ["mug:DataBindOnly"]);
			walk(child);
		}
	};
	walk(wrapper);
}

/** Each block's own element and its leaves, in the order the emitter writes them. */
const SHAPES: Readonly<
	Record<
		Block,
		{ readonly element: string; readonly leaves: readonly string[] }
	>
> = CONNECT_BLOCK_SHAPES;

/** Each calculated child's wire name, document property and expression slot. */
const SLOTS = {
	learn_module: [],
	task: [],
	assessment: [["user_score", "score", "assessment_user_score"]],
	deliver_unit: [
		["entity_id", "entityId", "deliver_entity_id"],
		["entity_name", "entityName", "deliver_entity_name"],
		["work_area_id", "workAreaId", "deliver_work_area_id"],
	],
} as const;
const KINDS: Record<Block, ConnectActivity["kind"]> = {
	learn_module: "learning-module",
	assessment: "assessment",
	deliver_unit: "delivery",
	task: "assigned-task",
};

export interface ReadConnectInput {
	readonly parsed: ParsedXForm;
	readonly order: readonly DataNode[];
	readonly roles: ReadonlyMap<DataNode, NodeRole>;
	readonly binds: ReadonlyMap<DataNode, BindFacts>;
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly formPlace: HqPlace;
	readonly attachActivity: (
		node: DataNode,
		activity: Record<string, unknown>,
	) => DraftField;
	/** What the form's cursor has refused and claimed, so a refused block's binds claim only what
	 *  no claim holds yet. */
	readonly refusals: FormRefusals;
}

function plain(element: Element, name: string): string | undefined {
	return Object.hasOwn(element.attribs, name)
		? element.attribs[name]
		: undefined;
}

function elementText(element: Element): string {
	let text = "";
	for (const child of element.children)
		if (child.type === "text") text += child.data;
	return text;
}

/** An estimate the receiver stores and Vellum can save as written. */
function wholeNumber(text: string): number | string | undefined {
	if (!/^[0-9]+$/.test(text)) return undefined;
	const value = Number(text);
	if (!Number.isSafeInteger(value) || value > 2147483647) return undefined;
	return String(value) === text ? value : text;
}

export function readConnectBlocks(
	input: ReadConnectInput,
): readonly ReadConnectBlock[] {
	const { parsed, cursor, accounting, formPlace } = input;
	const wrappers = input.order.filter((node) => {
		const role = input.roles.get(node);
		return (
			role?.kind === "connect" &&
			(node.parent === null || input.roles.get(node.parent)?.kind !== "connect")
		);
	});
	const blocks: ReadConnectBlock[] = [];
	const counts = new Map<Block, number>();
	const positioned = new Set<DataNode>();
	for (const wrapper of wrappers) {
		const role = input.roles.get(wrapper);
		if (role?.kind !== "connect") continue;
		const block = role.block;
		const shape = SHAPES[block];
		const own = wrapper.children.length === 1 ? wrapper.children[0] : undefined;
		if (
			own === undefined ||
			own.name !== shape.element ||
			elementNamespace(own.element, parsed.scope(own.element)) !==
				CONNECT_XMLNS ||
			plain(own.element, "id") === undefined ||
			own.children.length !== shape.leaves.length ||
			own.children.some(
				(leaf, index) =>
					leaf.name !== shape.leaves[index] || leaf.children.length > 0,
			) ||
			Object.keys(own.element.attribs).some(
				(name) => name !== "id" && name !== "xmlns",
			)
		)
			continue;
		const id = wrapper.name;
		const place =
			formPlace.kind === "form"
				? questionPlace(formPlace, wrapper.path)
				: formPlace;
		const leaf = (name: string) =>
			own.children.find((child) => child.name === name) as DataNode;
		// A refused block is refused whole: its nodes, and what each node's bind says it does. Its
		// record stands at `at` where the refusal is a fact about that node alone.
		const refuseBlock = (
			claim: Parameters<XmlCursor["refuseSubtree"]>[1],
			name?: string,
			at?: XmlNode,
		) => {
			const refusal: StandingRefusal =
				name === undefined
					? { claim, place }
					: { claim, place, detail: { name } };
			if (at === undefined)
				cursor.refuseSubtree(wrapper.element, claim, place, refusal.detail);
			else
				cursor.refuseSubtreeAt(
					wrapper.element,
					at,
					claim,
					place,
					refusal.detail,
				);
			const walk = (node: DataNode) => {
				const bind = input.binds.get(node);
				if (bind !== undefined)
					refuseBindLogic(cursor, input.refusals, bind.element, refusal);
				for (const child of node.children) walk(child);
			};
			walk(wrapper);
		};
		// Vellum regenerates the inner ID from the outer question ID. Importing
		// a mismatch would change an existing receiver address on the next save.
		const savedId = own.element.attribs.id;
		if (savedId !== id) {
			refuseBlock(C["connect-unit-id-changed-by-form-editor"], savedId, {
				element: own.element,
			});
			continue;
		}
		// The id: Nova's grammar, then Connect's column length.
		const problem = questionIdProblem(id, RESERVED_CONNECT_BLOCK_IDS);
		if (problem !== undefined) {
			refuseBlock(X.questionIdGrammar, id);
			continue;
		}
		if (block !== "assessment") {
			const column = connectActivityIdLimit(KINDS[block]);
			if (column !== undefined && id.length > column) {
				refuseBlock(
					C["connect-id-too-long"],
					id,
					connectRoleSite(wrapper.element, parsed.scope),
				);
				continue;
			}
		}
		const slots = recordFromEntries<unknown>([["kind", KINDS[block]]]);
		const expressions: DraftExpression[] = [];
		// Vellum's parseDataNode and dataChildFilter keep inline text only
		// for writeToData children. These leaves retain their calculate bind.
		const inline = SLOTS[block].find(
			([name]) => elementText(leaf(name).element) !== "",
		);
		if (inline) {
			refuseBlock(
				block === "assessment"
					? C["connect-inline-assessment-score"]
					: C["connect-inline-delivery-value"],
				inline[0],
				{ element: leaf(inline[0]).element },
			);
			continue;
		}
		for (const [name, property, slot] of SLOTS[block]) {
			const bind = input.binds.get(leaf(name));
			const calculate = bind?.logic.calculate;
			if (bind === undefined || calculate === undefined) continue;
			slots[property] = pendingPlaceholder("value");
			expressions.push({
				slot,
				text: calculate,
				mode: { target: "xform", constraint: false },
				key: "xform:model/bind@calculate",
				at: { element: bind.element, attribute: "calculate" },
			});
		}
		if (block === "assessment" && slots.score === undefined) {
			refuseBlock(C["connect-assessment-without-score"], undefined, {
				element: leaf("user_score").element,
			});
			continue;
		}
		if (block !== "assessment") slots.name = elementText(leaf("name").element);
		if (block === "learn_module" || block === "task")
			slots.description = elementText(leaf("description").element);
		// Connect stores a module's name and description in columns that are never empty, and
		// reads an empty element as none (`app_xml.py::get_element_text`), which fails its sync.
		if (block === "learn_module") {
			const blank = (["name", "description"] as const).find(
				(name) => slots[name] === "",
			);
			if (blank !== undefined) {
				refuseBlock(
					C["connect-module-text-outside-receiver-range"],
					undefined,
					{
						element: leaf(blank).element,
					},
				);
				continue;
			}
		}
		if (block === "learn_module") {
			const estimate = wholeNumber(elementText(leaf("time_estimate").element));
			if (estimate === undefined) {
				refuseBlock(C["connect-estimate-outside-receiver-range"], undefined, {
					element: leaf("time_estimate").element,
				});
				continue;
			}
			slots.estimatedHours = estimate;
		}
		// The block the emitter writes for the slots read is the stored one, whole, or the block
		// holds something no slot does and is left unclaimed.
		const texts = recordFromEntries<string>([]);
		for (const name of ["name", "description"] as const)
			if (typeof slots[name] === "string") texts[name] = slots[name];
		if (
			typeof slots.estimatedHours === "number" ||
			typeof slots.estimatedHours === "string"
		)
			texts.time_estimate = String(slots.estimatedHours);
		const built = connectBlockData(CONNECT_BLOCK_SHAPES[block], id, texts);
		const parent = wrapper.element.parent;
		const outer = new Map(
			parent !== null && isTag(parent) ? parsed.scope(parent) : [],
		);
		outer.set("vellum", VELLUM_NS);
		if (
			!sameElementWhole(
				wrapper.element,
				parsed.scope,
				built,
				builtScopes(built, outer),
			)
		)
			continue;
		const claim = HELD[block][wrapper.parent === null ? 0 : 1];
		cursor.takeSubtree(wrapper.element, claim).value;
		recordBlock(cursor, wrapper.element, claim, input.parsed.scope);
		// The block's own element declares the Connect namespace, which the form
		// builder writes on it and Connect finds the block by: a data node's
		// namespace, which the export writes back as it stands.
		accounting.claimEntry(
			{ element: own.element, attribute: "xmlns" },
			DATA_NODE_NAMESPACE,
			NAMESPACE,
			place,
		);
		if (
			wrapper.parent !== null ||
			id.length > CONNECT_ID_MAX_LENGTH ||
			input.binds.get(wrapper)?.logic.relevant !== undefined ||
			(block === "deliver_unit" && slots.entityId === undefined) ||
			(block === "learn_module" && Number(slots.estimatedHours) === 0)
		)
			positioned.add(wrapper);
		for (const name of ["name", "description"] as const) {
			const text = slots[name];
			if (typeof text !== "string") continue;
			const read = instanceScanRead(text);
			if (read !== undefined)
				accounting.findingAtNode(
					C["connect-block-text-read-as-an-instance"],
					place,
					{ element: leaf(name).element },
					NESTED,
					{ name: read },
				);
		}
		counts.set(block, (counts.get(block) ?? 0) + 1);
		blocks.push({ block, id, node: wrapper });
		const field = input.attachActivity(wrapper, slots);
		field.expressions.push(...expressions);
	}
	for (const entry of blocks) {
		if (positioned.has(entry.node) || (counts.get(entry.block) ?? 0) > 1)
			accounting.claimEntryClass(
				{ element: entry.node.element },
				C["connect-blocks-beyond-one-of-each-kind"].entry,
				entry.node.parent === null ? TOP : NESTED,
				formPlace,
			);
	}
	return blocks;
}

/** HQ identifies the active kinds through the content workers submit. */
export function readConnectRoles(ctx: ReadContext): void {
	const roles = new Set<ConnectRole>();
	for (const module of ctx.draft.modules)
		for (const form of module.forms)
			for (const entry of form.xform?.connectBlocks ?? [])
				roles.add(
					entry.block === "learn_module" || entry.block === "assessment"
						? "learn"
						: "deliver",
				);
	if (roles.size === 2) {
		for (const menu of ctx.draft.modules) {
			for (const form of menu.forms) {
				const { xform } = form;
				if (xform === null) continue;
				for (const { node } of xform.connectBlocks) {
					const role = connectRoleSite(node.element, xform.parsed.scope);
					if (role)
						ctx.accounting.claimEntryClass(
							role,
							C["connect-learn-and-deliver-blocks-in-one-app"].entry,
							ROLE,
							form.place,
						);
				}
			}
		}
	}
	ctx.writeDraft(() => {
		ctx.draft.connectRoles = (["learn", "deliver"] as const).filter((role) =>
			roles.has(role),
		);
	});
}

/** A source form's final bound expressions decide whether two rows may submit
 * the same receiver key. Keep the account on the field a person can change. */
export function accountConnectSubmissionConflicts(
	ctx: ReadContext,
	doc: BlueprintDoc,
): void {
	if (!doc.connectRoles.length) return;
	const claims = {
		"repeated-learning-module": C["connect-repeats-module-completion-key"],
		"duplicate-delivery": C["connect-deliveries-share-receiver-key"],
		"repeated-assessment":
			C["several-connect-assessment-blocks-in-one-form-or-one-inside-a"],
		"delivery-with-assigned-task":
			C["connect-deliver-unit-and-task-in-one-form"],
	};
	for (const menu of ctx.draft.modules) {
		for (const form of menu.forms) {
			if (form.place.kind !== "form" || !form.xform?.connectBlocks.length)
				continue;
			for (const { block, node } of form.xform.connectBlocks) {
				if (block !== "deliver_unit") continue;
				const leaf = node.children[0]?.children.find(
					(child) => child.name === "work_area_id",
				);
				const bind = leaf && form.xform.binds.get(leaf);
				if (bind?.logic.calculate !== undefined)
					ctx.accounting.claimEntryClass(
						{ element: bind.element, attribute: "calculate" },
						C["connect-deliver-unit-work-area-id-expression"].entry,
						CALCULATE,
						questionPlace(form.place, node.path),
					);
			}
			for (const conflict of connectSubmissionConflicts(doc, form.uuid)) {
				const first = conflict.first.path.map((uuid) => doc.fields[uuid].id);
				const second = conflict.second.path.map((uuid) => doc.fields[uuid].id);
				const blockAt = (path: readonly string[]) =>
					form.xform?.connectBlocks.find(
						({ node }) =>
							node.path.length === path.length &&
							node.path.every((id, index) => id === path[index]),
					);
				const roleAt = (path: readonly string[]) => {
					const block = blockAt(path);
					return block && form.xform
						? connectRoleSite(block.node.element, form.xform.parsed.scope)
						: undefined;
				};
				const site = roleAt(second);
				// The two activities make the one cause: the finding stands at the
				// second, which the person changes, and both are its record.
				const other = roleAt(first);
				if (site && other && other.element !== site.element)
					ctx.accounting.recordAtNode(claims[conflict.reason], other, ROLE);
				const place = questionPlace(form.place, second);
				const detail = { name: first.join("/") };
				if (site)
					ctx.accounting.findingAtNode(
						claims[conflict.reason],
						place,
						site,
						ROLE,
						detail,
					);
				else ctx.accounting.finding(claims[conflict.reason], place, detail);
			}
		}
	}
}
