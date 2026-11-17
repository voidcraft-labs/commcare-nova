/**
 * The types a record slot's comparisons give the case properties they
 * compare. A record slot compares a property with a value of its own type:
 * the emitter prints `age = 18` for a whole-number property and
 * `age = '18'` for text, so a property the catalog holds untyped, compared
 * in a record slot with a value of a known type, is a property of that type.
 * Text is not ordered, so an ordering against a literal spelled as a date
 * or a date and time, or against a branch node whose values are all such
 * literals of one type, orders that type; a distance measured from a property
 * makes it a location, and a test of the choices it holds a list of choices.
 *
 * A property a value-giving branch ends with (an `if`'s two branches, each
 * `coalesce` value, each `switch` result, each value a `cond` gives) is
 * compared as the branch is: `coalesce(seen, now()) > now()` compares
 * `seen` with `now()`. Record branches agree on one type (the checker's
 * `branch-values`), so such a property also takes the known type of a
 * branch beside it, and a `switch` subject the type of its cases.
 * Nothing else an app holds says so: no
 * writer types it, and HQ keeps no type of a property.
 */
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { literalShape } from "@/lib/domain/expression/ruleSets";
import {
	scalarDataType,
	typeOf,
	visitAssignmentOutputs,
} from "@/lib/domain/expression/typeChecker";
import type { Expression, Term } from "@/lib/domain/expression/types";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";

/** The types a comparison gives a property, the value types that name one. */
const COMPARED_TYPES: ReadonlySet<string> = new Set<CasePropertyDataType>([
	"int",
	"decimal",
	"date",
	"datetime",
]);

export interface ComparedType {
	readonly caseType: string;
	readonly property: string;
	readonly dataType: CasePropertyDataType;
}

/** Every value `expression` can end with: each branch of a value-giving
 *  branch, or the expression itself (`typeChecker.ts::visitAssignmentOutputs`). */
function outputsOf(expression: Expression): Expression[] {
	const out: Expression[] = [];
	visitAssignmentOutputs(expression, [], (output) => {
		out.push(output);
	});
	return out;
}

/** The one type `expression` names by spelling where every value it can end
 *  with is an untyped literal spelled as a date, or every one as a date and
 *  time; undefined otherwise. */
function literalShapeGiven(
	expression: Expression,
): "date" | "datetime" | undefined {
	const shapes = new Set<string | undefined>(
		outputsOf(expression).map((output) =>
			output.kind === "term" &&
			output.term.kind === "literal" &&
			output.term.data_type === undefined &&
			typeof output.term.value === "string"
				? literalShape(output.term.value)?.type
				: undefined,
		),
	);
	const [only] = shapes;
	return shapes.size === 1 && (only === "date" || only === "datetime")
		? only
		: undefined;
}

/** A custom property read of the row a comparison stands in. */
function comparedProperty(
	expression: Expression | undefined,
): Term | undefined {
	if (expression?.kind !== "term") return undefined;
	const term = expression.term;
	return term.kind === "prop" &&
		term.caseType !== undefined &&
		(term.via === undefined || term.via.kind === "self") &&
		!isStandardCaseListProperty(term.property)
		? term
		: undefined;
}

/** Each property `tree` compares, in `context`, with a value of a type a
 *  property may take, where `untyped` says the catalog holds it untyped. */
