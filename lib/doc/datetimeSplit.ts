/**
 * The date-and-time split: the one planner that turns a date-and-time
 * question into a date question and a time question joined by a Hidden
 * Value. Web Apps draws no date-and-time question, so this is how an app
 * that runs there asks for one.
 *
 * The original keeps its UUID, id, position, `relevant` and `caseWrite` and
 * becomes a Hidden Value calculated by the clock-keeping date over the two
 * new questions (`datePattern.ts::clockKeepingJoin`), inserted immediately
 * before it. No reader of the original is rewritten: R2 types the join as a
 * date and time held as a Core `Date`, and R3 binds it `xsd:dateTime`, so
 * Core holds exactly what the question held. The new questions' identities
 * are derived (`datetimeSplitIdentity.ts`), so the same split planned twice
 * names the same questions.
 *
 * The planner never runs the validator: each caller gates the candidate.
 */
import { produce } from "immer";
import {
	type BlueprintDoc,
	collectTranslationUnits,
	type Field,
	type Form,
	formConnectIds,
	type LanguageTag,
	type Module,
	makeTranslationUnitId,
	ownRecordValue,
	type TranslationUnitId,
	translationSourceFingerprintsEqual,
	type Uuid,
} from "@/lib/domain";
import { writerPreloadsFromLoadedCase } from "@/lib/domain/casePreload";
import { datetimeSplitFieldUuid } from "@/lib/domain/datetimeSplitIdentity";
import { expressionChildren } from "@/lib/domain/expression/children";
import {
	clockKeepingJoin,
	INSTANT_TEXT_PATTERN,
} from "@/lib/domain/expression/datePattern";
import { mapExpressionAst } from "@/lib/domain/expression/mapAst";
import type { Expression, Term } from "@/lib/domain/expression/types";
import type { DateField } from "@/lib/domain/fields/date";
import type { TimeField } from "@/lib/domain/fields/time";
import { suffixUntilFree } from "@/lib/domain/idSlug";
import { planKindConversion } from "./kindConversionCascade";
import { applyMutations } from "./mutations";
import { findContainingForm, findFieldParent } from "./mutations/helpers";
import { predecessorOf } from "./mutations/sequence";
import type { Mutation } from "./types";

/** What one split did, for the builder's toast, the cutover's notice and
 *  the fuzz mapping's record. */
export interface DatetimeSplit {
	readonly fieldUuid: Uuid;
	readonly formUuid: Uuid;
	readonly dateUuid: Uuid;
	readonly timeUuid: Uuid;
	readonly dateId: string;
	readonly timeId: string;
	readonly moved: {
		readonly validate: boolean;
		readonly defaultFrom: "preload" | "default" | null;
	};
}

export type DatetimeSplitRefusal =
	| "not-a-date-and-time-question"
	| "self-read-through-a-filter";

export type DatetimeSplitPlan =
	| ({
			readonly ok: true;
			readonly mutations: readonly Mutation[];
	  } & DatetimeSplit)
	| {
			readonly ok: false;
			readonly reason: DatetimeSplitRefusal;
			readonly message: string;
	  };

export type DatetimeSplitsPlan =
	| {
			readonly ok: true;
			readonly mutations: readonly Mutation[];
			readonly splits: readonly DatetimeSplit[];
	  }
	| {
			readonly ok: false;
			readonly fieldUuid: Uuid;
			readonly reason: DatetimeSplitRefusal;
			readonly message: string;
	  };

/** The refusal sentences, for the builder's toast and the cutover's blocker
 *  report. */
export const DATETIME_SPLIT_REFUSAL_MESSAGES: Readonly<
	Record<DatetimeSplitRefusal, string>
> = {
	"not-a-date-and-time-question":
		"Nova can split only a date-and-time question, and this question asks for something else.",
	"self-read-through-a-filter":
		"This question's own rule reads it through a filtered repeat, which Nova can't move onto the time question. You can simplify that rule and try again.",
};

/** A time of day as Core's `TimeData.cast` reads it back. */
const TIME_OF_DAY_PATTERN = "%H:%M:%S.%3";

/** The translatable slots each new question copies from the original. */
const COPIED_SLOTS = ["label", "hint", "help"] as const;

function refusal(reason: DatetimeSplitRefusal): DatetimeSplitPlan {
	return {
		ok: false,
		reason,
		message: DATETIME_SPLIT_REFUSAL_MESSAGES[reason],
	};
}

function literal(value: string): Expression {
	return { kind: "term", term: { kind: "literal", value } };
}

