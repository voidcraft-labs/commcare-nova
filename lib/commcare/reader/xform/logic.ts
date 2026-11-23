import { isCaptureFieldKind } from "@/lib/domain/fields";
/**
 * A field's logic slots and load-time values. No attribute is read
 * here for its meaning: each that holds an expression is pushed as the field's
 * draft expression, which stage 5b registers under the field's UUID and the
 * expression stage binds and claims. What is claimed here is what a kind does
 * not hold (a validation on a hidden value, a `calculate` on a shown question, any
 * `readonly`), the shape of each default's `setvalue`, and the scalar check
 * Nova's emitter conjoins onto the constraint of a question a trimmed sibling
 * stands beside or a Save to Case block's name or external id row reads, which
 * is folded out and recorded on the field for the case management stage to
 * hold.
 */

import type { CaseScalarTextGuard } from "@/lib/domain/caseScalarTextGuard";
import { fieldKindDeclaresKey } from "@/lib/domain/fields";
import {
	questionIdProblem,
	RESERVED_QUESTION_IDS,
} from "@/lib/domain/questionId";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { questionScalarCheck } from "../../xform/builder";
import { caseScalarTextValueCalculation } from "../../xform/caseOps";
import type { FormSyntax } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import { serializeWire } from "../../xpath/wire/serialize";
import type { DefaultEvent, ReadMode } from "../pendingExpressions";
import { sameSyntax } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import type { XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import { dataRootName, HOLE, matchesTemplate, sameTree } from "./generated";
import type { DraftField, NodeRole } from "./index";
import {
	type BindFacts,
	type DataNode,
	resolveContextPath,
	type SetvalueFacts,
} from "./model";
import {
	type FormRefusals,
	refuseBindLogic,
	type StandingRefusal,
} from "./refusals";

const XFORM: ReadMode = { target: "xform", constraint: false };
const CONSTRAINT: ReadMode = { target: "xform", constraint: true };

const CONTAINER_KINDS: ReadonlySet<string> = new Set([
	"group",
	"repeat",
	"section",
]);

/** The refusal that covers what a stand-in's source holds: the one it got, or its id's. */
export function standInRefusal(field: DraftField): StandingRefusal | undefined {
	if (!field.standIn) return undefined;
	if (field.standInRefusal !== undefined) return field.standInRefusal;
	const problem = questionIdProblem(field.id);
	if (problem === undefined) return undefined;
	const lowered = field.id.toLowerCase();
	const reservedAnyCase =
		problem === "reserved-name" &&
		RESERVED_QUESTION_IDS.anyCase.has(lowered) &&
		lowered !== "meta";
	return {
		claim: reservedAnyCase ? X.submittedCase : X.questionIdGrammar,
		place: field.place,
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
	readonly formPlace: HqPlace;
	/** What the form's cursor has refused and claimed, so a stand-in's bind claims only what
	 *  its refusal has not. */
	readonly refusals: FormRefusals;
}

/** Pushes each field's logic as its draft expressions and reads every default's `setvalue`. */
export function pendingLogic(input: PendingLogicInput): void {
	const checkedOwners = scalarRowQuestions(input);
	for (const role of input.roles.values())
		if (
			role.kind === "generated-candidate" &&
			role.purpose === "trimmed" &&
			role.owner !== null
		)
			checkedOwners.add(role.owner);
	for (const field of input.fields) readBindLogic(input, field, checkedOwners);
	readDefaults(input);
}

/** The rows of a case block that hold a case's name or its external id. */
const SCALAR_ROWS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["case_name", new Set(["create", "update"])],
	["external_id", new Set(["update"])],
]);

/**
 * The questions a Save to Case block's name or external id row reads as they
 * are, trimmed by the row itself (`caseOps.ts::caseScalarTextValueCalculation`
 * of the question's path). The form's own case's block trims its own values
 * and leaves the question its check and no trimmed sibling
 * (`placement.ts::readsTrimmedSibling`), so a check on such a question may be
 * Nova's; the case management stage settles whether it is
 * (`caseManagement/index.ts::settleScalarChecks`).
 */
function scalarRowQuestions(input: PendingLogicInput): Set<DataNode> {
	const out = new Set<DataNode>();
	const trim = caseScalarTextValueCalculation(w.context([w.step(HOLE)]));
	for (const [node, bind] of input.binds) {
		const update = node.parent;
		const block = update?.parent?.parent;
		if (
			update === null ||
			SCALAR_ROWS.get(node.name)?.has(update.name) !== true ||
			update.parent?.name !== "case" ||
			block?.role !== "SaveToCase"
		)
			continue;
		const calculate = bind.logic.calculate;
		const read =
			calculate === undefined
				? undefined
				: matchesTemplate(calculate, trim, HOLE);
		const path =
			read === undefined
				? undefined
				: resolveContextPath(read, node.path, dataRootName(node));
		const question =
			path === undefined ? undefined : input.nodes.get(path.join("/"));
		if (question !== undefined && input.roles.get(question)?.kind === "field")
			out.add(question);
	}
	return out;
}

