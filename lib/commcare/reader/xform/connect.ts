/**
 * Connect blocks: the root children of a form that carry a Connect role, read
 * against the shapes `xform/builder.ts::buildConnectBlocks` writes. Each block
 * is one element in its own namespace under a wrapper named for its id, and
 * its calculates are the form's Connect slots, registered for the expression
 * stage. Connect blocks are read here and nowhere else: a second reader of
 * one element would be a second claim on every node of it.
 */

import type { Element } from "domhandler";
import { CONNECT_ID_MAX_LENGTH, type Uuid } from "@/lib/domain";
import type { FormStructureConnect } from "@/lib/domain/expression/formStructure";
import { instanceScanRead } from "@/lib/domain/hqInstanceRead";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { connectIdProblem } from "../../connectSlugs";
import { CONNECT_BLOCK_SHAPES, CONNECT_XMLNS } from "../../xform/builder";
import { elementNamespace } from "../../xmlNamespaces";
import type { Accounting } from "../accounting";
import { defineClaims, refuse, take } from "../claims";
import type { ReadContext } from "../context";
import {
	type PendingExpression,
	pendingPlaceholder,
} from "../pendingExpressions";
import { appPlace } from "../place";
import type { XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import type { NodeRole, ReadConnectBlock } from "./index";
import { type BindFacts, type DataNode, insideRepeat } from "./model";
import type { ParsedXForm } from "./parse";

/** The longest deliver unit id Connect's column holds (`DeliverUnit.slug`). */
const DELIVER_UNIT_COLUMN = 100;

type Block = ReadConnectBlock["block"];

const MUG: Readonly<Record<Block, string>> = {
	learn_module: "mug:ConnectLearnModule",
	assessment: "mug:ConnectAssessment",
	deliver_unit: "mug:ConnectDeliverUnit",
	task: "mug:ConnectTask",
};

const Q = (id: string) => `questions/${id}`;

export const C = defineClaims("xform", {
	"connect-learn-module": take(Q("connect-learn-module"), MUG.learn_module),
	"connect-assessment": take(Q("connect-assessment"), MUG.assessment),
	"connect-deliver-unit": take(Q("connect-deliver-unit"), MUG.deliver_unit),
	"connect-task": take(Q("connect-task"), MUG.task),
	"a-connect-learn-module-or-task-id-longer-than-50-characters-or@mug:ConnectLearnModule":
		refuse(
			Q("a-connect-learn-module-or-task-id-longer-than-50-characters-or"),
			MUG.learn_module,
		),
	"a-connect-learn-module-or-task-id-longer-than-50-characters-or@mug:ConnectTask":
		refuse(
			Q("a-connect-learn-module-or-task-id-longer-than-50-characters-or"),
			MUG.task,
		),
	"a-connect-learn-module-or-task-id-longer-than-50-characters-or@mug:ConnectDeliverUnit":
		refuse(
			Q("a-connect-learn-module-or-task-id-longer-than-50-characters-or"),
			MUG.deliver_unit,
		),
	"several-connect-assessment-blocks-in-one-form-or-one-inside-a": refuse(
		Q("several-connect-assessment-blocks-in-one-form-or-one-inside-a"),
		MUG.assessment,
	),
	"connect-deliver-unit-work-area-id-expression": refuse(
		Q("connect-deliver-unit-work-area-id-expression"),
		MUG.deliver_unit,
	),
	"connect-blocks-beyond-one-of-each-kind": refuse(
		Q("connect-blocks-beyond-one-of-each-kind"),
		MUG.learn_module,
	),
	"connect-deliver-unit-and-task-in-one-form": refuse(
		Q("connect-deliver-unit-and-task-in-one-form"),
		MUG.deliver_unit,
	),
	"connect-block-text-read-as-an-instance": refuse(
		Q("connect-block-text-read-as-an-instance"),
		MUG.learn_module,
	),
	"connect-learn-and-deliver-blocks-in-one-app": refuse(
		Q("connect-learn-and-deliver-blocks-in-one-app"),
		MUG.learn_module,
	),
});

const HELD: Readonly<Record<Block, (typeof C)["connect-task"]>> = {
	learn_module: C["connect-learn-module"],
	assessment: C["connect-assessment"],
	deliver_unit: C["connect-deliver-unit"],
	task: C["connect-task"],
};

const TOO_LONG = {
	learn_module:
		C[
			"a-connect-learn-module-or-task-id-longer-than-50-characters-or@mug:ConnectLearnModule"
		],
	task: C[
		"a-connect-learn-module-or-task-id-longer-than-50-characters-or@mug:ConnectTask"
	],
	deliver_unit:
		C[
			"a-connect-learn-module-or-task-id-longer-than-50-characters-or@mug:ConnectDeliverUnit"
		],
} as const;

/** Each block's own element and its leaves, in the order the emitter writes them. */
const SHAPES: Readonly<
	Record<
		Block,
		{ readonly element: string; readonly leaves: readonly string[] }
	>
> = CONNECT_BLOCK_SHAPES;

/** The calculates a block holds, each the form's Connect slot it reads into. */
const SLOTS: Readonly<
	Partial<
		Record<
			Block,
			Readonly<
				Record<
					string,
					"assessment_user_score" | "deliver_entity_id" | "deliver_entity_name"
				>
			>
		>
	>
> = {
	assessment: { user_score: "assessment_user_score" },
	deliver_unit: {
		entity_id: "deliver_entity_id",
		entity_name: "deliver_entity_name",
	},
};

const LEARN: ReadonlySet<Block> = new Set(["learn_module", "assessment"]);

/** A registration a block makes, held until the app's Connect kind is known. */
export interface ConnectRegistration {
	readonly block: Block;
	readonly expression: PendingExpression;
	readonly at: { readonly element: Element; readonly attribute: string };
}

export interface ReadConnectInput {
	readonly parsed: ParsedXForm;
	readonly order: readonly DataNode[];
	readonly roles: ReadonlyMap<DataNode, NodeRole>;
	readonly binds: ReadonlyMap<DataNode, BindFacts>;
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly formPlace: HqPlace;
	readonly formUuid: Uuid;
}

export interface ReadConnect {
	readonly blocks: readonly ReadConnectBlock[];
	/** Each held block's slots, as the form's `connect` holds them. */
	readonly config: Readonly<Partial<Record<Block, Record<string, unknown>>>>;
	readonly connect: FormStructureConnect;
	readonly registrations: readonly ConnectRegistration[];
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

/** A whole number from 1, as the emitter writes `time_estimate`. */
function wholeNumber(text: string): number | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed[0] === "0") return undefined;
	for (const character of trimmed)
		if (character < "0" || character > "9") return undefined;
	const value = Number(trimmed);
	return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Reads the form's Connect blocks (its root children with a Connect role): each block's
 * subtree is claimed under its entry, or refused where Nova's document cannot hold it; a block
 * whose shape is not the emitter's, or whose wrapper is not named for its id, is left
 * unclaimed. Registrations of the block's calculates are returned, not made: the app's Connect
 * kind decides which hold.
 */
export function readConnectBlocks(input: ReadConnectInput): ReadConnect {
	const { parsed, cursor, accounting, formPlace } = input;
	const wrappers = input.order.filter((node) => {
		const role = input.roles.get(node);
		return (
			role?.kind === "connect" &&
			(node.parent === null || input.roles.get(node.parent)?.kind !== "connect")
		);
	});
	const blocks: ReadConnectBlock[] = [];
	const config: Partial<Record<Block, Record<string, unknown>>> = {};
	const registrations: ConnectRegistration[] = [];
	const ofKind = (block: Block) =>
		wrappers.filter((node) => {
			const role = input.roles.get(node);
			return role?.kind === "connect" && role.block === block;
		});
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
			plain(own.element, "id") !== wrapper.name ||
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
		const leaf = (name: string) =>
			own.children.find((child) => child.name === name) as DataNode;
		const wrapperBind = input.binds.get(wrapper);
		const refuseBlock = (
			claim: Parameters<XmlCursor["refuseSubtree"]>[1],
			name?: string,
		) =>
			cursor.refuseSubtree(
				wrapper.element,
				claim,
				formPlace,
				name === undefined ? undefined : { name },
			);
		// The id: Nova's grammar, then Connect's columns, then Nova's own bound.
		const problem = connectIdProblem(id);
		if (problem?.kind === "format") {
			refuseBlock(X.questionIdGrammar, id);
			continue;
		}
		if (block !== "assessment") {
			const column =
				block === "deliver_unit" ? DELIVER_UNIT_COLUMN : CONNECT_ID_MAX_LENGTH;
			if (id.length > column) {
				refuseBlock(TOO_LONG[block], id);
				continue;
			}
		}
		if (id.length > CONNECT_ID_MAX_LENGTH) {
			refuseBlock(C["connect-blocks-beyond-one-of-each-kind"], id);
			continue;
		}
		// Where it stands and how many of its kind the form holds.
		if (block === "assessment") {
			if (insideRepeat(wrapper) || ofKind("assessment").length > 1) {
				refuseBlock(
					C["several-connect-assessment-blocks-in-one-form-or-one-inside-a"],
				);
				continue;
			}
		} else if (ofKind(block).length > 1) {
			refuseBlock(C["connect-blocks-beyond-one-of-each-kind"]);
			continue;
		}
		if (wrapper.parent !== null) {
			refuseBlock(C["connect-blocks-beyond-one-of-each-kind"]);
			continue;
		}
		if (wrapperBind?.logic.relevant !== undefined) {
			refuseBlock(C["connect-blocks-beyond-one-of-each-kind"]);
			cursor.refuse(
				{ element: wrapperBind.element, attribute: "relevant" },
				C["connect-blocks-beyond-one-of-each-kind"],
				formPlace,
			);
			continue;
		}
		// What each leaf holds.
		const slots: Record<string, unknown> = { id };
		let held = true;
		const blockRegistrations: ConnectRegistration[] = [];
		for (const [name, slot] of Object.entries(SLOTS[block] ?? {})) {
			const bind = input.binds.get(leaf(name));
			const calculate = bind?.logic.calculate;
			if (bind === undefined || calculate === undefined) {
				held = false;
				break;
			}
			const key =
				slot === "assessment_user_score"
					? "user_score"
					: slot === "deliver_entity_id"
						? "entity_id"
						: "entity_name";
			slots[key] = pendingPlaceholder("value");
			blockRegistrations.push({
				block,
				expression: {
					ref: { entity: "form", uuid: input.formUuid, slot },
					text: calculate,
					mode: { target: "xform", constraint: false },
					place: formPlace,
					key: "xform:model/bind@calculate",
				},
				at: { element: bind.element, attribute: "calculate" },
			});
		}
		if (!held) {
			refuseBlock(C["connect-blocks-beyond-one-of-each-kind"]);
			continue;
		}
		if (block === "learn_module") {
			const estimate = wholeNumber(elementText(leaf("time_estimate").element));
			if (estimate === undefined) {
				refuseBlock(C["connect-blocks-beyond-one-of-each-kind"]);
				continue;
			}
			slots.name = elementText(leaf("name").element);
			slots.description = elementText(leaf("description").element);
			slots.time_estimate = estimate;
		}
		if (block === "task") {
			slots.name = elementText(leaf("name").element);
			slots.description = elementText(leaf("description").element);
		}
		if (block === "deliver_unit") {
			slots.name = elementText(leaf("name").element);
			const workArea = input.binds.get(leaf("work_area_id"));
			if (workArea?.logic.calculate !== undefined)
				cursor.refuse(
					{ element: workArea.element, attribute: "calculate" },
					C["connect-deliver-unit-work-area-id-expression"],
					formPlace,
				);
		}
		cursor.takeSubtree(wrapper.element, HELD[block]).value;
		for (const name of ["name", "description"] as const) {
			const text = slots[name];
			if (typeof text !== "string") continue;
			const read = instanceScanRead(text);
			if (read !== undefined)
				accounting.finding(
					C["connect-block-text-read-as-an-instance"],
					formPlace,
					{ name: read },
				);
		}
		blocks.push({ block, id, path: wrapper.path });
		config[block] = slots;
		registrations.push(...blockRegistrations);
	}
	if (config.deliver_unit !== undefined && config.task !== undefined)
		accounting.finding(
			C["connect-deliver-unit-and-task-in-one-form"],
			formPlace,
		);
	const connect: Record<string, { readonly id: string }> = {};
	for (const one of blocks) connect[one.block] = { id: one.id };
	return { blocks, config, connect, registrations };
}

