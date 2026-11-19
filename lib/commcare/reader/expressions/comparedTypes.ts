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
 * A property read where a function's signature takes a date (`format-date`'s
 * and `date-add`'s) or a number (a sum's, a product's, a negation's), or
 * that `datetime-coerce` reads, takes the first type that position admits
 * under which the slot prints the source's text (`requiredTypes`, which the
 * reading tries).
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
import { readChosenCaseProperty } from "@/lib/domain/expression/chosenCase";
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

/** A custom property read of the row a comparison stands in, or of the case
 *  a menu above chose (`chosenCase.ts::readChosenCaseProperty`). */
function comparedProperty(
	expression: Expression | undefined,
): Term | undefined {
	const term =
		expression?.kind === "term"
			? expression.term
			: expression !== undefined &&
					readChosenCaseProperty(expression) !== undefined &&
					expression.kind === "project"
				? expression.value
				: undefined;
	if (term === undefined) return undefined;
	return term.kind === "prop" &&
		term.caseType !== undefined &&
		(term.via === undefined || term.via.kind === "self") &&
		!isStandardCaseListProperty(term.property)
		? term
		: undefined;
}

/** Each property `tree` compares, in `context`, with a value of a type a
 *  property may take, where `untyped` says the catalog holds it untyped. A
 *  type one comparison gives a property reaches every node that reads it:
 *  `if(c, age, 3) = weight` types `age` by the `3` beside it, then `weight`
 *  by the branch node `age` and `3` now type, so the scan is made again over
 *  a catalog holding what it found until it finds nothing new. */
export function comparedTypes(
	tree: Expression,
	context: ExpressionContext,
	untyped: (caseType: string, property: string) => boolean,
): ComparedType[] {
	if (context.ruleSet !== "record") return [];
	const found: ComparedType[] = [];
	const typed = new Set<string>();
	const keyOf = (one: { caseType: string; property: string }) =>
		JSON.stringify([one.caseType, one.property]);
	let at = context;
	for (;;) {
		const round = scanComparedTypes(
			tree,
			at,
			(caseType, property) =>
				untyped(caseType, property) &&
				!typed.has(keyOf({ caseType, property })),
		);
		found.push(...round);
		const agreed = agreedComparedTypes(round).filter(
			(one) => !typed.has(keyOf(one)),
		);
		if (agreed.length === 0) return found;
		for (const one of agreed) typed.add(keyOf(one));
		at = withPropertyTypes(at, agreed);
	}
}

/** `context` over a catalog that holds each of `types`. */
export function withPropertyTypes(
	context: ExpressionContext,
	types: readonly ComparedType[],
): ExpressionContext {
	if (types.length === 0) return context;
	return {
		...context,
		facts: {
			...context.facts,
			caseTypes: context.facts.caseTypes.map((type) => ({
				...type,
				properties: type.properties.map((property) => {
					const typed = types.find(
						(one) =>
							one.caseType === type.name && one.property === property.name,
					);
					return typed === undefined
						? property
						: { ...property, data_type: typed.dataType };
				}),
			})),
		},
	};
}

