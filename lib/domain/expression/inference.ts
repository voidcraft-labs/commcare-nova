/**
 * Hidden Value and case-property type inference: one least fixpoint per
 * document over four facts.
 *
 * - `H`: each Hidden Value's data type, from the type of its `calculate`, else
 *   its `default_value`, checked in its real slot.
 * - `P`: each `(caseType, property)` type: declared, else the one opinion of
 *   its visible and case-operation writers, else the one agreed opinion of its
 *   Hidden Value writers (`int` and `decimal` agree on `decimal`).
 * - `O`: each case-operation write's opinion: its destination's type when the
 *   value is storage-assignable to it, else the value's type.
 * - `C`: the Hidden Values whose date and time may hold only its day.
 *
 * **Concrete opinions only.** Each pass types expressions over a catalog that
 * drops every property no fact types yet, so an untyped property read is
 * unknown, never text: a copy chain resolves once a real writer's opinion
 * arrives and a cycle stays unknown. The checker's comparison verdicts still
 * read an untyped property as text; inference and writer agreement do not.
 * Data tables are no document fact, so inference reads none.
 *
 * **What Core holds.** A Hidden Value's bind is `xsd:dateTime` when its write
 * destination is a date and time (`fieldValueType`), else `xsd:string`. A
 * `calculate` is stored by `Recalculate.java::wrapData`: text stays
 * `StringData` under any bind, a number becomes `IntegerData`/`DecimalData`
 * whatever the bind, a `Boolean` `BooleanData`, and a `Date` `DateTimeData`
 * only under `xsd:dateTime`, otherwise `DateData`, whose `init()` rounds it
 * to the device's day. A `default_value` is a setvalue
 * (`SetValueAction.java::processAction`), which casts the wrapped value's text
 * through the bind's own answer class: `StringData` under `xsd:string`, so a
 * `Date` there keeps only `YYYY-MM-DD`, and `DateTimeData` under
 * `xsd:dateTime`. A copy of a value whose clock is gone cannot restore it,
 * whatever the copy's bind.
 *
 * Memoised per document reference; never persisted.
 */
import type {
	BlueprintDoc,
	CaseProperty,
	CaseType,
	PersistableDoc,
} from "../blueprint";
import { writerPreloadsFromLoadedCase } from "../casePreload";
import type { CasePropertyDataType } from "../casePropertyTypes";
import { caseDataTypeForFieldKind, fieldCaseWrite } from "../caseTypes";
import { formOfField } from "../fieldForm";
import type { Field, HiddenField } from "../fields";
import { fieldValueType } from "../fieldValueType";
import { orderedCaseOperations } from "../forms";
import { moduleUuidOfForm } from "../postSubmit";
import { proseText } from "../prose";
import {
	isStandardCaseListProperty,
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
	standardCasePropertyDisplayLabel,
} from "../standardCaseProperties";
import type { Uuid } from "../uuid";
import {
	type ExpressionFacts,
	type LookupTypeIndex,
	recordQueryContext,
	slotContext,
	untypedExpressionFacts,
} from "./context";
import {
	ANY_TYPE,
	type CheckPath,
	inferRecordQuery,
	isValueStorageAssignable,
	type NodeType,
	type ScalarHeld,
	scalarDataType,
	typeOf,
	visitAssignmentOutputs,
} from "./typeChecker";
import { type Expression, isExpression } from "./types";

/** Which slot a Hidden Value's value comes from; it has at most one
 * (`HIDDEN_VALUE_BOTH_SOURCES` refuses both). */
export type HiddenValueSource = "calculate" | "default_value";

/** One value a Hidden Value can end with: a branch of `if`, `switch` or
 * `coalesce`, or the whole expression. */
export interface HiddenWriterOutput {
	/** The output's path inside the value expression (`[]` for the whole). */
	readonly path: CheckPath;
	/** Its concrete type. Undefined for a blank `''` (Core stores no value,
	 * `Recalculate.wrapData`), a yes/no result, or a type nothing decides. */
	readonly type: CasePropertyDataType | undefined;
	/** A blank `''` literal, which fits every destination. */
	readonly blank: boolean;
	/** The output is a date and time whose clock may be gone. */
	readonly clockLost: boolean;
}

/** A Hidden Value that writes a case property, as its writer. */
export interface HiddenOpinion {
	readonly field: Uuid;
	/** The form it belongs to; absent for a field no form holds. */
	readonly form: Uuid | undefined;
	readonly caseType: string;
	readonly property: string;
	readonly source: HiddenValueSource | undefined;
	readonly outputs: readonly HiddenWriterOutput[];
	/** The agreed type of its typed outputs, `int` and `decimal` agreeing on
	 * `decimal`; undefined when it has none or they disagree. Always
	 * undefined for a preloaded starting value. */
	readonly opinion: CasePropertyDataType | undefined;
	/** Its typed outputs name more than one type. */
	readonly outputsDisagree: boolean;
	/** A starting value with no calculation, on a form that fills the field
	 * from the case it writes: the preload's setvalue runs after the
	 * default's and overwrites it (`xform/builder.ts` writes defaults during
	 * the field walk, `xform/caseBlocks.ts::addCaseBlocks` appends the
	 * preloads, and Core fires `xforms-ready` actions in parse order,
	 * `ActionController.triggerActionsFromEvent`), so it never saves its own
	 * value and holds no opinion. */
	readonly preloadedDefault: boolean;
}

/** Where a property's agreed type comes from. */
export type PropertyTypeOrigin =
	| { readonly kind: "declared" }
	| { readonly kind: "standard" }
	/** The visible question whose kind sets it (the first such writer). */
	| { readonly kind: "field"; readonly field: Uuid }
	/** The case operation whose write sets it (the first such writer). */
	| {
			readonly kind: "operation";
			readonly form: Uuid;
			readonly operation: Uuid;
	  }
	/** Hidden Value writers alone, which agree. */
	| { readonly kind: "hidden"; readonly fields: readonly Uuid[] };

export interface PropertyAgreement {
	/** Undefined when nothing decides it or its writers disagree. */
	readonly type: CasePropertyDataType | undefined;
	readonly origin: PropertyTypeOrigin | undefined;
}