/**
 * The scalar check Nova's emitter conjoins onto the `constraint` of a question
 * that names a case or gives its external id (`builder.ts::questionScalarCheck`),
 * alone or after the author's own validation: which of the two it is, and the
 * source text of the author's validation beside it (none where it stands
 * alone). Undefined where the constraint carries neither, so the whole
 * constraint is the author's.
 */
export function foldScalarCheck(constraint: string):
	| {
			readonly check: CaseScalarTextGuard;
			readonly authored: string | undefined;
	  }
	| undefined {
	for (const check of SCALAR_CHECKS)
		if (sameTree(constraint, questionScalarCheck(check), true))
			return { check, authored: undefined };
	const read = readFormSyntax(constraint);
	if (!read.ok || read.node === undefined) return undefined;
	for (const check of SCALAR_CHECKS) {
		const authored = authoredBeside(read.node, check);
		if (authored !== undefined)
			return {
				check,
				authored: constraint.slice(authored.from, authored.to),
			};
	}
	return undefined;
}

const SCALAR_CHECKS: readonly CaseScalarTextGuard[] = ["reject", "allow"];

/**
 * The author's validation in a constraint the emitter wrote as
 * `w.and(validation, check)`. The emitter's own print of that conjunction,
 * with an atom standing for the validation, is read with the grammar: `and`
 * reads left to right, so the atom sits at the foot of the print's left spine
 * of `and`s and each check operand on the right of one of them, however many
 * operands the check holds. The source is walked down the same spine, each
 * right operand compared with the print's, and the node at the foot is the
 * author's validation. Undefined where the source holds no such spine.
 */
function authoredBeside(
	source: FormSyntax,
	check: CaseScalarTextGuard,
): FormSyntax | undefined {
	const printed = readFormSyntax(
		serializeWire(w.and(w.call("true"), questionScalarCheck(check)), {
			target: "xform",
			constraint: true,
		}).text,
	);
	if (!printed.ok || printed.node === undefined) return undefined;
	let print: FormSyntax = printed.node;
	let at: FormSyntax = source;
	while (print.kind === "binary" && print.op === "and") {
		while (at.kind === "group") at = at.value;
		if (at.kind !== "binary" || at.op !== "and") return undefined;
		if (!sameSyntax(at.right, print.right, { ruleSet: "form" }))
			return undefined;
		at = at.left;
		print = print.left;
	}
	return at;
}

function readBindLogic(
	input: PendingLogicInput,
	field: DraftField,
	checkedOwners: ReadonlySet<DataNode>,
): void {
	const { cursor } = input;
	const bind = input.binds.get(field.node);
	if (bind === undefined) return;
	const element = bind.element;
	const place = field.place;
	const standIn = standInRefusal(field);
	if (field.standIn) {
		if (standIn === undefined) return;
		refuseBindLogic(cursor, input.refusals, element, standIn);
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
	if (logic.required !== undefined && fieldKindDeclaresKey(kind, "required"))
		push("required", logic.required, "required", XFORM);
	if (logic.constraint !== undefined) {
		if (fieldKindDeclaresKey(kind, "validate")) {
			const folded = checkedOwners.has(field.node)
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
				X.unsupportedHiddenConstraint,
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
		// A setvalue on a node the data tree refused, or past one, stands under that refusal.
		const refusal = setvalue.refusal;
		if (refusal !== undefined) {
			cursor.refuseSubtree(
				element,
				refusal.claim,
				refusal.place ?? formPlace,
				refusal.detail,
			);
			continue;
		}
		if (target === undefined) {
			cursor.refuseSubtree(element, X.formLevelSetvalue, formPlace);
			continue;
		}
		const last = target[target.length - 1];
		const attribute = last?.startsWith("@") === true;
		const node = input.nodes.get(
			(attribute ? target.slice(0, -1) : target).join("/"),
		);
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
				cursor.refuseSubtree(
					element,
					standIn.claim,
					standIn.place,
					standIn.detail,
				);
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
			cursor.refuseSubtree(element, X.formLevelSetvalue, place);
			continue;
		}
		const sites =
			field.kind === "label" || isCaptureFieldKind(field.kind)
				? X.defaultOnCapture
				: expected === "jr-insert"
					? X.defaultInside
					: X.defaultOutside;
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