/** One scan of `comparedTypes`, in `context` as it stands. */
function scanComparedTypes(
	tree: Expression,
	context: ExpressionContext,
	untyped: (caseType: string, property: string) => boolean,
): ComparedType[] {
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
				note(node.lower, node.left, true);
				note(node.upper, node.left, true);
				return;
			case "in":
				for (const one of node.values)
					note(node.left, { kind: "term", term: one }, false);
				return;
			case "within-distance":
				// A distance is measured between two locations, so the property
				// it measures is one, and so is every value its center ends with.
				noteKind({ kind: "term", term: node.property }, "geopoint");
				for (const output of outputsOf(node.center))
					noteKind(output, "geopoint");
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

/** A property a function's signature fixes the kind of, with the types,
 *  in the order a reading tries them, its position admits. */
export interface RequiredType {
	readonly caseType: string;
	readonly property: string;
	readonly candidates: readonly CasePropertyDataType[];
	/** Properties the position orders this one against, which take the
	 *  same type in the same try. */
	readonly partners?: readonly {
		readonly caseType: string;
		readonly property: string;
	}[];
	/** The first candidate is the type a list's numeric sort tells the
	 *  position, which the property's other positions only admit. */
	readonly told?: true;
}

/** The order a property's candidates are tried in, from every position that
 *  reads it: the types a list's sort tells first, then each position's own
 *  order, and of those only the types every position admits where any is,
 *  since one try judges every slot that reads the property. */
export function mergedCandidates(
	entries: readonly RequiredType[],
): readonly CasePropertyDataType[] {
	const ordered = [
		...entries.filter((one) => one.told === true),
		...entries.filter((one) => one.told !== true),
	];
	const all = [...new Set(ordered.flatMap((one) => one.candidates))];
	const admitted = all.filter((type) =>
		entries.every((one) => one.candidates.includes(type)),
	);
	return admitted.length > 0 ? admitted : all;
}

/** The types each signature position admits: `format-date`'s and
 *  `date-add`'s date, a whole number `quotient` reads, and a number a sum,
 *  a product, a negation, `date-add`'s quantity or a distance test's radius
 *  reads. A
 *  decimal holds every whole number, so it is tried first. */
const DATE_POSITION: readonly CasePropertyDataType[] = ["date", "datetime"];
const NUMBER_POSITION: readonly CasePropertyDataType[] = ["decimal", "int"];
/** `quotient`'s operands, which the checker and the record dialect
 *  (`queryExpressions.ts`) admit only as whole numbers. */
const INTEGER_POSITION: readonly CasePropertyDataType[] = ["int"];
/** A value `date()` reads as a moment where it prints the device's reading of
 *  one (`fromExpression.ts::deviceTemporalValue`), and as text elsewhere. */
const MOMENT_POSITION: readonly CasePropertyDataType[] = ["datetime"];
/** A value `datetime-coerce` reads, which a device prints by what it holds
 *  (`instantOperand.ts`: text as itself, a date at its UTC midnight, a date
 *  and time as its instant), so text is tried first and a date or a date and
 *  time only where text does not print the source. */
const COERCED_POSITION: readonly CasePropertyDataType[] = [
	"text",
	"date",
	"datetime",
];
/** The sides of an ordering every value of which is a property the catalog
 *  holds untyped, which order as dates and as numbers alike and print bare
 *  either way, so a date is tried before a number. */
const ORDERED_POSITION: readonly CasePropertyDataType[] = ["date", "decimal"];

/** Each property `tree` reads, as a value that ends a position's operand, at
 *  a position whose signature takes a date or a number, which a property the
 *  catalog holds untyped (read as text) cannot stand in: the types it may
 *  take there, for the reading to try against the source's print. */
export function requiredTypes(
	tree: Expression,
	context: ExpressionContext,
	untyped: (caseType: string, property: string) => boolean,
): RequiredType[] {
	if (context.ruleSet !== "record") return [];
	const found: RequiredType[] = [];
	const need = (
		side: Expression,
		candidates: readonly CasePropertyDataType[],
	): void => {
		for (const output of outputsOf(side)) {
			const term = comparedProperty(output);
			if (
				term?.kind === "prop" &&
				term.caseType !== undefined &&
				untyped(term.caseType, term.property)
			)
				found.push({
					caseType: term.caseType,
					property: term.property,
					candidates,
				});
		}
	};
	walkExpressionNodes(tree, (node) => {
		switch (node.kind) {
			case "format-date":
				need(node.date, DATE_POSITION);
				return;
			case "date-add":
				need(node.date, DATE_POSITION);
				need(node.quantity, NUMBER_POSITION);
				return;
			case "arith": {
				const position =
					node.op === "quotient" ? INTEGER_POSITION : NUMBER_POSITION;
				need(node.left, position);
				need(node.right, position);
				return;
			}
			case "negate":
				need(node.value, NUMBER_POSITION);
				return;
			case "date-coerce":
				// On a device `date()` reads a date and time in the device's own
				// date, which it reads no text in.
				need(node.value, MOMENT_POSITION);
				return;
			case "datetime-coerce":
				need(node.value, COERCED_POSITION);
				return;
			case "within-distance":
				if (typeof node.distance !== "number")
					need(node.distance, NUMBER_POSITION);
				return;
			case "gt":
			case "gte":
			case "lt":
			case "lte":
				found.push(...orderedProperties(node.left, node.right, untyped));
				return;
			default:
				return;
		}
	});
	return found;
}

/** The properties of an ordering whose two sides, one of them a branch node
 *  at least, give only properties the catalog holds untyped: each at
 *  `ORDERED_POSITION`, with every other as its partner, since the checker
 *  orders none of them as text and each takes the type the others take. Two
 *  direct properties are the expression stage's own pair
 *  (`index.ts::untypedPairs`). */
function orderedProperties(
	left: Expression,
	right: Expression,
	untyped: (caseType: string, property: string) => boolean,
): RequiredType[] {
	const lefts = outputsOf(left);
	const rights = outputsOf(right);
	const direct = (side: Expression, outputs: readonly Expression[]) =>
		outputs.length === 1 && outputs[0] === side;
	if (direct(left, lefts) && direct(right, rights)) return [];
	const properties = new Map<string, { caseType: string; property: string }>();
	for (const output of [...lefts, ...rights]) {
		const term = comparedProperty(output);
		if (
			term?.kind !== "prop" ||
			term.caseType === undefined ||
			!untyped(term.caseType, term.property)
		)
			return [];
		properties.set(JSON.stringify([term.caseType, term.property]), {
			caseType: term.caseType,
			property: term.property,
		});
	}
	return [...properties].map(([key, one]) => ({
		...one,
		candidates: ORDERED_POSITION,
		partners: [...properties]
			.filter(([other]) => other !== key)
			.map(([, partner]) => partner),
	}));
}

/** Each property the catalog holds untyped that `tree` gives as its value,
 *  itself or through a value-giving branch, with `candidates`: a calculated
 *  column a list orders by number gives a number. */
export function valueProperties(
	tree: Expression,
	candidates: readonly CasePropertyDataType[],
	untyped: (caseType: string, property: string) => boolean,
): RequiredType[] {
	return outputsOf(tree).flatMap((output) => {
		const term = comparedProperty(output);
		return term?.kind === "prop" &&
			term.caseType !== undefined &&
			untyped(term.caseType, term.property)
			? [{ caseType: term.caseType, property: term.property, candidates }]
			: [];
	});
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