function fieldRead(uuid: Uuid, spelling?: "relative"): Expression {
	return {
		kind: "term",
		term:
			spelling === undefined
				? { kind: "field", uuid }
				: { kind: "field", uuid, spelling },
	};
}

/** Whether `expression` reads the field `uuid` through a step filter: a read
 *  of it carrying filters, or any read of it inside a filter's predicate,
 *  where `.` names the filtered row rather than the question. */
function readsThroughFilter(expression: Expression, uuid: Uuid): boolean {
	const visit = (node: Expression | Term, inFilter: boolean): boolean => {
		if (node.kind === "field" && node.uuid === uuid) {
			if (inFilter || node.filters !== undefined) return true;
		}
		for (const child of expressionChildren(node)) {
			if (child.kind === "relation") continue;
			if (
				visit(child.value, inFilter || child.role.kind === "form-step-filter")
			)
				return true;
		}
		return false;
	};
	return visit(expression, false);
}

/** `expression` with every read of `uuid` replaced by a fresh copy of
 *  `replacement`. */
function replaceReads(
	expression: Expression,
	uuid: Uuid,
	replacement: Expression,
): Expression {
	return mapExpressionAst(structuredClone(expression), {
		mapExpression: (node) =>
			node.kind === "term" &&
			node.term.kind === "field" &&
			node.term.uuid === uuid
				? structuredClone(replacement)
				: undefined,
	});
}

/** The form holding `fieldUuid`, its module, and the field's parent. */
function locate(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
):
	| {
			readonly parentUuid: Uuid;
			readonly formUuid: Uuid;
			readonly form: Form;
			readonly module: Module;
	  }
	| undefined {
	const parentUuid = findFieldParent(doc, fieldUuid)?.parentUuid;
	const formUuid = findContainingForm(doc, fieldUuid);
	if (parentUuid === undefined || formUuid === undefined) return undefined;
	const form = ownRecordValue(doc.forms, formUuid);
	if (form === undefined) return undefined;
	for (const moduleUuid of doc.moduleOrder) {
		if (!(ownRecordValue(doc.formOrder, moduleUuid) ?? []).includes(formUuid))
			continue;
		const module = ownRecordValue(doc.modules, moduleUuid);
		if (module === undefined) return undefined;
		return { parentUuid, formUuid, form, module };
	}
	return undefined;
}

/** The ids beside `parentUuid`'s children: theirs, plus the form's Connect
 *  block ids when the parent is the form root (the sibling rule of
 *  `identifierVerdicts.ts`). */
function takenIds(doc: BlueprintDoc, parentUuid: Uuid): Set<string> {
	const taken = new Set<string>(
		ownRecordValue(doc.forms, parentUuid) === undefined
			? []
			: formConnectIds(doc, parentUuid),
	);
	for (const sibling of ownRecordValue(doc.fieldOrder, parentUuid) ?? []) {
		const id = ownRecordValue(doc.fields, sibling)?.id;
		if (id !== undefined) taken.add(id);
	}
	return taken;
}

function uuidIsFree(doc: BlueprintDoc, uuid: Uuid): boolean {
	return (
		ownRecordValue(doc.fields, uuid) === undefined &&
		ownRecordValue(doc.forms, uuid) === undefined &&
		ownRecordValue(doc.modules, uuid) === undefined
	);
}

/** The first attempt whose two derived UUIDs are both free in `doc`. */
function freeIdentities(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): { readonly dateUuid: Uuid; readonly timeUuid: Uuid } {
	for (let attempt = 0; ; attempt++) {
		const dateUuid = datetimeSplitFieldUuid(
			doc.appId,
			fieldUuid,
			"date",
			attempt,
		);
		const timeUuid = datetimeSplitFieldUuid(
			doc.appId,
			fieldUuid,
			"time",
			attempt,
		);
		if (uuidIsFree(doc, dateUuid) && uuidIsFree(doc, timeUuid))
			return { dateUuid, timeUuid };
	}
}

/** Each language's entry for `slot` of the original, copied to the same
 *  slot of every target, where it still describes the current source text
 *  (an out-of-date entry describes prose the copy does not hold, so it is
 *  left to be pruned with the original). */