export function comparedTypes(
	tree: Expression,
	context: ExpressionContext,
	untyped: (caseType: string, property: string) => boolean,
): ComparedType[] {
	if (context.ruleSet !== "record") return [];
	const found: ComparedType[] = [];
	const note = (
		side: Expression | undefined,
		other: Expression | undefined,
		ordering: boolean,
	): void => {
		if (side === undefined) return;
		for (const output of outputsOf(side)) noteOne(output, other, ordering);
	};
	/** A property whose type the checker reads, for a branch beside it. */
	const untypedProperty = (expression: Expression): boolean => {
		const term = comparedProperty(expression);
		return (
			term?.kind === "prop" &&
			term.caseType !== undefined &&
			untyped(term.caseType, term.property)
		);
	};
	const noteOne = (
		side: Expression | undefined,
		other: Expression | undefined,
		ordering: boolean,
	): void => {
		const term = comparedProperty(side);
		if (term?.kind !== "prop" || term.caseType === undefined) return;
		if (other === undefined || !untyped(term.caseType, term.property)) return;
		let type: string | undefined;
		try {
			type = scalarDataType(typeOf(other, context)?.data);
		} catch {
			return;
		}
		// Text is not ordered, so an ordering against a literal spelled as a
		// date or a date and time, or against branches that each give one
		// spelled as that one type, orders that type.
		const shape = ordering ? literalShapeGiven(other) : undefined;
		if (shape !== undefined) type = shape;
		if (type === undefined || !COMPARED_TYPES.has(type)) return;
		found.push({
			caseType: term.caseType,
			property: term.property,
			dataType: type as CasePropertyDataType,
		});
	};
	const noteKind = (side: Expression, dataType: CasePropertyDataType): void => {
		const term = comparedProperty(side);
		if (
			term?.kind === "prop" &&
			term.caseType !== undefined &&
			untyped(term.caseType, term.property)
		)
			found.push({
				caseType: term.caseType,
				property: term.property,
				dataType,
			});
	};
	const noteBranches = (branches: readonly Expression[]): void => {
		const outputs = branches.flatMap(outputsOf);
		const others = outputs.filter((output) => !untypedProperty(output));
		for (const output of outputs)
			if (untypedProperty(output))
				for (const other of others) noteOne(output, other, false);
	};
	walkExpressionNodes(tree, (node) => {
		switch (node.kind) {
			case "if":
				noteBranches([node.then, node.else]);
				return;
			case "coalesce":
				noteBranches(node.values);
				return;
			case "switch":
				noteBranches([...node.cases.map((one) => one.then), node.fallback]);
				for (const one of node.cases)
					note(node.on, { kind: "term", term: one.when }, false);
				return;
			case "call": {
				const outputs = outputsOf(node);
				if (outputs[0] !== node) noteBranches(outputs);
				return;
			}
			case "eq":
			case "neq":
				note(node.left, node.right, false);
				note(node.right, node.left, false);
				return;
			case "gt":
			case "gte":
			case "lt":
			case "lte":
				note(node.left, node.right, true);
				note(node.right, node.left, true);
				return;
			case "between":
				note(node.left, node.lower, true);
				note(node.left, node.upper, true);
				return;
			case "within-distance":
				// A distance is measured from a location, so the property it
				// measures is one.
				noteKind({ kind: "term", term: node.property }, "geopoint");
				return;
			case "multi-select-contains":
				// Only a list of choices holds several of them.
				noteKind(
					node.property.kind === "prop"
						? { kind: "term", term: node.property }
						: (node.property as Expression),
					"multi_select",
				);
				return;
			default:
				return;
		}
	});
	return found;
}

/** One type a property: the one every comparison gives it, or `decimal`
 *  where whole numbers and decimals meet. A property compared with values of
 *  other types is left out. */
export function agreedComparedTypes(
	found: readonly ComparedType[],
): ComparedType[] {
	const byProperty = new Map<string, Set<CasePropertyDataType>>();
	for (const one of found) {
		const key = JSON.stringify([one.caseType, one.property]);
		const set = byProperty.get(key) ?? new Set<CasePropertyDataType>();
		set.add(one.dataType);
		byProperty.set(key, set);
	}
	const out: ComparedType[] = [];
	for (const [key, set] of byProperty) {
		const [caseType, property] = JSON.parse(key) as [string, string];
		const dataType =
			set.size === 1
				? [...set][0]
				: set.size === 2 && set.has("int") && set.has("decimal")
					? "decimal"
					: undefined;
		if (dataType !== undefined) out.push({ caseType, property, dataType });
	}
	return out;
}