export interface ExpressionInference {
	/** The effective catalog: declared properties, untyped ones filled from
	 * `P`, the standard properties, and properties only writers name. Only
	 * declared case types appear. */
	readonly caseTypes: readonly CaseType[];
	/** `H`: a Hidden Value's data type. One that writes a property takes the
	 * property's type where its expression's type is unknown or
	 * storage-assignable to it; otherwise its expression's type, yes/no
	 * results excluded. Absent is unknown. */
	readonly hiddenTypes: ReadonlyMap<Uuid, CasePropertyDataType>;
	/** What Core holds for each Hidden Value (module header). */
	readonly hiddenHeld: ReadonlyMap<Uuid, ScalarHeld>;
	/** `C`: Hidden Values whose date and time may hold only its day. */
	readonly clockLost: ReadonlySet<Uuid>;
	/** Every concrete opinion of every writer kind, by case type and
	 * property: visible kinds, case operations, and Hidden Values (preloaded
	 * starting values excluded). An operation's or a Hidden Value's opinion is
	 * the property's agreed type where its value is storage-assignable to it,
	 * so a writer that agrees adds no type. An operation's value that does not
	 * fit adds its own type; a Hidden Value's adds none, since
	 * `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` reports it. A property no fact types
	 * takes every writer's own type. */
	readonly writerOpinions: ReadonlyMap<
		string,
		ReadonlyMap<string, ReadonlySet<CasePropertyDataType>>
	>;
	/** `P` with its origin, for every written or declared property. */
	readonly propertyTypes: ReadonlyMap<
		string,
		ReadonlyMap<string, PropertyAgreement>
	>;
	/** Every Hidden Value that writes a case property. */
	readonly hiddenOpinions: ReadonlyMap<Uuid, HiddenOpinion>;
}

/** Why a Hidden Value writer disagrees with the property it writes. */
export type HiddenWriterFindingReason =
	/** An output is not storage-assignable to the property's type. */
	| "type"
	/** An output whose clock may be gone writes a date-and-time property. */
	| "clock-lost"
	/** Only Hidden Values type the property, and they (or this one's own
	 * outputs) name different types. */
	| "hidden-disagreement";

export interface HiddenWriterFinding {
	readonly reason: HiddenWriterFindingReason;
	/** The offending output's path inside the value expression. */
	readonly path: CheckPath;
	/** The output's type, where it has one. */
	readonly type?: CasePropertyDataType;
}

export interface HiddenWriterVerdict {
	readonly writer: HiddenOpinion;
	/** The property's agreed type and its origin. */
	readonly property: PropertyAgreement;
	readonly findings: readonly HiddenWriterFinding[];
}

const EMPTY_LOOKUP: LookupTypeIndex = new Map();
const INFERENCE_CACHE = new WeakMap<PersistableDoc, ExpressionInference>();
const IN_PROGRESS = new WeakSet<PersistableDoc>();

export function inferExpressionTypes(doc: PersistableDoc): ExpressionInference {
	const cached = INFERENCE_CACHE.get(doc);
	if (cached !== undefined) return cached;
	if (IN_PROGRESS.has(doc))
		throw new Error(
			"Expression inference read the document's own inferred facts while computing them. Inference must type each Hidden Value over its provisional facts.",
		);
	const view = withFieldParent(doc);
	IN_PROGRESS.add(doc);
	IN_PROGRESS.add(view);
	try {
		const built = new Inference(view).run();
		INFERENCE_CACHE.set(doc, built);
		return built;
	} finally {
		IN_PROGRESS.delete(doc);
		IN_PROGRESS.delete(view);
	}
}

const NAMED_BY_INFERENCE = new WeakMap<PersistableDoc, ReadonlySet<string>>();

/** Every string a Hidden Value's value or a case operation holds anywhere in
 * its tree: a superset of every field uuid inference reads a position of. */
function namedByInference(doc: PersistableDoc): ReadonlySet<string> {
	const cached = NAMED_BY_INFERENCE.get(doc);
	if (cached !== undefined) return cached;
	const named = new Set<string>();
	const visit = (value: unknown): void => {
		if (typeof value === "string") named.add(value);
		else if (Array.isArray(value)) for (const item of value) visit(item);
		else if (typeof value === "object" && value !== null)
			for (const item of Object.values(value)) visit(item);
	};
	for (const field of Object.values(doc.fields))
		if (field.kind === "hidden") {
			visit(field.calculate);
			visit(field.default_value);
		}
	for (const form of Object.values(doc.forms)) visit(form.caseOperations);
	NAMED_BY_INFERENCE.set(doc, named);
	return named;
}

/**
 * Lets `moved`'s inference stand for `candidate`'s, when `candidate` is
 * `moved` with `subtree` moved to another parent in its own form and the move
 * provably decides no inferred fact. Inference reads a field's position only
 * through a Hidden Value (its slot's context), a case writer (the form's case
 * write inventory, which session supplies read), or a field a Hidden Value or
 * case operation names (its repeats); every other read is the field's kind,
 * its case write and its form, which a move within the form keeps. So a
 * subtree that holds no Hidden Value and no case writer, and no field of
 * which any Hidden Value or case operation names, leaves every fact as it
 * was. Returns whether the inference was shared.
 */
export function shareInferenceAcrossMove(
	moved: PersistableDoc,
	candidate: PersistableDoc,
	subtree: ReadonlySet<Uuid>,
): boolean {
	const named = namedByInference(moved);
	for (const uuid of subtree) {
		const field = moved.fields[uuid];
		if (
			field === undefined ||
			field.kind === "hidden" ||
			fieldCaseWrite(field) !== undefined ||
			named.has(uuid)
		)
			return false;
	}
	if (INFERENCE_CACHE.has(candidate)) return false;
	INFERENCE_CACHE.set(candidate, inferExpressionTypes(moved));
	return true;
}

const FINGERPRINT_CACHE = new WeakMap<PersistableDoc, string>();

/**
 * Every fact inference decides, as one comparable string: each catalog
 * property's existence and type, each Hidden Value's data type, held class
 * and clock, and every writer opinion. Two documents with the same
 * fingerprint give every slot the same inferred facts, so a commit that
 * leaves it unchanged moved no verdict through inference.
 */