function translationCopies(
	doc: BlueprintDoc,
	originalUuid: Uuid,
	slot: string,
	targets: readonly Uuid[],
	fingerprints: ReadonlyMap<TranslationUnitId, string>,
): Mutation[] {
	const translations = doc.localization?.translations;
	if (translations === undefined) return [];
	const sourceUnit = makeTranslationUnitId("field", originalUuid, slot);
	const current = fingerprints.get(sourceUnit);
	if (current === undefined) return [];
	const out: Mutation[] = [];
	for (const [language, entries] of Object.entries(translations)) {
		const entry = ownRecordValue(entries, sourceUnit);
		if (entry === undefined) continue;
		if (!translationSourceFingerprintsEqual(entry.sourceFingerprint, current))
			continue;
		for (const target of targets) {
			out.push({
				kind: "setTranslation",
				language: language as LanguageTag,
				unitId: makeTranslationUnitId("field", target, slot),
				entry: structuredClone(entry),
			});
		}
	}
	return out;
}

/**
 * Plan the split of the date-and-time question `fieldUuid`: `addField` of
 * the date question, `addField` of the time question, the original's
 * `convertField` to `hidden`, its `updateField` to the join, the copied
 * translations, and whatever the kind conversion's cascade adds beyond its
 * own convert.
 */
export function planDatetimeSplit(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): DatetimeSplitPlan {
	const original = ownRecordValue(doc.fields, fieldUuid);
	if (original === undefined || original.kind !== "datetime")
		return refusal("not-a-date-and-time-question");
	const where = locate(doc, fieldUuid);
	if (where === undefined)
		throw new Error(
			`The date-and-time question "${original.id}" stands in no form of a module, so Nova can't place its date and time questions.`,
		);
	if (
		original.validate !== undefined &&
		readsThroughFilter(original.validate, fieldUuid)
	)
		return refusal("self-read-through-a-filter");

	const { parentUuid, formUuid, form, module } = where;
	const { dateUuid, timeUuid } = freeIdentities(doc, fieldUuid);
	const taken = takenIds(doc, parentUuid);
	const dateId = suffixUntilFree(`${original.id}_date`, taken);
	const timeId = suffixUntilFree(
		`${original.id}_time`,
		new Set([...taken, dateId]),
	);

	// The starting values: the loaded case's value where the form preloads
	// the property into the question (the preload wins over a default on a
	// device), else the original's default. `coalesce` unpacks a node's
	// `Date`, so `format-date` keeps its clock rather than rounding a node.
	const preloaded = writerPreloadsFromLoadedCase(original, module, form);
	const write = original.caseWrite;
	const start: Expression | undefined =
		preloaded && write !== undefined
			? {
					kind: "term",
					term: {
						kind: "form-case",
						caseType: write.caseType,
						property: write.property,
					},
				}
			: original.default_value;
	const defaultFrom: DatetimeSplit["moved"]["defaultFrom"] =
		start === undefined ? null : preloaded ? "preload" : "default";
	const dateDefault: Expression | undefined =
		start === undefined
			? undefined
			: { kind: "date-coerce", value: structuredClone(start) };
	const timeDefault: Expression | undefined =
		start === undefined
			? undefined
			: {
					kind: "format-date",
					pattern: TIME_OF_DAY_PATTERN,
					date: {
						kind: "coalesce",
						values: [structuredClone(start), literal("")],
					},
				};

	// The validation moves to the time question, which Core re-checks with
	// the candidate time as `.`; each read of the original reads the join of
	// the date answer and that candidate instead.
	const timeValidate: Expression | undefined =
		original.validate === undefined
			? undefined
			: {
					kind: "if",
					cond: {
						kind: "eq",
						left: fieldRead(dateUuid),
						right: literal(""),
					},
					// biome-ignore lint/suspicious/noThenProperty: Persisted AST branch data is never callable.
					then: { kind: "match-all" },
					else: replaceReads(original.validate, fieldUuid, {
						kind: "date-coerce",
						value: {
							kind: "format-date",
							pattern: INSTANT_TEXT_PATTERN,
							date: {
								kind: "concat",
								parts: [
									fieldRead(dateUuid),
									literal("T"),
									fieldRead(timeUuid, "relative"),
								],
							},
						},
					}),
				};

	const shared = {
		label: structuredClone(original.label),
		...(original.label_media !== undefined && {
			label_media: structuredClone(original.label_media),
		}),
		...(original.hint !== undefined && {
			hint: structuredClone(original.hint),
		}),
		...(original.help !== undefined && {
			help: structuredClone(original.help),
		}),
		...(original.help_media !== undefined && {
			help_media: structuredClone(original.help_media),
		}),
		...(original.required !== undefined && {
			required: structuredClone(original.required),
		}),
		...(original.relevant !== undefined && {
			relevant: structuredClone(original.relevant),
		}),
	};
	const dateField: DateField = {
		uuid: dateUuid,
		id: dateId,
		kind: "date",
		...shared,
		...(dateDefault !== undefined && { default_value: dateDefault }),
	};
	const timeField: TimeField = {
		uuid: timeUuid,
		id: timeId,
		kind: "time",
		...structuredClone(shared),
		...(timeDefault !== undefined && { default_value: timeDefault }),
		...(timeValidate !== undefined && { validate: timeValidate }),
		...(original.validate_msg !== undefined && {
			validate_msg: structuredClone(original.validate_msg),
		}),
	};

	const after = predecessorOf(
		ownRecordValue(doc.fieldOrder, parentUuid),
		fieldUuid,
	);
	// A conversion to a Hidden Value flips no case type, so its cascade never
	// refuses, and its first mutation is always the addressed convert, which
	// the split states itself below.
	const conversion = planKindConversion({
		doc,
		field: original,
		toKind: "hidden",
	});
	const [addressedConvert, ...cascade] = conversion.ok
		? conversion.mutations
		: [];
	if (
		addressedConvert?.kind !== "convertField" ||
		addressedConvert.uuid !== fieldUuid
	)
		throw new Error(
			`Splitting the date-and-time question "${original.id}" expected its conversion to a Hidden Value to lead with that question's own convert, and it did not.`,
		);
	// Only a document with translations has entries to copy.
	const fingerprints = new Map(
		doc.localization?.translations === undefined
			? []
			: collectTranslationUnits(doc).map(
					(unit) => [unit.id, unit.sourceFingerprint] as const,
				),
	);
	const mutations: Mutation[] = [
		{
			kind: "addField",
			parentUuid,
			field: dateField as Field,
			after: after ?? null,
		},
		{
			kind: "addField",
			parentUuid,
			field: timeField as Field,
			after: dateUuid,
		},
		{ kind: "convertField", uuid: fieldUuid, toKind: "hidden" },
		{
			kind: "updateField",
			uuid: fieldUuid,
			targetKind: "hidden",
			patch: {
				calculate: clockKeepingJoin(fieldRead(dateUuid), fieldRead(timeUuid)),
				...(original.default_value !== undefined && { default_value: null }),
			},
		} as Mutation,
		...COPIED_SLOTS.flatMap((slot) =>
			translationCopies(
				doc,
				fieldUuid,
				slot,
				[dateUuid, timeUuid],
				fingerprints,
			),
		),
		...translationCopies(
			doc,
			fieldUuid,
			"validate_msg",
			[timeUuid],
			fingerprints,
		),
		...cascade,
	];
	return {
		ok: true,
		mutations,
		fieldUuid,
		formUuid,
		dateUuid,
		timeUuid,
		dateId,
		timeId,
		moved: { validate: original.validate !== undefined, defaultFrom },
	};
}