/** Each form reading's Connect blocks, by the reading, for `readConnectType`. */
export const CONNECT_READS = new WeakMap<object, ReadConnect>();

/** A Connect block's kind of app: a learn module and an assessment are a learn app's. */
export function connectKindOf(block: Block): "learn" | "deliver" {
	return LEARN.has(block) ? "learn" : "deliver";
}

/**
 * After every form is read: the app's Connect kind, `learn` where some form holds a learn
 * module or an assessment, `deliver` where some form holds a deliver unit or a task, null where
 * none holds a block. An app of both kinds is the finding at the app, and the document takes
 * the kind of the first block in document order, so the forms still bind: each form keeps the
 * blocks of that kind, and a block of the other kind has its calculates claimed under the
 * app's finding. Each kept block's calculates are registered for the expression stage.
 */
export function readConnectType(ctx: ReadContext): void {
	const read: {
		form: (typeof ctx.draft.modules)[number]["forms"][number];
		connect: ReadConnect;
	}[] = [];
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const connect =
				form.xform === null ? undefined : CONNECT_READS.get(form.xform);
			if (connect !== undefined) read.push({ form, connect });
		}
	const first = read.flatMap(({ connect }) => connect.blocks)[0];
	const kinds = new Set(
		read.flatMap(({ connect }) =>
			connect.blocks.map((one) => connectKindOf(one.block)),
		),
	);
	const kind = first === undefined ? null : connectKindOf(first.block);
	if (kinds.size > 1)
		ctx.accounting.finding(
			C["connect-learn-and-deliver-blocks-in-one-app"],
			appPlace(),
		);
	ctx.writeDraft(() => {
		ctx.draft.connectType = kind;
		for (const { form, connect } of read) {
			const kept = Object.fromEntries(
				Object.entries(connect.config).filter(
					([block]) => kind !== null && connectKindOf(block as Block) === kind,
				),
			);
			if (Object.keys(kept).length > 0)
				form.form.connect = kept as unknown as NonNullable<
					typeof form.form.connect
				>;
			for (const registration of connect.registrations) {
				if (kind !== null && connectKindOf(registration.block) === kind)
					ctx.pending.register(registration.expression, registration.at);
				else
					form.xform?.cursor.refuse(
						registration.at,
						C["connect-learn-and-deliver-blocks-in-one-app"],
						appPlace(),
					);
			}
		}
	});
}