export function inferenceFingerprint(doc: PersistableDoc): string {
	const cached = FINGERPRINT_CACHE.get(doc);
	if (cached !== undefined) return cached;
	const inference = inferExpressionTypes(doc);
	const sorted = <T>(entries: Iterable<[string, T]>) =>
		[...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const fingerprint = JSON.stringify([
		// Catalog order is authoring metadata, not an inferred fact: declaring a
		// writer-only property moves it without changing any type.
		sorted(
			inference.caseTypes.map((caseType) => [
				caseType.name,
				sorted(
					caseType.properties.map((property) => [
						property.name,
						property.data_type ?? null,
					]),
				),
			]),
		),
		sorted(inference.hiddenTypes),
		sorted(inference.hiddenHeld),
		[...inference.clockLost].sort(),
		sorted(inference.writerOpinions).map(([caseType, byProperty]) => [
			caseType,
			sorted(byProperty).map(([property, types]) => [
				property,
				[...types].sort(),
			]),
		]),
	]);
	FINGERPRINT_CACHE.set(doc, fingerprint);
	return fingerprint;
}

/**
 * Each Hidden Value writer that disagrees with the property it writes, with
 * the outputs that disagree. A preloaded starting value never disagrees, and a
 * property no fact types holds no finding except Hidden-only disagreement.
 */
export function hiddenWriterVerdicts(
	doc: PersistableDoc,
): readonly HiddenWriterVerdict[] {
	const inference = inferExpressionTypes(doc);
	const verdicts: HiddenWriterVerdict[] = [];
	for (const writer of inference.hiddenOpinions.values()) {
		if (writer.preloadedDefault) continue;
		const property = inference.propertyTypes
			.get(writer.caseType)
			?.get(writer.property) ?? { type: undefined, origin: undefined };
		const findings: HiddenWriterFinding[] = [];
		if (property.type !== undefined) {
			for (const output of writer.outputs) {
				if (
					output.type !== undefined &&
					!isValueStorageAssignable(output.type, property.type)
				)
					findings.push({
						reason: "type",
						path: output.path,
						type: output.type,
					});
				else if (output.clockLost && property.type === "datetime")
					findings.push({
						reason: "clock-lost",
						path: output.path,
						...(output.type === undefined ? {} : { type: output.type }),
					});
			}
		} else if (hiddenOnlyDisagreement(inference, writer)) {
			for (const output of writer.outputs)
				if (output.type !== undefined)
					findings.push({
						reason: "hidden-disagreement",
						path: output.path,
						type: output.type,
					});
		}
		if (findings.length > 0) verdicts.push({ writer, property, findings });
	}
	return verdicts;
}

function hiddenOnlyDisagreement(
	inference: ExpressionInference,
	writer: HiddenOpinion,
): boolean {
	if (!writer.outputs.some((output) => output.type !== undefined)) return false;
	if (writer.outputsDisagree) return true;
	const opinions = new Set<CasePropertyDataType>();
	for (const other of inference.hiddenOpinions.values())
		if (
			other.caseType === writer.caseType &&
			other.property === writer.property &&
			other.opinion !== undefined
		)
			opinions.add(other.opinion);
	return mergeHiddenOpinions(opinions) === undefined && opinions.size > 1;
}

/** A persisted document carries no `fieldParent`; slot contexts need it. */
function withFieldParent(doc: PersistableDoc): BlueprintDoc {
	const existing = (doc as Partial<BlueprintDoc>).fieldParent;
	if (existing !== undefined) return doc as BlueprintDoc;
	const fieldParent: Record<Uuid, Uuid> = {};
	for (const [parent, children] of Object.entries(doc.fieldOrder))
		for (const child of children) fieldParent[child] = parent as Uuid;
	return { ...doc, fieldParent } as BlueprintDoc;
}

function concreteType(
	type: NodeType | undefined,
): CasePropertyDataType | undefined {
	const data = scalarDataType(type?.data);
	return data === undefined || data === ANY_TYPE || data === "boolean"
		? undefined
		: data;
}

function mergeHiddenOpinions(
	opinions: ReadonlySet<CasePropertyDataType>,
): CasePropertyDataType | undefined {
	if (opinions.size === 1) return [...opinions][0];
	if (opinions.size === 2 && opinions.has("int") && opinions.has("decimal"))
		return "decimal";
	return undefined;
}

function isBlankLiteral(expression: Expression): boolean {
	return (
		expression.kind === "term" &&
		expression.term.kind === "literal" &&
		expression.term.value === "" &&
		expression.term.data_type === undefined
	);
}

/** The scalar class a held value unpacks to. */
function scalarHeldOf(type: NodeType | undefined): ScalarHeld | undefined {
	const held = type?.held;
	if (held === undefined || held === "sequence") return undefined;
	return typeof held === "object" ? held.nodes : held;
}

interface FieldWriter {
	readonly field: Field;
	readonly caseType: string;
	readonly property: string;
}
interface HiddenWriterSite {
	readonly field: HiddenField;
	readonly form: Uuid | undefined;
	readonly source: HiddenValueSource | undefined;
	readonly expression: Expression | undefined;
	readonly write:
		| { readonly caseType: string; readonly property: string }
		| undefined;
	/** Its form fills it from the case it writes when the form opens. */
	readonly preloaded: boolean;
	readonly preloadedDefault: boolean;
}
interface OperationWrite {
	readonly form: Uuid;
	readonly operation: Uuid;
	readonly caseType: string;
	readonly property: string;
	readonly value: Expression;
	readonly currentCaseType: string | undefined;
	readonly operationIds: ReadonlySet<Uuid>;
}
/** One Hidden Value typed over one set of provisional facts. */
interface HiddenAnalysis {
	readonly expressionType: CasePropertyDataType | undefined;
	readonly whole: NodeType | undefined;
	readonly outputs: readonly (HiddenWriterOutput & {
		readonly node: NodeType | undefined;
	})[];
	readonly opinion: CasePropertyDataType | undefined;
	readonly outputsDisagree: boolean;
}
interface TypingState {
	readonly hidden: ReadonlyMap<Uuid, CasePropertyDataType | undefined>;
	readonly properties: ReadonlyMap<string, PropertyAgreement>;
	readonly operations: readonly (CasePropertyDataType | undefined)[];
}

const propertyKey = (caseType: string, property: string): string =>
	`${caseType}\u0000${property}`;

class Inference {
	private readonly untyped: ReturnType<typeof untypedExpressionFacts>;
	private readonly fieldWriters: readonly FieldWriter[];
	private readonly hiddenSites: readonly HiddenWriterSite[];
	private readonly operationWrites: readonly OperationWrite[];
	/** Every written property, by key, with its case type and name. */
	private readonly written = new Map<
		string,
		{ readonly caseType: string; readonly property: string }
	>();
	/** Every Hidden Value each Hidden Value's value names: an analysis reads
	 * a Hidden Value's facts only through a reference to its uuid (a slot's
	 * expectation never carries its own field's type), so these are the only
	 * Hidden Value facts it reads. */
	private readonly siteReads: ReadonlyMap<Uuid, readonly Uuid[]>;
	/** The Hidden Values whose value may read the case catalog: every one
	 * except those built only from answers, literals and pure operations. */
	private readonly readsCatalog: ReadonlySet<Uuid>;
	/** The analyses of the latest pass, each with the facts it read, so a
	 * pass analyses again only a Hidden Value whose facts moved. */
	private readonly passAnalyses = new Map<
		Uuid,
		{
			readonly key: string;
			readonly catalogKey: string;
			readonly analysis: HiddenAnalysis;
		}
	>();

	constructor(private readonly doc: BlueprintDoc) {
		this.untyped = untypedExpressionFacts(doc);
		const fieldWriters: FieldWriter[] = [];
		const hiddenSites: HiddenWriterSite[] = [];
		for (const field of Object.values(doc.fields)) {
			const write = fieldCaseWrite(field);
			if (write !== undefined) {
				fieldWriters.push({
					field,
					caseType: write.caseType,
					property: write.property,
				});
				this.written.set(propertyKey(write.caseType, write.property), write);
			}
			if (field.kind === "hidden") hiddenSites.push(this.hiddenSite(field));
		}
		this.fieldWriters = fieldWriters;
		this.hiddenSites = hiddenSites;
		const hiddenUuids = new Set(hiddenSites.map((site) => site.field.uuid));
		this.siteReads = new Map(
			hiddenSites.map((site) => [
				site.field.uuid,
				namedUuids(site.expression, hiddenUuids),
			]),
		);
		this.readsCatalog = new Set(
			hiddenSites.flatMap((site) =>
				mayReadCatalog(site.expression) ? [site.field.uuid] : [],
			),
		);
		const operationWrites: OperationWrite[] = [];
		for (const [formUuid, form] of Object.entries(doc.forms)) {
			const moduleUuid = moduleUuidOfForm(doc, formUuid as Uuid);
			const currentCaseType =
				moduleUuid === undefined
					? undefined
					: doc.modules[moduleUuid]?.caseType;
			const operationIds = new Set<Uuid>();
			for (const operation of orderedCaseOperations(form)) {
				const caseType = operation.retype ?? operation.caseType;
				for (const write of operation.writes ?? [])
					if (write.property.length > 0) {
						operationWrites.push({
							form: formUuid as Uuid,
							operation: operation.uuid,
							caseType,
							property: write.property,
							value: write.value,
							currentCaseType,
							operationIds: new Set(operationIds),
						});
						this.written.set(propertyKey(caseType, write.property), {
							caseType,
							property: write.property,
						});
					}
				if (operation.action === "create") operationIds.add(operation.uuid);
			}
		}
		this.operationWrites = operationWrites;
	}

	run(): ExpressionInference {
		let state: TypingState = {
			hidden: new Map(
				this.hiddenSites.map((site) => [site.field.uuid, undefined]),
			),
			properties: this.resolveProperties(
				new Map(),
				this.operationWrites.map(() => undefined),
			),
			operations: this.operationWrites.map(() => undefined),
		};
		const history: TypingState[] = [state];
		let stateKey = signature(state);
		const seen = new Map<string, number>([[stateKey, 0]]);
		// Every fact ranges over finitely many types, so the passes reach a
		// fixed point or revisit a state: each pass that does neither records a
		// new signature, and there are finitely many.
		for (;;) {
			const next = this.pass(state);
			const key = signature(next);
			if (key === stateKey) {
				state = next;
				break;
			}
			const cycleStart = seen.get(key);
			if (cycleStart !== undefined) {
				// An oscillation keeps only the facts every state of the cycle
				// agrees on; the rest are honestly unknown.
				state = stableAcross([...history.slice(cycleStart), next]);
				break;
			}
			seen.set(key, history.length);
			history.push(next);
			state = next;
			stateKey = key;
		}
		return this.finish(state);
	}

	/** One recomputation of H, then P, then O. */
	private pass(state: TypingState): TypingState {
		// An analysis reads the catalog (where its value can read case data)
		// and the data types of the Hidden Values it names, so one whose facts
		// are unchanged is the previous pass's.
		const catalogKey = propertyTypesKey(state.properties);
		let facts: ExpressionFacts | undefined;
		const analyses = new Map<Uuid, HiddenAnalysis>();
		for (const site of this.hiddenSites) {
			const uuid = site.field.uuid;
			const key = this.typesKey(uuid, state.hidden);
			const previous = this.passAnalyses.get(uuid);
			if (
				previous?.key === key &&
				(previous.catalogKey === catalogKey || !this.readsCatalog.has(uuid))
			) {
				analyses.set(uuid, previous.analysis);
				continue;
			}
			facts ??= this.facts(
				this.concreteCatalogOf(state.properties),
				state.hidden,
				new Map(),
				new Set(),
			);
			const analysis = this.analyse(site, facts);
			this.passAnalyses.set(uuid, { key, catalogKey, analysis });
			analyses.set(uuid, analysis);
		}
		const hiddenOpinions = new Map<Uuid, CasePropertyDataType | undefined>();
		for (const site of this.hiddenSites)
			if (site.write !== undefined && !site.preloadedDefault)
				hiddenOpinions.set(
					site.field.uuid,
					analyses.get(site.field.uuid)?.opinion,
				);
		const properties = this.resolveProperties(hiddenOpinions, state.operations);
		const hidden = new Map<Uuid, CasePropertyDataType | undefined>();
		for (const site of this.hiddenSites)
			hidden.set(
				site.field.uuid,
				this.hiddenDataType(
					site,
					analyses.get(site.field.uuid)?.expressionType,
					properties,
				),
			);
		const nextCatalog = this.concreteCatalogOf(properties);
		const operations = this.operationWrites.map((write) =>
			this.operationOpinion(write, nextCatalog, hidden),
		);
		return { hidden, properties, operations };
	}

	/** Held classes and clock loss over the settled types: both are
	 * fixpoints of their own (a copy holds what it copies), and neither moves
	 * a data type. */
	private finish(state: TypingState): ExpressionInference {
		const caseTypes = this.catalog(state.properties);
		const concrete = concreteCatalog(caseTypes);
		let held = new Map<Uuid, ScalarHeld>();
		let clockLost = new Set<Uuid>();
		const analyses = new Map<Uuid, HiddenAnalysis>();
		// The types are settled, so an analysis reads only the held class and
		// clock of the Hidden Values it names: one whose facts are unchanged is
		// the previous pass's.
		const read = new Map<Uuid, string>();
		const dateTimeBinds = new Map(
			this.hiddenSites.map((site) => [
				site.field.uuid,
				fieldValueType(site.field, caseTypes) === "datetime",
			]),
		);
		// The first pass reads no held class and no lost clock, as every typing
		// pass did, so an analysis the last typing pass made over these types
		// is already this pass's.
		const catalogKey = propertyTypesKey(state.properties);
		for (const site of this.hiddenSites) {
			const uuid = site.field.uuid;
			const previous = this.passAnalyses.get(uuid);
			if (
				previous?.key === this.typesKey(uuid, state.hidden) &&
				(previous.catalogKey === catalogKey || !this.readsCatalog.has(uuid))
			) {
				analyses.set(uuid, previous.analysis);
				read.set(uuid, this.heldKey(uuid, new Map(), new Set()));
			}
		}
		for (let pass = 0; pass <= this.hiddenSites.length + 1; pass += 1) {
			let facts: ExpressionFacts | undefined;
			for (const site of this.hiddenSites) {
				const uuid = site.field.uuid;
				const key = this.heldKey(uuid, held, clockLost);
				if (read.get(uuid) === key && analyses.has(uuid)) continue;
				facts ??= this.facts(concrete, state.hidden, held, clockLost);
				analyses.set(uuid, this.analyse(site, facts));
				read.set(uuid, key);
			}
			const nextHeld = new Map<Uuid, ScalarHeld>();
			const nextLost = new Set(clockLost);
			for (const site of this.hiddenSites) {
				const analysis = analyses.get(site.field.uuid);
				const dateTimeBind = dateTimeBinds.get(site.field.uuid) === true;
				nextHeld.set(site.field.uuid, heldOf(site, analysis, dateTimeBind));
				if (clockIsLost(site, analysis, dateTimeBind))
					nextLost.add(site.field.uuid);
			}
			const settled =
				nextLost.size === clockLost.size &&
				[...nextHeld].every(([uuid, value]) => held.get(uuid) === value) &&
				nextHeld.size === held.size;
			held = nextHeld;
			clockLost = nextLost;
			if (settled) break;
		}
		const hiddenTypes = new Map<Uuid, CasePropertyDataType>();
		for (const [uuid, type] of state.hidden)
			if (type !== undefined) hiddenTypes.set(uuid, type);
		const hiddenOpinions = new Map<Uuid, HiddenOpinion>();
		for (const site of this.hiddenSites) {
			if (site.write === undefined) continue;
			const analysis = analyses.get(site.field.uuid);
			hiddenOpinions.set(site.field.uuid, {
				field: site.field.uuid,
				form: site.form,
				caseType: site.write.caseType,
				property: site.write.property,
				source: site.source,
				outputs: (analysis?.outputs ?? []).map(
					({ path, type, blank, clockLost: lost }) => ({
						path,
						type,
						blank,
						clockLost: lost,
					}),
				),
				opinion: site.preloadedDefault ? undefined : analysis?.opinion,
				outputsDisagree: analysis?.outputsDisagree ?? false,
				preloadedDefault: site.preloadedDefault,
			});
		}
		return {
			caseTypes,
			hiddenTypes,
			hiddenHeld: held,
			clockLost,
			writerOpinions: this.writerOpinions(state, hiddenOpinions),
			propertyTypes: this.propertyTypes(state.properties),
			hiddenOpinions,
		};
	}

	/** The data types of the Hidden Values a Hidden Value names. */
	private typesKey(
		uuid: Uuid,
		hidden: ReadonlyMap<Uuid, CasePropertyDataType | undefined>,
	): string {
		return (this.siteReads.get(uuid) ?? [])
			.map((named) => hidden.get(named) ?? "")
			.join(",");
	}

	/** The held class and clock of the Hidden Values a Hidden Value names. */
	private heldKey(
		uuid: Uuid,
		held: ReadonlyMap<Uuid, ScalarHeld>,
		clockLost: ReadonlySet<Uuid>,
	): string {
		return (this.siteReads.get(uuid) ?? [])
			.map(
				(named) => `${held.get(named) ?? ""}${clockLost.has(named) ? "!" : ""}`,
			)
			.join(",");
	}

	private hiddenSite(field: HiddenField): HiddenWriterSite {
		const form = formOfField(this.doc, field.uuid);
		const source: HiddenValueSource | undefined =
			field.calculate !== undefined
				? "calculate"
				: field.default_value !== undefined
					? "default_value"
					: undefined;
		const write = fieldCaseWrite(field);
		const moduleUuid =
			form === undefined ? undefined : moduleUuidOfForm(this.doc, form);
		const module =
			moduleUuid === undefined ? undefined : this.doc.modules[moduleUuid];
		const savedForm = form === undefined ? undefined : this.doc.forms[form];
		const preloaded =
			module !== undefined &&
			savedForm !== undefined &&
			writerPreloadsFromLoadedCase(field, module, savedForm);
		return {
			field,
			form,
			source,
			// A slot holds an expression once the document is assembled; a value
			// still being parsed is no fact yet.
			expression: isExpression(
				source === "calculate" ? field.calculate : field.default_value,
			)
				? source === "calculate"
					? field.calculate
					: field.default_value
				: undefined,
			write:
				write === undefined
					? undefined
					: { caseType: write.caseType, property: write.property },
			preloaded,
			preloadedDefault: source === "default_value" && preloaded,
		};
	}

	private facts(
		caseTypes: readonly CaseType[],
		hidden: ReadonlyMap<Uuid, CasePropertyDataType | undefined>,
		held: ReadonlyMap<Uuid, ScalarHeld>,
		clockLost: ReadonlySet<Uuid>,
	): ExpressionFacts {
		const hiddenTypes = new Map<Uuid, CasePropertyDataType>();
		for (const [uuid, type] of hidden)
			if (type !== undefined) hiddenTypes.set(uuid, type);
		return {
			...this.untyped,
			caseTypes,
			hiddenTypes,
			hiddenHeld: held,
			clockLost,
		};
	}

	private analyse(
		site: HiddenWriterSite,
		facts: ExpressionFacts,
	): HiddenAnalysis {
		const unknown: HiddenAnalysis = {
			expressionType: undefined,
			whole: undefined,
			outputs: [],
			opinion: undefined,
			outputsDisagree: false,
		};
		if (site.source === undefined || site.expression === undefined)
			return unknown;
		const ctx = slotContext(
			this.doc,
			{ entity: "field", uuid: site.field.uuid, slot: site.source },
			EMPTY_LOOKUP,
			{ facts },
		);
		if (ctx === undefined) return unknown;
		const expression = site.expression;
		const whole = typeOf(expression, ctx);
		const outputs: (HiddenWriterOutput & { node: NodeType | undefined })[] = [];
		visitAssignmentOutputs(expression, [], (output, path) => {
			const node = typeOf(output, ctx);
			const blank = isBlankLiteral(output);
			outputs.push({
				path,
				node,
				blank,
				type: blank ? undefined : concreteType(node),
				clockLost: node?.clockLost === true,
			});
		});
		const typed = new Set(
			outputs.flatMap((output) =>
				output.type === undefined ? [] : [output.type],
			),
		);
		const opinion = mergeHiddenOpinions(typed);
		return {
			expressionType: concreteType(whole),
			whole,
			outputs,
			opinion,
			outputsDisagree: typed.size > 0 && opinion === undefined,
		};
	}

	private hiddenDataType(
		site: HiddenWriterSite,
		expressionType: CasePropertyDataType | undefined,
		properties: ReadonlyMap<string, PropertyAgreement>,
	): CasePropertyDataType | undefined {
		if (site.write === undefined) return expressionType;
		const destination = properties.get(
			propertyKey(site.write.caseType, site.write.property),
		)?.type;
		if (destination === undefined) return expressionType;
		return expressionType === undefined ||
			isValueStorageAssignable(expressionType, destination)
			? destination
			: expressionType;
	}

	private operationOpinion(
		write: OperationWrite,
		caseTypes: readonly CaseType[],
		hidden: ReadonlyMap<Uuid, CasePropertyDataType | undefined>,
	): CasePropertyDataType | undefined {
		const outcome = inferRecordQuery(
			write.value,
			recordQueryContext({
				caseTypes,
				currentCaseType: write.currentCaseType,
				formFieldTypes: this.formFieldTypes(write.form, hidden),
				operationIds: write.operationIds,
			}),
		);
		const resolved = scalarDataType(outcome.type?.data);
		if (
			outcome.errors.length > 0 ||
			resolved === undefined ||
			resolved === ANY_TYPE ||
			resolved === "boolean"
		)
			return undefined;
		// An operation supplies a value to the destination's storage; it does
		// not redefine the destination's type. A text literal can initialize a
		// single-choice property, and an integer can enter a decimal one.
		const destination = caseTypes
			.find((caseType) => caseType.name === write.caseType)
			?.properties.find(
				(property) => property.name === write.property,
			)?.data_type;
		return destination !== undefined &&
			isValueStorageAssignable(resolved, destination)
			? destination
			: resolved;
	}

	private readonly formFieldTypeCache = new WeakMap<
		ReadonlyMap<Uuid, CasePropertyDataType | undefined>,
		Map<Uuid, ReadonlyMap<Uuid, CasePropertyDataType | "_any" | undefined>>
	>();
	/** A form's answers as an operation reads them: a question its kind's
	 * type, a Hidden Value its `H`, unknown where `H` is. */
	private formFieldTypes(
		formUuid: Uuid,
		hidden: ReadonlyMap<Uuid, CasePropertyDataType | undefined>,
	): ReadonlyMap<Uuid, CasePropertyDataType | "_any" | undefined> {
		let byForm = this.formFieldTypeCache.get(hidden);
		if (byForm === undefined) {
			byForm = new Map();
			this.formFieldTypeCache.set(hidden, byForm);
		}
		const cached = byForm.get(formUuid);
		if (cached !== undefined) return cached;
		const result = new Map<Uuid, CasePropertyDataType | "_any" | undefined>();
		const stack = [...(this.doc.fieldOrder[formUuid] ?? [])];
		while (stack.length > 0) {
			const uuid = stack.pop();
			if (uuid === undefined) break;
			const field = this.doc.fields[uuid];
			if (field === undefined) continue;
			if (field.kind === "hidden")
				result.set(uuid, hidden.get(uuid) ?? ANY_TYPE);
			else {
				const dataType = caseDataTypeForFieldKind(field.kind);
				if (dataType !== undefined) result.set(uuid, dataType);
			}
			stack.push(...(this.doc.fieldOrder[uuid] ?? []));
		}
		byForm.set(formUuid, result);
		return result;
	}

	/** `P` for every written or declared property, from the current opinions. */
	private resolveProperties(
		hiddenOpinions: ReadonlyMap<Uuid, CasePropertyDataType | undefined>,
		operations: readonly (CasePropertyDataType | undefined)[],
	): ReadonlyMap<string, PropertyAgreement> {
		const visible = new Map<
			string,
			Map<CasePropertyDataType, PropertyTypeOrigin>
		>();
		const add = (
			key: string,
			type: CasePropertyDataType | undefined,
			origin: PropertyTypeOrigin,
		): void => {
			if (type === undefined) return;
			let byType = visible.get(key);
			if (byType === undefined) {
				byType = new Map();
				visible.set(key, byType);
			}
			if (!byType.has(type)) byType.set(type, origin);
		};
		for (const writer of this.fieldWriters)
			if (writer.field.kind !== "hidden")
				add(
					propertyKey(writer.caseType, writer.property),
					caseDataTypeForFieldKind(writer.field.kind),
					{ kind: "field", field: writer.field.uuid },
				);
		this.operationWrites.forEach((write, index) => {
			add(propertyKey(write.caseType, write.property), operations[index], {
				kind: "operation",
				form: write.form,
				operation: write.operation,
			});
		});
		const hidden = new Map<
			string,
			{ types: Set<CasePropertyDataType>; fields: Uuid[] }
		>();
		for (const site of this.hiddenSites) {
			const opinion = hiddenOpinions.get(site.field.uuid);
			if (site.write === undefined || opinion === undefined) continue;
			const key = propertyKey(site.write.caseType, site.write.property);
			let entry = hidden.get(key);
			if (entry === undefined) {
				entry = { types: new Set(), fields: [] };
				hidden.set(key, entry);
			}
			entry.types.add(opinion);
			entry.fields.push(site.field.uuid);
		}
		const result = new Map<string, PropertyAgreement>();
		const resolve = (caseType: string, property: string): void => {
			const key = propertyKey(caseType, property);
			if (result.has(key)) return;
			const declared = this.declared(caseType, property);
			if (declared?.data_type !== undefined) {
				result.set(key, {
					type: declared.data_type,
					origin: { kind: "declared" },
				});
				return;
			}
			if (declared === undefined && isStandardCaseListProperty(property)) {
				result.set(key, {
					type: STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[property],
					origin: { kind: "standard" },
				});
				return;
			}
			const opinions = visible.get(key);
			if (opinions !== undefined && opinions.size > 0) {
				const [only] = [...opinions];
				result.set(
					key,
					opinions.size === 1
						? { type: only[0], origin: only[1] }
						: { type: undefined, origin: undefined },
				);
				return;
			}
			const hiddenEntry = hidden.get(key);
			const agreed =
				hiddenEntry === undefined
					? undefined
					: mergeHiddenOpinions(hiddenEntry.types);
			result.set(
				key,
				agreed === undefined || hiddenEntry === undefined
					? { type: undefined, origin: undefined }
					: {
							type: agreed,
							origin: { kind: "hidden", fields: hiddenEntry.fields },
						},
			);
		};
		for (const { caseType, property } of this.written.values())
			resolve(caseType, property);
		for (const caseType of this.doc.caseTypes ?? [])
			for (const property of caseType.properties)
				resolve(caseType.name, property.name);
		return result;
	}

	private declared(
		caseType: string,
		property: string,
	): CaseProperty | undefined {
		return (this.doc.caseTypes ?? [])
			.find((type) => type.name === caseType)
			?.properties.find((candidate) => candidate.name === property);
	}

	private catalogMemo:
		| { readonly key: string; readonly concrete: readonly CaseType[] }
		| undefined;
	/** The concrete catalog for one `P`. It reads only each property's data
	 * type, so passes that leave every type unchanged share one catalog, and
	 * the facts built over it stay shared too. */
	private concreteCatalogOf(
		properties: ReadonlyMap<string, PropertyAgreement>,
	): readonly CaseType[] {
		const key = propertyTypesKey(properties);
		if (this.catalogMemo?.key !== key)
			this.catalogMemo = {
				key,
				concrete: concreteCatalog(this.catalog(properties)),
			};
		return this.catalogMemo.concrete;
	}

	/** The effective catalog for one `P`. */
	private catalog(
		properties: ReadonlyMap<string, PropertyAgreement>,
	): readonly CaseType[] {
		const result: CaseType[] = [];
		for (const caseType of this.doc.caseTypes ?? []) {
			const declaredNames = new Set(
				caseType.properties.map((property) => property.name),
			);
			const entries: CaseProperty[] = caseType.properties.map((property) => {
				if (property.data_type !== undefined) return property;
				const derived = properties.get(
					propertyKey(caseType.name, property.name),
				)?.type;
				return derived === undefined
					? property
					: { ...property, data_type: derived };
			});
			for (const name of Object.keys(STANDARD_CASE_LIST_PROPERTY_DATA_TYPES)) {
				if (declaredNames.has(name) || !isStandardCaseListProperty(name))
					continue;
				entries.push({
					name,
					label: proseText(standardCasePropertyDisplayLabel(name)),
					data_type: STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[name],
				});
			}
			for (const { caseType: writtenType, property } of this.written.values()) {
				if (
					writtenType !== caseType.name ||
					declaredNames.has(property) ||
					isStandardCaseListProperty(property)
				)
					continue;
				declaredNames.add(property);
				const derived = properties.get(
					propertyKey(caseType.name, property),
				)?.type;
				entries.push({
					name: property,
					label: proseText(property),
					...(derived !== undefined && { data_type: derived }),
				});
			}
			result.push({ ...caseType, properties: entries });
		}
		return result;
	}

	private writerOpinions(
		state: TypingState,
		hiddenOpinions: ReadonlyMap<Uuid, HiddenOpinion>,
	): ReadonlyMap<
		string,
		ReadonlyMap<string, ReadonlySet<CasePropertyDataType>>
	> {
		const result = new Map<string, Map<string, Set<CasePropertyDataType>>>();
		const add = (
			caseType: string,
			property: string,
			type: CasePropertyDataType | undefined,
		): void => {
			let byProperty = result.get(caseType);
			if (byProperty === undefined) {
				byProperty = new Map();
				result.set(caseType, byProperty);
			}
			let types = byProperty.get(property);
			if (types === undefined) {
				types = new Set();
				byProperty.set(property, types);
			}
			if (type !== undefined) types.add(type);
		};
		for (const writer of this.fieldWriters) {
			if (writer.field.kind !== "hidden") {
				add(
					writer.caseType,
					writer.property,
					caseDataTypeForFieldKind(writer.field.kind),
				);
				continue;
			}
			// A Hidden Value supplies a value to the property's storage, as an
			// operation does: an opinion its agreed type stores is that type. One
			// the agreed type does not store adds nothing here, since
			// `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` names that Hidden Value alone and
			// a correct writer beside it stays admitted.
			const opinion = hiddenOpinions.get(writer.field.uuid)?.opinion;
			const destination = state.properties.get(
				propertyKey(writer.caseType, writer.property),
			)?.type;
			if (destination === undefined)
				add(writer.caseType, writer.property, opinion);
			else if (
				opinion !== undefined &&
				isValueStorageAssignable(opinion, destination)
			)
				add(writer.caseType, writer.property, destination);
			else add(writer.caseType, writer.property, undefined);
		}
		this.operationWrites.forEach((write, index) => {
			add(write.caseType, write.property, state.operations[index]);
		});
		return result;
	}

	private propertyTypes(
		properties: ReadonlyMap<string, PropertyAgreement>,
	): ReadonlyMap<string, ReadonlyMap<string, PropertyAgreement>> {
		const result = new Map<string, Map<string, PropertyAgreement>>();
		const named = new Map<string, { caseType: string; property: string }>(
			this.written,
		);
		for (const caseType of this.doc.caseTypes ?? [])
			for (const property of caseType.properties)
				named.set(propertyKey(caseType.name, property.name), {
					caseType: caseType.name,
					property: property.name,
				});
		for (const [key, { caseType, property }] of named) {
			const agreement = properties.get(key);
			if (agreement === undefined) continue;
			let byProperty = result.get(caseType);
			if (byProperty === undefined) {
				byProperty = new Map();
				result.set(caseType, byProperty);
			}
			byProperty.set(property, agreement);
		}
		return result;
	}
}

/** Inference reads concrete opinions only: an untyped property is absent, so
 * reading it is unknown rather than text. */
function concreteCatalog(caseTypes: readonly CaseType[]): readonly CaseType[] {
	return caseTypes.map((caseType) => ({
		...caseType,
		properties: caseType.properties.filter(
			(property) => property.data_type !== undefined,
		),
	}));
}

function heldOf(
	site: HiddenWriterSite,
	analysis: HiddenAnalysis | undefined,
	dateTimeBind: boolean,
): ScalarHeld {
	// A field with no value holds what its form preloads into it, which a
	// setvalue casts through the bind's answer class like a default
	// (SetValueAction.processAction); with nothing preloaded it stays blank.
	if (site.source === undefined)
		return site.preloaded && dateTimeBind ? "date" : "string";
	// SetValueAction casts through the bind's answer class.
	if (site.source === "default_value") return dateTimeBind ? "date" : "string";
	// Recalculate.wrapData: the result's own class decides, the bind only
	// whether a Date keeps its clock.
	return scalarHeldOf(analysis?.whole) ?? "string";
}

function clockIsLost(
	site: HiddenWriterSite,
	analysis: HiddenAnalysis | undefined,
	dateTimeBind: boolean,
): boolean {
	if (site.source === undefined || analysis === undefined) return false;
	if (analysis.whole?.clockLost === true) return true;
	for (const output of analysis.outputs) {
		if (output.clockLost) return true;
		if (dateTimeBind) continue;
		// A Date under xsd:string: DateData rounds it to the day (calculate),
		// or StringData keeps its day text (default). A date is a day by
		// meaning; a date and time, or a value of unknown type, loses its clock.
		const data = scalarDataType(output.node?.data);
		if (
			scalarHeldOf(output.node) === "date" &&
			(data === undefined || data === ANY_TYPE || data === "datetime")
		)
			return true;
	}
	return false;
}

/** The data type of every property, as one comparable string: the only fact
 * of `P` the catalog an analysis reads depends on. */
function propertyTypesKey(
	properties: ReadonlyMap<string, PropertyAgreement>,
): string {
	return JSON.stringify(
		[...properties].map(([key, agreement]) => [key, agreement.type ?? null]),
	);
}

/** Node and term kinds that read answers, literals and pure operations only:
 * typing them never consults the case catalog. */
const CATALOG_FREE_KINDS: ReadonlySet<string> = new Set([
	"term",
	"field",
	"literal",
	"choice",
	"arith",
	"concat",
	"coalesce",
	"if",
	"switch",
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"and",
	"or",
	"not",
	"today",
	"now",
	"negate",
	"double",
	"date-coerce",
	"datetime-coerce",
	"date-add",
	"format-date",
	"is-blank",
	"call",
]);

/** Whether an expression holds anything outside `CATALOG_FREE_KINDS`, read
 * anywhere in its tree. */
function mayReadCatalog(expression: Expression | undefined): boolean {
	const visit = (value: unknown): boolean => {
		if (Array.isArray(value)) return value.some(visit);
		if (typeof value !== "object" || value === null) return false;
		const kind = (value as { kind?: unknown }).kind;
		if (typeof kind === "string" && !CATALOG_FREE_KINDS.has(kind)) return true;
		return Object.values(value).some(visit);
	};
	return visit(expression);
}

/** Every uuid of `candidates` an expression names anywhere in its tree. */
function namedUuids(
	expression: Expression | undefined,
	candidates: ReadonlySet<Uuid>,
): Uuid[] {
	const found = new Set<Uuid>();
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			if (candidates.has(value as Uuid)) found.add(value as Uuid);
		} else if (Array.isArray(value)) for (const item of value) visit(item);
		else if (typeof value === "object" && value !== null)
			for (const item of Object.values(value)) visit(item);
	};
	visit(expression);
	return [...found].sort();
}

function signature(state: TypingState): string {
	return JSON.stringify([
		[...state.hidden].map(([uuid, type]) => [uuid, type ?? null]),
		[...state.properties].map(([key, agreement]) => [
			key,
			agreement.type ?? null,
		]),
		state.operations.map((type) => type ?? null),
	]);
}

function stableAcross(states: readonly TypingState[]): TypingState {
	const [first] = states;
	const hidden = new Map<Uuid, CasePropertyDataType | undefined>();
	for (const [uuid, type] of first.hidden)
		hidden.set(
			uuid,
			states.every((state) => state.hidden.get(uuid) === type)
				? type
				: undefined,
		);
	const properties = new Map<string, PropertyAgreement>();
	for (const [key, agreement] of first.properties)
		properties.set(
			key,
			states.every(
				(state) => state.properties.get(key)?.type === agreement.type,
			)
				? agreement
				: { type: undefined, origin: undefined },
		);
	const operations = first.operations.map((type, index) =>
		states.every((state) => state.operations[index] === type)
			? type
			: undefined,
	);
	return { hidden, properties, operations };
}