/** Every field of `doc` in document order: modules in order, each module's
 *  forms in order, and each form's fields depth first, a container's
 *  children before its next sibling. */
function fieldsInDocumentOrder(doc: BlueprintDoc): Uuid[] {
	const out: Uuid[] = [];
	const walk = (parent: Uuid) => {
		for (const child of ownRecordValue(doc.fieldOrder, parent) ?? []) {
			out.push(child);
			walk(child);
		}
	};
	for (const moduleUuid of doc.moduleOrder)
		for (const formUuid of ownRecordValue(doc.formOrder, moduleUuid) ?? [])
			walk(formUuid);
	return out;
}

/**
 * Plan the split of every date-and-time question in `doc`, in document
 * order. Each plan is applied to a working copy before the next is planned,
 * so ids and identities see earlier splits. It stops at the first refusal.
 */
export function planDatetimeSplits(doc: BlueprintDoc): DatetimeSplitsPlan {
	const targets = fieldsInDocumentOrder(doc).filter(
		(uuid) => ownRecordValue(doc.fields, uuid)?.kind === "datetime",
	);
	let working = doc;
	const mutations: Mutation[] = [];
	const splits: DatetimeSplit[] = [];
	for (const fieldUuid of targets) {
		const plan = planDatetimeSplit(working, fieldUuid);
		if (!plan.ok)
			return {
				ok: false,
				fieldUuid,
				reason: plan.reason,
				message: plan.message,
			};
		const { ok: _ok, mutations: planned, ...split } = plan;
		mutations.push(...planned);
		splits.push(split);
		working = produce(working, (draft) => {
			applyMutations(draft, planned);
		});
	}
	return { ok: true, mutations, splits };
}
