/**
 * A field's logic slots and load-time values (11.1, 11.2). No attribute is read
 * here for its meaning: each that holds an expression is pushed as the field's
 * draft expression, which stage 5b registers under the field's UUID and the
 * expression stage binds and claims. What is claimed here is what a kind does
 * not hold (a `required` on a label, a `calculate` on a shown question, any
 * `readonly`), the shape of each default's `setvalue`, and the scalar check
 * Nova's emitter conjoins onto the constraint of a question a trimmed sibling
 * stands beside, which is folded out and recorded on the field for the case
 * management stage to hold.
 */

import type { CaseScalarTextGuard } from "@/lib/domain/caseScalarTextGuard";
import { fieldKindDeclaresKey } from "@/lib/domain/fields";
import {
	questionIdProblem,
	RESERVED_QUESTION_IDS,
} from "@/lib/domain/questionId";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import { questionScalarCheck } from "../../xform/builder";
import { readFormSyntax } from "../../xpath/formSyntax";
import type { Claim } from "../claims";
import type { DefaultEvent, ReadMode } from "../pendingExpressions";
import type { XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import { sameTree } from "./generated";
import type { DraftField, NodeRole } from "./index";
import type { BindFacts, DataNode, SetvalueFacts } from "./model";

const XFORM: ReadMode = { target: "xform", constraint: false };
const CONSTRAINT: ReadMode = { target: "xform", constraint: true };

const CONTAINER_KINDS: ReadonlySet<string> = new Set([
	"group",
	"repeat",
	"section",
]);

/** The refusal that covers what a stand-in's source holds: its kind's, or its id's. */
export function standInRefusal(
	field: DraftField,
):
	| { readonly claim: Claim<"refuse">; readonly detail?: FindingDetail }
	| undefined {
	if (!field.standIn) return undefined;
	if (field.standInClaim !== undefined) return { claim: field.standInClaim };
	const problem = questionIdProblem(field.id);
	if (problem === undefined) return undefined;
	const lowered = field.id.toLowerCase();
	const reservedAnyCase =
		problem === "reserved-name" &&
		RESERVED_QUESTION_IDS.anyCase.has(lowered) &&
		lowered !== "meta";
	return {
		claim: reservedAnyCase ? X.questionIdReserved : X.questionIdGrammar,
		detail: { name: field.id },
	};
}

/** Whether a field stands in a repeat, where its default is set when a row is added. */
function inRepeat(field: DraftField): boolean {
	for (let at = field.parent; at !== null; at = at.parent)
		if (at.kind === "repeat") return true;
	return false;
}

export interface PendingLogicInput {
	readonly cursor: XmlCursor;
	/** Every field of the form, in document order. */
	readonly fields: readonly DraftField[];
	readonly binds: ReadonlyMap<DataNode, BindFacts>;
	readonly setvalues: readonly SetvalueFacts[];
	readonly nodes: ReadonlyMap<string, DataNode>;
	readonly roles: ReadonlyMap<DataNode, NodeRole>;
	/** The data nodes a refusal of the data tree covers, with its claim. */
	readonly refused: ReadonlyMap<DataNode, Claim<"refuse">>;
	readonly formPlace: HqPlace;
}

/** Pushes each field's logic as its draft expressions and reads every default's `setvalue`. */
export function pendingLogic(input: PendingLogicInput): void {
	const trimmedOwners = new Set<DataNode>();
	for (const role of input.roles.values())
		if (
			role.kind === "generated-candidate" &&
			role.purpose === "trimmed" &&
			role.owner !== null
		)
			trimmedOwners.add(role.owner);
	for (const field of input.fields) readBindLogic(input, field, trimmedOwners);
	readDefaults(input);
}

/**
 * The scalar check Nova's emitter conjoins onto the `constraint` of a question
 * that names a case or gives its external id (`builder.ts::questionScalarCheck`),
 * alone or as the last operand of an `and`: which of the two it is, and the
 * source text of the author's own validation beside it (none where it stands
 * alone). Undefined where the constraint carries neither tree, so the whole
 * constraint is the author's.
 */
export function foldScalarCheck(constraint: string):
	| {
			readonly check: CaseScalarTextGuard;
			readonly authored: string | undefined;
	  }
	| undefined {
	const matches = (text: string) =>
		SCALAR_CHECKS.find((check) =>
			sameTree(text, questionScalarCheck(check), true),
		);
	const alone = matches(constraint);
	if (alone !== undefined) return { check: alone, authored: undefined };
	const read = readFormSyntax(constraint);
	let top = read.ok ? read.node : undefined;
	while (top?.kind === "group") top = top.value;
	if (top?.kind !== "binary" || top.op !== "and") return undefined;
	const check = matches(constraint.slice(top.right.from, top.right.to));
	if (check === undefined) return undefined;
	return { check, authored: constraint.slice(top.left.from, top.left.to) };
}

const SCALAR_CHECKS: readonly CaseScalarTextGuard[] = ["reject", "allow"];

function readBindLogic(
	input: PendingLogicInput,
	field: DraftField,
	trimmedOwners: ReadonlySet<DataNode>,
): void {
	const { cursor } = input;
	const bind = input.binds.get(field.node);
	if (bind === undefined) return;
	const element = bind.element;
	const place = field.place;
	const standIn = standInRefusal(field);
	if (field.standIn) {
		if (standIn === undefined) return;
		for (const name of [
			"relevant",
			"required",
			"constraint",
			"calculate",
			"readonly",
		])
			cursor.refuse(
				{ element, attribute: name },
				standIn.claim,
				place,
				standIn.detail,
			);
		return;
	}
	const logic = bind.logic;
	const kind = field.kind;
	const push = (
		slot: "relevant" | "required" | "validate" | "calculate",
		text: string,
		attribute: string,
		mode: ReadMode,
	) =>
		field.expressions.push({
			slot,
			text,
			at: { element, attribute },
			key: `xform:model/bind@${attribute}`,
			mode,
		});
	if (logic.relevant !== undefined && fieldKindDeclaresKey(kind, "relevant"))
		push("relevant", logic.relevant, "relevant", XFORM);
	if (logic.required !== undefined) {
		if (fieldKindDeclaresKey(kind, "required"))
			push("required", logic.required, "required", XFORM);
		else if (kind === "label")
			cursor.refuse(
				{ element, attribute: "required" },
				X.requiredOnLabel,
				place,
			);
	}
	if (logic.constraint !== undefined) {
		if (fieldKindDeclaresKey(kind, "validate")) {
			const folded = trimmedOwners.has(field.node)
				? foldScalarCheck(logic.constraint)
				: undefined;
			if (folded === undefined)
				push("validate", logic.constraint, "constraint", CONSTRAINT);
			else {
				field.scalarCheck = folded.check;
				if (folded.authored === undefined)
					cursor.take({ element, attribute: "constraint" }, X.scalarCheck)
						.value;
				else push("validate", folded.authored, "constraint", CONSTRAINT);
			}
		} else if (!CONTAINER_KINDS.has(kind))
			cursor.refuse(
				{ element, attribute: "constraint" },
				X.constraintOnCapture,
				place,
			);
	}
	if (logic.calculate !== undefined) {
		if (field.control === undefined && fieldKindDeclaresKey(kind, "calculate"))
			push("calculate", logic.calculate, "calculate", XFORM);
		else if (field.control !== undefined && !CONTAINER_KINDS.has(kind))
			cursor.refuse(
				{ element, attribute: "calculate" },
				X.calculateOnVisible,
				place,
			);
	}
	if (logic.readonly !== undefined)
		cursor.refuse({ element, attribute: "readonly" }, X.bindReadonly, place);
}

/**
 * Each model `setvalue` whose `ref` names a field's node is that field's default
 * (`parser.js::parseSetValue`): at `xforms-ready` outside a repeat and `jr-insert` inside one.
 * A setvalue another reader owns (a model-iteration repeat's, a row's, one in a case region,
 * one on a node Nova generates) is left to it; one on a node no reader holds is refused.
 */
function readDefaults(input: PendingLogicInput): void {
	const { cursor, formPlace } = input;
	const defaulted = new Set<DraftField>();
	for (const setvalue of input.setvalues) {
		const element = setvalue.element;
		const target = setvalue.target;
		if (target === undefined) {
			cursor.refuseSubtree(element, X.formLevelSetvalue, formPlace);
			continue;
		}
		const last = target[target.length - 1];
		const attribute = last?.startsWith("@") === true;
		const node = input.nodes.get(
			(attribute ? target.slice(0, -1) : target).join("/"),
		);
		// A setvalue on a node the data tree refused stands under that refusal.
		const refusedAs = node === undefined ? undefined : input.refused.get(node);
		if (refusedAs !== undefined) {
			cursor.refuseSubtree(element, refusedAs, formPlace);
			continue;
		}
		const role = node === undefined ? undefined : input.roles.get(node);
		// A setvalue on no node a reader holds is no default and no plugin's own.
		if (role === undefined) {
			cursor.refuseSubtree(element, X.formLevelSetvalue, formPlace);
			continue;
		}
		if (role.kind !== "field") continue;
		const field = role.field;
		if (attribute) {
			if (field.kind !== "repeat")
				cursor.refuseSubtree(element, X.formLevelSetvalue, field.place);
			continue;
		}
		const place = field.place;
		if (field.standIn) {
			const standIn = standInRefusal(field);
			if (standIn !== undefined)
				cursor.refuseSubtree(element, standIn.claim, place, standIn.detail);
			continue;
		}
		const expected: DefaultEvent = inRepeat(field)
			? "jr-insert"
			: "xforms-ready";
		const other: DefaultEvent =
			expected === "jr-insert" ? "xforms-ready" : "jr-insert";
		if (setvalue.event === other) {
			cursor.refuseSubtree(element, X.defaultEventMismatch, place);
			continue;
		}
		if (setvalue.event !== expected) {
			cursor.refuseSubtree(element, X.formLevelSetvalue, place);
			continue;
		}
		if (defaulted.has(field)) {
			cursor.refuseSubtree(element, X.secondDefault, place);
			continue;
		}
		defaulted.add(field);
		if (!fieldKindDeclaresKey(field.kind, "default_value")) {
			cursor.refuseSubtree(element, X.defaultOnCapture, place);
			continue;
		}
		const sites = expected === "jr-insert" ? X.defaultInside : X.defaultOutside;
		cursor.take({ element }, sites.setvalue).value;
		cursor.take({ element, attribute: "event" }, sites.event).value;
		cursor.take({ element, attribute: "ref" }, sites.ref).value;
		field.expressions.push({
			slot: "default_value",
			text: setvalue.value ?? "",
			at: { element, attribute: "value" },
			key: "xform:setvalue@value",
			mode: XFORM,
			event: expected,
		});
	}
}
