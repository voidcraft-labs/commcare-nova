/**
 * The expression stage of a reading: every expression an app holds, read at
 * once over the finished structure into Nova's typed `Expression`, or into
 * the claim that says why not. Typing is a fact of the whole document (one
 * Hidden Value's inferred type decides how another slot's comparison
 * prints), so every slot is bound, printed and compared against one
 * document, and every round of the work builds a new document object: every
 * typing fact is cached per document, and documents are replaced, never
 * changed in place. Pure; it never throws for an app's content.
 */
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import { slotContext } from "@/lib/domain/expression/context";
import { canonicalizeRelationPath } from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import {
	type CheckError,
	checkExpression,
} from "@/lib/domain/expression/typeChecker";
import {
	CASE_TYPE_PATTERN,
	datumRefKey,
	type Expression,
	type ItextUnit,
	isProseSlotRef,
	type RelationPath,
	type SlotContextRef,
	type Term,
	XML_ELEMENT_NAME_PATTERN,
} from "@/lib/domain/expression/types";
import {
	walkExpression,
	walkExpressionNodes,
	walkExpressionTerms,
} from "@/lib/domain/expression/walk";
import { moduleFormsReadSearch } from "@/lib/domain/modules";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import type { ProseTemplate } from "@/lib/domain/prose";
import { canonicalProseAtom } from "@/lib/domain/proseExpression";
import {
	FIELD_REFERENCE_SLOTS,
	FORM_REFERENCE_SLOTS,
	MODULE_REFERENCE_SLOTS,
} from "@/lib/domain/referenceSlots";
import {
	USERCASE_BUILT_IN_KEYS,
	USERCASE_CASE_TYPE,
} from "@/lib/domain/usercase";
import type { Uuid } from "@/lib/domain/uuid";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import { checkCsqlRepresentability } from "../../csql/representability";
import {
	EMISSION_REWRITE_IDS,
	EMISSION_REWRITES,
	type EmissionRewriteId,
} from "../../emissionRewrites";
import {
	formDisplayCondition,
	moduleDisplayCondition,
} from "../../validator/rules/displayConditions";
import type { FormSyntax } from "../../xpath/formSyntax";
import { noteProperty } from "../caseManagement/catalog";
import type { PendingExpression } from "../pendingExpressions";
import { readFormSyntax } from "../syntaxRead";
import type { ReadSourceNames } from "../xform";
import {
	agreedComparedTypes,
	type ComparedType,
	comparedTypes,
} from "./comparedTypes";
import { readSearchFilterRow } from "./csqlRead";
import {
	checkErrorEntry,
	childOfInlineSearchMenu,
	claimKeyOfUse,
	EXPRESSION_CLAIMS,
	type FormDeclarations,
	formRefusalEntry,
	nameGrammarEntry,
	parseIssueEntry,
	rawTextEntry,
	SLOT_ENTRIES,
	visitSyntax,
} from "./findings";
import {
	type BoundSlot,
	bindSlot,
	judgeSlot,
	lookupTypes,
	printSlot,
	type SlotJudgment,
	type SlotRefusal,
	slotForm,
	sourceNodeProjection,
} from "./readExpression";
import { scanReads } from "./scanReads";
import {
	expressionSurfaceUses,
	instanceIdsRead,
	type SurfaceUseFacts,
	unreadDeclarationUse,
} from "./surfaceUses";

export interface ExpressionReadEnv {
	readonly lookup: LookupDefinitionIndex;
	/** Per form: the source's own names, from which the binding projection is built. */
	readonly sourceNames: ReadonlyMap<Uuid, ReadSourceNames>;
	/** Per form: HQ's itext id to the unit the form reader read it as. */
	readonly itextUnits: ReadonlyMap<Uuid, ReadonlyMap<string, ItextUnit>>;
	/** Per form: each declared instance id to its `src`. */
	readonly instanceSources: ReadonlyMap<Uuid, ReadonlyMap<string, string>>;
	/** Per form: a generated sibling the form reader set aside, by absolute path, with its calculate. */
	readonly generatedValues: ReadonlyMap<
		Uuid,
		ReadonlyMap<string, GeneratedValue>
	>;
	/** Per form: the case id path of each Save to Case create, to its operation. */
	readonly operationIdPaths: ReadonlyMap<Uuid, ReadonlyMap<string, Uuid>>;
	/** `ReaderInput.recordDialect`: undefined where the record dialect prints the tree and reads the
	 *  print back to it, else the kind it cannot spell or `"round-trip"`. */
	readonly recordDialect: RecordDialectJudge;
	/** The forms whose entry facts the case reader found differing: a datum
	 *  read the projection does not give raises no claim of its own there. */
	readonly entryFactsRefused: ReadonlySet<Uuid>;
	/** Per form: the form's own place, where a claim of the form's own
	 *  declarations stands. */
	readonly formPlaces: ReadonlyMap<Uuid, HqPlace>;
	/** Per advanced form: the ids its computed datums give
	 *  (`arbitrary_datums`), which a session read may name. */
	readonly computedDatums: ReadonlyMap<Uuid, ReadonlySet<string>>;
}
export interface GeneratedValue {
	readonly purpose: "constraint-count";
	readonly calculate: string;
}
/** The record dialect's round trip for one held tree: undefined where it
 *  prints and reads back, else why not. `lookup` is the reading's table
 *  catalog, which a table read prints its names from. */
export type RecordDialectJudge = (
	doc: BlueprintDoc,
	ref: SlotContextRef,
	expression: Expression,
	lookup: LookupDefinitionIndex,
) => string | undefined;

export interface ExpressionClaim {
	/** The index of the registration the claim is for, in `pending`; -1 for a
	 *  claim of a form's own declaration. */
	readonly source: number;
	readonly entryId: string;
	readonly place: HqPlace;
	readonly key: string;
	readonly detail: FindingDetail;
}
export interface ExpressionReading {
	/** The document with every held expression in its slot, and the properties step 1 declared. */
	readonly doc: BlueprintDoc;
	/** Per registration, in order: the held tree, or undefined where the slot is not held. */
	readonly bound: readonly (Expression | undefined)[];
	/** One claim per expression and per surface use, held or not, in registration order. */
	readonly claims: readonly ExpressionClaim[];
	readonly circumstances: readonly {
		readonly source: number;
		readonly code: "unrecognized";
		readonly place: HqPlace;
		/** `name` is the finding's `detail.name`. `reason` is for the defect
		 *  line alone. */
		readonly detail: { readonly name: string; readonly reason: string };
	}[];
	readonly rewrites: readonly {
		readonly id: EmissionRewriteId;
		readonly place: HqPlace;
		readonly key: string;
	}[];
	/** Case properties the app reads and nothing in it writes, which step 1 declared. */
	readonly declaredProperties: readonly {
		readonly caseType: string;
		readonly property: string;
	}[];
	/** What the expressions read of the worker and of places that the document
	 *  does not hold yet: the `field` of every name-backed `session-user` leaf
	 *  a bound tree holds, and the slug of every `location_data/<slug>` step the
	 *  texts name, each distinct, in code-unit order. */
	readonly worldReads: {
		readonly userFields: readonly string[];
		readonly locationDataSlugs: readonly string[];
	};
	/** Tags an expression reads that the catalog does not hold. */
	readonly unreadTables: readonly string[];
	/** Registrations with no tree and no claim: those whose slot the document
	 *  does not hold, and those of a form in `env.entryFactsRefused` whose
	 *  claim would be M1. In ascending order. */
	readonly ownerless: readonly number[];
	/** How many bind-and-compare rounds ran. */
	readonly rounds: number;
}

/** The bound on bind-and-compare rounds. Each round withdraws a fold site
 *  and a slot holds finitely many, so the work ends without it; a pure
 *  function has no clock, so the bound is a count. */
export const EXPRESSION_ROUND_LIMIT = 64;

// ── Documents ────────────────────────────────────────────────────────

/** A whole new document with `change` applied, never the one given. */
function cloned(
	doc: BlueprintDoc,
	change: (draft: BlueprintDoc) => void,
): BlueprintDoc {
	const draft = hydratePersistedBlueprint(toPersistableDoc(doc));
	change(draft);
	return hydratePersistedBlueprint(toPersistableDoc(draft));
}

type Holder = Record<string, unknown>;
const REGISTRY = [
	...FIELD_REFERENCE_SLOTS,
	...FORM_REFERENCE_SLOTS,
	...MODULE_REFERENCE_SLOTS,
] as readonly {
	readonly entity: string;
	readonly slot: string;
	readonly path: string;
}[];

/** Whether a collection element is the one a slot's member names. */
function namedElement(element: unknown, ref: SlotContextRef): boolean {
	if (typeof element !== "object" || element === null || !("member" in ref))
		return false;
	const item = element as Holder;
	const member = ref.member as Holder;
	for (const key of [
		"linkUuid",
		"operationUuid",
		"columnUuid",
		"searchInputUuid",
		"optionUuid",
	])
		if (member[key] !== undefined && item.uuid === member[key]) return true;
	if (
		"datum" in ref.member &&
		typeof item.name === "object" &&
		item.name !== null
	)
		return datumRefKey(item.name as never) === datumRefKey(ref.member.datum);
	if ("identifier" in ref.member)
		return item.identifier === ref.member.identifier;
	if ("property" in ref.member)
		return (
			item.property === ref.member.property &&
			JSON.stringify(item.via) === JSON.stringify(ref.member.via)
		);
	return false;
}

/** The object that holds a slot's value and the key it is held under, by the
 *  slot registry's path, or undefined where the document lacks the owner or
 *  a member. */
function slotHolder(
	doc: BlueprintDoc,
	ref: SlotContextRef,
): { readonly holder: Holder; readonly key: string } | undefined {
	const owner =
		ref.entity === "field"
			? doc.fields[ref.uuid]
			: ref.entity === "form"
				? doc.forms[ref.uuid]
				: doc.modules[ref.uuid];
	if (owner === undefined) return undefined;
	for (const entry of REGISTRY) {
		if (entry.entity !== ref.entity || entry.slot !== ref.slot) continue;
		const segments = entry.path.split(".");
		let holder: unknown = owner;
		for (const segment of segments.slice(0, -1)) {
			if (typeof holder !== "object" || holder === null) break;
			if (segment.endsWith("[]")) {
				const list = (holder as Holder)[segment.slice(0, -2)];
				holder = Array.isArray(list)
					? list.find((element) => namedElement(element, ref))
					: undefined;
			} else holder = (holder as Holder)[segment];
		}
		if (typeof holder !== "object" || holder === null) continue;
		const last = segments.at(-1) as string;
		if (
			ref.slot === "lookup_options_source" ||
			ref.slot === "search_input_options"
		) {
			const source = (holder as Holder)[last];
			if (typeof source !== "object" || source === null) continue;
			return { holder: source as Holder, key: "filter" };
		}
		return { holder: holder as Holder, key: last };
	}
	return undefined;
}

/** The template of a prose slot. */
function proseTemplate(
	doc: BlueprintDoc,
	ref: SlotContextRef,
): ProseTemplate | undefined {
	if (!isProseSlotRef(ref)) return undefined;
	const field = doc.fields[ref.uuid] as Holder | undefined;
	if (field === undefined) return undefined;
	if (ref.slot !== "option_label")
		return field[ref.slot] as ProseTemplate | undefined;
	const source = field.optionsSource as
		| { options?: { uuid: Uuid; label: ProseTemplate }[] }
		| undefined;
	return source?.options?.find(
		(option) => option.uuid === ref.member.optionUuid,
	)?.label;
}

/** Where each registration's tree is written: a slot, or the part of a
 *  prose template the i-th registration under that template names. */
type Site =
	| { readonly kind: "slot" }
	| { readonly kind: "prose"; readonly part: number };

function sitesOf(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
): readonly (Site | undefined)[] {
	const seen = new Map<string, number>();
	return pending.map((registration) => {
		if (registration.mode.target === "search-row") return undefined;
		const ref = registration.ref;
		if (!isProseSlotRef(ref))
			return slotHolder(doc, ref) === undefined ? undefined : { kind: "slot" };
		const key = JSON.stringify(ref);
		const ordinal = seen.get(key) ?? 0;
		seen.set(key, ordinal + 1);
		const template = proseTemplate(doc, ref);
		const values =
			template?.parts.flatMap((part, index) =>
				part.kind === "value" ? [index] : [],
			) ?? [];
		const part = values[ordinal];
		return part === undefined ? undefined : { kind: "prose", part };
	});
}

/** A fresh document with each given tree written at its site. */
function written(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
	sites: readonly (Site | undefined)[],
	trees: ReadonlyMap<number, Expression>,
): BlueprintDoc {
	return cloned(doc, (draft) => {
		for (const [index, tree] of trees) {
			const site = sites[index];
			const registration = pending[index];
			if (site === undefined || registration === undefined) continue;
			if (site.kind === "slot") {
				const held = slotHolder(draft, registration.ref);
				if (held !== undefined) held.holder[held.key] = tree;
				continue;
			}
			const template = proseTemplate(draft, registration.ref);
			if (template === undefined) continue;
			(template.parts as unknown[])[site.part] = canonicalProseAtom(tree);
		}
	});
}

// ── Claims ───────────────────────────────────────────────────────────

/** The finding's name for a key: the attribute or key the expression sits
 *  in, the last segment of its surface key. */
function claimName(key: string): string {
	const segments = key.split(/[@.:/]/u);
	return (segments.at(-1) ?? key).slice(0, 200);
}

/** The finding's name for a registration's own claim: a calculated
 *  column's header, a Search field's name, and elsewhere the attribute or
 *  key the expression sits in. */
function registrationName(
	doc: BlueprintDoc,
	registration: PendingExpression,
): string {
	const ref = registration.ref;
	if (ref.entity === "module") {
		const config = doc.modules[ref.uuid]?.caseListConfig;
		if (ref.slot === "case_list_column_expression") {
			const column = config?.columns.find(
				(candidate) => candidate.uuid === ref.member.columnUuid,
			);
			if (column !== undefined) return column.header.slice(0, 200);
		} else if ("member" in ref && "searchInputUuid" in ref.member) {
			const uuid = ref.member.searchInputUuid;
			const input = config?.searchInputs.find(
				(candidate) => candidate.uuid === uuid,
			);
			if (input !== undefined) return input.name.slice(0, 200);
		}
	}
	return claimName(registration.key);
}

type Resolution =
	| {
			readonly kind: "entry";
			readonly entryId: string;
			readonly reason: string;
			/** The surface key the entry is answered under, where the reader
			 *  that answered it named one. */
			readonly key?: string;
	  }
	| { readonly kind: "unrecognized"; readonly reason: string };

const M1 =
	EXPRESSION_CLAIMS["session-data-datum-the-entry-does-not-supply"].entry;
const M3 = EXPRESSION_CLAIMS["a-form-expression-outside-what-nova-types"].entry;

/** The index a case query reaches its rows through where the query names no
 *  case type and the index is not `parent`: HQ's `#host` join. Nova prints a
 *  relation step other than `parent` only with its type test
 *  (`rowScope.ts::caseById`), so no print of Nova's spells this one. */
function untypedRelationStep(tree: Expression): string | undefined {
	let found: string | undefined;
	const visit = (node: Expression | Term): void => {
		if (found !== undefined || node.kind !== "cases") return;
		let identifier: string | undefined;
		let typed = false;
		for (const clause of node.where)
			walkExpressionTerms(clause, (term) => {
				if (term.kind === "case-row-type") typed = true;
				if (term.kind === "case-index" && term.identifier !== "parent")
					identifier ??= term.identifier;
			});
		if (identifier !== undefined && !typed) found = identifier;
	};
	walkExpression(tree, { visitExpression: visit, visitTerm: visit });
	return found;
}

function slotDefault(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	form: () => string,
): string {
	const refused = SLOT_ENTRIES[ref.slot].refused(doc, ref);
	return refused === "form-default" ? form() : refused;
}

/** What the slot's form declares beside its expressions. */
function declarationsOf(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	env: ExpressionReadEnv,
): FormDeclarations {
	const form = slotForm(doc, ref);
	return {
		instanceSources:
			(form === undefined ? undefined : env.instanceSources.get(form)) ??
			new Map(),
		computedDatums:
			(form === undefined ? undefined : env.computedDatums.get(form)) ??
			new Set(),
	};
}

function refusalOf(
	cause: SlotRefusal,
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
): Resolution {
	if (cause.kind === "no-case-datum")
		return { kind: "unrecognized", reason: "no-case-datum" };
	// A search filter row is read by `readSearchFilterRow`, which answers its
	// own reason; the wrapper's own node is where nothing bound.
	if (cause.kind === "search-row") {
		const wrapper = textSyntax(pending.text);
		return {
			kind: "unrecognized",
			reason:
				wrapper === undefined ? "parse:syntax" : `differs:${wrapper.kind}`,
		};
	}
	const issue =
		cause.kind === "interpolation"
			? { code: cause.code }
			: cause.kind === "parse"
				? (cause.issues[0] ?? {
						code: "syntax" as const,
						from: 0,
						to: pending.text.length,
						message: "",
					})
				: {
						code: "syntax" as const,
						from: 0,
						to: pending.text.length,
						message: "",
					};
	const answer = parseIssueEntry(
		issue,
		doc,
		pending,
		declarationsOf(doc, pending.ref, env),
	);
	if (answer.entryId === "unrecognized")
		return { kind: "unrecognized", reason: answer.reason };
	return {
		kind: "entry",
		entryId:
			answer.entryId === "slot-default"
				? slotDefault(doc, pending.ref, () => M3)
				: answer.entryId,
		reason: answer.reason,
	};
}

function checkRefusal(
	error: CheckError,
	doc: BlueprintDoc,
	pending: PendingExpression,
): Resolution {
	const answer = checkErrorEntry(error, doc, pending);
	return {
		kind: "entry",
		entryId:
			answer.entryId === "slot-default"
				? slotDefault(doc, pending.ref, () => formRefusalEntry(error.code))
				: answer.entryId,
		reason: answer.reason,
	};
}

/** The checker's refusals that are refusals here: a leaf a declared platform
 *  lacks is a use the declaration planner counts at assembly. */
function refusals(errors: readonly CheckError[]): readonly CheckError[] {
	return errors.filter(
		(error) =>
			!(
				error.code === "arm-unavailable" &&
				error.reason === "platform-unavailable"
			),
	);
}

// ── The stage ────────────────────────────────────────────────────────

/** What one registration came to before its claim. */
type Outcome =
	| { readonly kind: "ownerless" }
	| { readonly kind: "held"; readonly tree: Expression }
	| { readonly kind: "refused"; readonly resolution: Resolution };

const WITHHOLD_ALL = new Set<EmissionRewriteId>(EMISSION_REWRITE_IDS);

export function readExpressions(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
	env: ExpressionReadEnv,
): ExpressionReading {
	const types = lookupTypes(env);
	const live = pending.map(
		(registration) => slotContext(doc, registration.ref, types) !== undefined,
	);
	const sites = sitesOf(doc, pending);

	// 1. Scan, and declare the case properties binding will find.
	const scanned = scanReads(pending, doc, env);
	const known = new Set(
		effectiveCaseTypes(doc).flatMap((type) =>
			type.properties.map((property) =>
				JSON.stringify([type.name, property.name]),
			),
		),
	);
	const missing = scanned.caseProperties.filter(
		(read) => !known.has(JSON.stringify([read.caseType, read.property])),
	);
	const scannedBase = cloned(doc, (draft) => {
		const catalog = draft.caseTypes;
		if (catalog === undefined || catalog === null) return;
		// A walk up `index/parent` to a type it tests names that type and
		// the parent of the type it leaves, where the catalog says neither.
		const named = (name: string) =>
			CASE_TYPE_PATTERN.test(name) && name !== USERCASE_CASE_TYPE;
		for (const link of scanned.parentLinks) {
			if (!named(link.child) || !named(link.parent)) continue;
			const known = catalog.find((type) => type.name === link.child);
			if (known?.parent_type !== undefined) continue;
			if (known === undefined)
				catalog.push({ name: link.child, properties: [] });
			if (!catalog.some((type) => type.name === link.parent))
				catalog.push({ name: link.parent, properties: [] });
			const child = catalog.find((type) => type.name === link.child);
			if (child === undefined) continue;
			child.parent_type = link.parent;
			child.relationship = "child";
		}
		for (const read of missing)
			noteProperty(catalog, read.caseType, read.property);
	});
	// 1b. Type: a property the catalog holds untyped that a record slot
	// compares with a value of a known type is of that type.
	const base = withComparedTypes(scannedBase, pending, live, sites, env);
	const declaredProperties = missing.filter((read) =>
		(base.caseTypes ?? []).some(
			(type) =>
				type.name === read.caseType &&
				type.properties.some((property) => property.name === read.property),
		),
	);

	// 2 and 3. Bind every registration, write, compare every slot; withdraw
	// one fold site per unequal slot and go again.
	const withdrawn = pending.map(() => new Set<string>());
	const bindings = new Map<number, BoundSlot>();
	const refused = new Map<number, SlotRefusal>();
	const searchRows = new Map<number, ReturnType<typeof readSearchFilterRow>>();
	// A form's display condition that reads a case attribute through a bare
	// `#case`, which HQ's build would write as a standard property's read.
	const rawRefusals = new Map<
		number,
		{ readonly entryId: string; readonly reason: string }
	>();
	const bindAt = (current: BlueprintDoc, index: number): void => {
		const registration = pending[index] as PendingExpression;
		const bound = bindSlot(
			current,
			registration,
			env,
			withdrawn[index] as Set<string>,
		);
		if (bound.kind === "refused") {
			refused.set(index, bound.cause);
			bindings.delete(index);
		} else {
			bindings.set(index, bound.bound);
			refused.delete(index);
		}
	};
	const bindable: number[] = [];
	pending.forEach((registration, index) => {
		if (!live[index]) return;
		if (registration.mode.target === "search-row") {
			const context = slotContext(base, registration.ref, types);
			if (context !== undefined)
				searchRows.set(
					index,
					readSearchFilterRow(registration.text, context, {
						doc: base,
						lookup: env.lookup,
					}),
				);
			return;
		}
		if (sites[index] === undefined) {
			live[index] = false;
			return;
		}
		const raw = rawTextEntry(registration);
		if (raw !== undefined) {
			rawRefusals.set(index, raw);
			return;
		}
		bindable.push(index);
	});
	// The trees step 4 holds at the second level, which every slot is judged
	// against once they differ from what the slot bound.
	let settled = new Map<number, Expression>();
	const treesOf = (): Map<number, Expression> =>
		new Map([
			...[...bindings].map(
				([index, bound]) => [index, bound.candidate] as const,
			),
			...settled,
		]);
	let current = base;
	let judgments = new Map<number, SlotJudgment>();
	let rounds = 0;
	let outcomes = new Map<number, Outcome>();
	let rewrites: ExpressionReading["rewrites"][number][] = [];
	let leveled = new Map<number, Expression>();
	for (;;) {
		const start =
			settled.size === 0 ? base : written(base, pending, sites, settled);
		// A leveled slot keeps the sites it withdrew; every other slot is
		// offered its folds again over the leveled document.
		withdrawn.forEach((taken, index) => {
			if (!settled.has(index)) taken.clear();
		});
		for (const index of bindable) bindAt(start, index);
		current = written(base, pending, sites, treesOf());
		for (;;) {
			rounds++;
			judgments = new Map(
				[...bindings].map(([index, bound]) => [
					index,
					judgeSlot(current, pending[index] as PendingExpression, env, bound),
				]),
			);
			const withdrawing = [...judgments].flatMap(([index, judgment]) =>
				judgment.kind === "bound" &&
				!judgment.equal &&
				judgment.withdraw !== undefined
					? [[index, judgment.withdraw] as const]
					: [],
			);
			if (withdrawing.length === 0 || rounds >= EXPRESSION_ROUND_LIMIT) break;
			for (const [index, site] of withdrawing) {
				withdrawn[index]?.add(site);
				bindAt(current, index);
			}
			current = written(base, pending, sites, treesOf());
		}

		// 4. Level: a slot still unequal is compared with the print that leaves
		// every rewrite out, and held at that level as the tree Nova's own print
		// reads back as.
		outcomes = new Map<number, Outcome>();
		rewrites = [];
		leveled = new Map<number, Expression>();
		for (const [index, judgment] of judgments) {
			const registration = pending[index] as PendingExpression;
			const bound = bindings.get(index) as BoundSlot;
			if (judgment.kind === "unprintable") continue;
			if (judgment.kind === "refused") continue;
			if (judgment.equal) {
				outcomes.set(index, { kind: "held", tree: judgment.candidate });
				continue;
			}
			const reached = new Set<EmissionRewriteId>();
			const withheld = judgeSlot(current, registration, env, bound, {
				withhold: WITHHOLD_ALL,
				reached: (id) => reached.add(id),
			});
			if (withheld.kind === "bound" && withheld.equal) {
				const tree = readBack(current, registration, env, bound.candidate);
				leveled.set(index, tree);
				outcomes.set(index, { kind: "held", tree });
				for (const id of EMISSION_REWRITE_IDS)
					if (reached.has(id) && EMISSION_REWRITES[id].behavior === "changes")
						rewrites.push({
							id,
							place: registration.place,
							key: registration.key,
						});
				continue;
			}
			const relation =
				slotContext(current, registration.ref, types)?.ruleSet === "record"
					? untypedRelationStep(judgment.candidate)
					: undefined;
			if (relation !== undefined) {
				// HQ's `#host` join: the relation Nova holds it as is not built yet,
				// so the slot is not yet held, under its own entry.
				outcomes.set(index, {
					kind: "refused",
					resolution: {
						kind: "entry",
						entryId: slotDefault(current, registration.ref, () => M3),
						reason: XML_ELEMENT_NAME_PATTERN.test(relation)
							? `relation:${relation}`
							: "name:index-identifier",
					},
				});
				continue;
			}
			outcomes.set(index, {
				kind: "refused",
				resolution: {
					kind: "unrecognized",
					reason: `differs:${(judgment.difference ?? judgment.source).kind}`,
				},
			});
		}
		// A tree held at the second level can type a Hidden Value otherwise
		// than the tree its slot bound, and with it how another slot prints:
		// every slot is bound and judged again against a document holding the
		// leveled trees, until leveling holds the trees that document holds.
		const again =
			leveled.size !== settled.size ||
			[...leveled].some(
				([index, tree]) =>
					JSON.stringify(tree) !==
					JSON.stringify(settled.get(index) ?? bindings.get(index)?.candidate),
			);
		if (!again || rounds >= EXPRESSION_ROUND_LIMIT) break;
		settled = leveled;
	}
	const circumstances: ExpressionReading["circumstances"][number][] = [];
	const checked =
		leveled.size === 0
			? current
			: written(base, pending, sites, new Map([...treesOf(), ...leveled]));

	// 5. Check every held slot over the document that holds every bound
	// candidate; 6. hand every held record slot to the dialect's judge.
	for (const [index, judgment] of judgments) {
		const registration = pending[index] as PendingExpression;
		const outcome = outcomes.get(index);
		const candidate =
			outcome?.kind === "held"
				? outcome.tree
				: judgment.kind === "unprintable"
					? judgment.candidate
					: undefined;
		if (candidate === undefined) continue;
		const context = slotContext(checked, registration.ref, types);
		if (context === undefined) continue;
		const named = nameGrammarEntry(candidate);
		if (named !== undefined) {
			outcomes.set(index, {
				kind: "refused",
				resolution: {
					kind: "entry",
					entryId:
						named.entryId === "slot-default"
							? slotDefault(checked, registration.ref, () => M3)
							: named.entryId,
					reason: named.reason,
				},
			});
			continue;
		}
		const errors = refusals(checkExpression(candidate, context).errors);
		const first = errors[0];
		if (first !== undefined) {
			outcomes.set(index, {
				kind: "refused",
				resolution: checkRefusal(first, checked, registration),
			});
			continue;
		}
		if (judgment.kind === "unprintable") {
			// The emitter refuses what the gate refuses: the checker above, or
			// a display condition a device cannot evaluate.
			const display = displayRefusal(checked, registration.ref);
			outcomes.set(index, {
				kind: "refused",
				resolution:
					display === undefined
						? // The emitter wrote no print to compare the source with.
							{ kind: "unrecognized", reason: "differs:print" }
						: {
								kind: "entry",
								entryId: slotDefault(checked, registration.ref, () => M3),
								reason: `validator:${display}`,
							},
			});
			continue;
		}
		// CommCare's server search reads a condition as CSQL; a value it shows
		// (a calculated column of a search's results) it does not, so only a
		// condition is held to CSQL, as every editor's gate holds it
		// (`lib/doc/commitVerdicts.ts::expressionEditVerdict`).
		const representable =
			context.profile.targets.has("CS") &&
			context.profile.expectation.kind === "condition"
				? checkCsqlRepresentability(candidate, context)[0]
				: undefined;
		if (representable !== undefined) {
			outcomes.set(index, {
				kind: "refused",
				resolution: {
					kind: "entry",
					entryId: slotDefault(checked, registration.ref, () => M3),
					reason: `csql:${representable.reason}`,
				},
			});
			continue;
		}
		const display = displayRefusal(checked, registration.ref);
		if (display !== undefined) {
			outcomes.set(index, {
				kind: "refused",
				resolution: {
					kind: "entry",
					entryId: slotDefault(checked, registration.ref, () => M3),
					reason: `validator:${display}`,
				},
			});
			continue;
		}
		if (context.ruleSet === "record") {
			const answer = env.recordDialect(
				checked,
				registration.ref,
				candidate,
				env.lookup,
			);
			if (answer !== undefined)
				outcomes.set(index, {
					kind: "refused",
					resolution: {
						kind: "entry",
						entryId: slotDefault(checked, registration.ref, () => M3),
						reason: `dialect:${answer}`,
					},
				});
		}
	}
	for (const [index, cause] of refused)
		outcomes.set(index, {
			kind: "refused",
			resolution: refusalOf(
				cause,
				checked,
				pending[index] as PendingExpression,
				env,
			),
		});
	for (const [index, raw] of rawRefusals)
		outcomes.set(index, {
			kind: "refused",
			resolution: { kind: "entry", ...raw },
		});
	for (const [index, row] of searchRows) {
		const registration = pending[index] as PendingExpression;
		if (row.ok) {
			outcomes.set(index, { kind: "held", tree: row.predicate });
			for (const id of row.rewrites)
				if (EMISSION_REWRITES[id].behavior === "changes")
					rewrites.push({
						id,
						place: registration.place,
						key: registration.key,
					});
			continue;
		}
		outcomes.set(index, {
			kind: "refused",
			resolution:
				"claim" in row
					? {
							kind: "entry",
							entryId: row.claim.entryId,
							reason: row.claim.detail.reason ?? "",
							key: row.claim.key,
						}
					: { kind: "unrecognized", reason: row.reason },
		});
	}

	// 7. Report.
	const bound: (Expression | undefined)[] = pending.map(() => undefined);
	const claims: ExpressionClaim[] = [];
	const ownerless: number[] = [];
	const held = new Map<number, Expression>();
	pending.forEach((registration, index) => {
		if (!live[index]) {
			ownerless.push(index);
			return;
		}
		const outcome = outcomes.get(index);
		if (outcome === undefined || outcome.kind === "ownerless") {
			ownerless.push(index);
			return;
		}
		const name = registrationName(checked, registration);
		// The uses the text makes, before HQ's interpolation, held or not.
		const source = textSyntax(registration.text);
		const context = slotContext(checked, registration.ref, types);
		const uses =
			source === undefined || context === undefined
				? []
				: expressionSurfaceUses(
						source,
						outcome.kind === "held" ? outcome.tree : undefined,
						context,
						registration.mode,
						surfaceUseFactsOf(
							checked,
							registration,
							env,
							refused.get(index),
							outcome,
						),
					);
		// The keys this registration's claims hold: one claim per key at a node.
		const claimed = new Set<string>();
		if (outcome.kind === "held") {
			bound[index] = outcome.tree;
			if (registration.mode.target !== "search-row")
				held.set(index, outcome.tree);
			const entryId =
				registration.mode.target === "search-row"
					? undefined
					: SLOT_ENTRIES[registration.ref.slot].held(
							checked,
							registration.ref,
							outcome.tree,
						);
			if (entryId !== undefined) {
				claimed.add(registration.key);
				claims.push({
					source: index,
					entryId,
					place: registration.place,
					key: registration.key,
					detail: { name },
				});
			}
		} else if (outcome.resolution.kind === "unrecognized")
			circumstances.push({
				source: index,
				code: "unrecognized",
				place: registration.place,
				detail: { name: registration.key, reason: outcome.resolution.reason },
			});
		else {
			const form = slotForm(checked, registration.ref);
			if (
				outcome.resolution.entryId === M1 &&
				form !== undefined &&
				env.entryFactsRefused.has(form)
			) {
				ownerless.push(index);
				return;
			}
			// The slot's own claim is under the registration's key, which the
			// frame finds it by; where the entry is registered under the key of
			// a use the text makes (an operator, a function, an instance
			// scheme), the claim is recorded under that key too, and stands for
			// that use.
			const entryKey =
				outcome.resolution.key ??
				claimKeyOfUse(
					outcome.resolution.entryId,
					uses.map((use) => use.key),
				);
			claimed.add(registration.key);
			claims.push({
				source: index,
				entryId: outcome.resolution.entryId,
				place: registration.place,
				key: registration.key,
				detail: { name, reason: outcome.resolution.reason },
			});
			if (entryKey !== undefined && entryKey !== registration.key) {
				claimed.add(entryKey);
				claims.push({
					source: index,
					entryId: outcome.resolution.entryId,
					place: registration.place,
					key: entryKey,
					detail: { name },
				});
			}
		}
		for (const use of uses)
			if (!claimed.has(use.key))
				claims.push({
					source: index,
					entryId: use.entryId,
					place: registration.place,
					key: use.key,
					detail: { name },
				});
	});
	claims.push(...declarationClaims(checked, pending, env, held));
	// A search filter row's tree is written by the search reader, not here,
	// but it reads the worker and the case's properties all the same.
	const searchTrees = [...searchRows.values()].flatMap((row) =>
		row.ok ? [row.predicate] : [],
	);
	const userFields = new Set<string>();
	for (const tree of [
		...[...bindings.values()].map((binding) => binding.candidate),
		...searchTrees,
	])
		walkExpressionTerms(tree, (term) => {
			// A field CommCare HQ writes on every worker's own case
			// (`callcenter/sync_usercase.py::_get_user_case_fields`) is no
			// worker property: the read stays the name-backed leaf.
			if (
				term.kind === "session-user" &&
				!(
					term.source === "worker-record" &&
					USERCASE_BUILT_IN_KEYS.includes(term.field)
				)
			)
				userFields.add(term.field);
		});
	// A relation read names the type it walks from; the property it reads is
	// the type's the relation reaches.
	const reads = new Set<string>();
	for (const tree of [...held.values(), ...searchTrees])
		walkExpressionTerms(tree, (term) => {
			if (term.kind !== "prop" && term.kind !== "form-case") return;
			const caseType =
				term.kind === "prop" && term.via !== undefined
					? relationDestination(base, term.caseType, term.via)
					: term.caseType;
			if (caseType !== undefined)
				reads.add(JSON.stringify([caseType, term.property]));
		});
	const unread = declaredProperties.filter(
		(read) => !reads.has(JSON.stringify([read.caseType, read.property])),
	);
	const kept = declaredProperties.filter((read) => !unread.includes(read));
	const result = cloned(written(base, pending, sites, held), (draft) => {
		for (const read of unread) {
			const type = draft.caseTypes?.find(
				(entry) => entry.name === read.caseType,
			);
			if (type === undefined) continue;
			type.properties = type.properties.filter(
				(property) => property.name !== read.property,
			);
		}
	});
	return {
		doc: result,
		bound,
		claims,
		circumstances,
		rewrites,
		declaredProperties: kept,
		worldReads: {
			userFields: [...userFields].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
			locationDataSlugs: scanned.locationDataSlugs,
		},
		unreadTables: scanned.lookupTags.filter(
			(tag) => ![...env.lookup.values()].some((table) => table.tag === tag),
		),
		ownerless: ownerless.sort((a, b) => a - b),
		rounds,
	};
}

/** `doc` with each property its catalog holds untyped typed as the record
 *  slots compare it (`comparedTypes`): every registration bound with every
 *  fold on, and every Search field's condition the search reader wrote,
 *  which no registration holds. */
function withComparedTypes(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
	live: readonly boolean[],
	sites: readonly (Site | undefined)[],
	env: ExpressionReadEnv,
): BlueprintDoc {
	const types = lookupTypes(env);
	const effective = effectiveCaseTypes(doc);
	const untyped = (caseType: string, property: string): boolean => {
		const declared = (doc.caseTypes ?? [])
			.find((type) => type.name === caseType)
			?.properties.some((one) => one.name === property);
		const typed = effective
			.find((type) => type.name === caseType)
			?.properties.find((one) => one.name === property)?.data_type;
		return declared === true && typed === undefined;
	};
	const found: ComparedType[] = [];
	const compare = (tree: Expression, ref: SlotContextRef) => {
		const context = slotContext(doc, ref, types);
		if (context?.ruleSet === "record")
			found.push(...comparedTypes(tree, context, untyped));
	};
	pending.forEach((registration, index) => {
		if (!live[index]) return;
		const context = slotContext(doc, registration.ref, types);
		if (context?.ruleSet !== "record") return;
		if (registration.mode.target === "search-row") {
			const row = readSearchFilterRow(registration.text, context, {
				doc,
				lookup: env.lookup,
			});
			if (row.ok) found.push(...(row.types ?? []));
			return;
		}
		if (sites[index] === undefined) return;
		const bound = bindSlot(doc, registration, env, new Set());
		if (bound.kind !== "bound") return;
		compare(bound.bound.candidate, registration.ref);
		// Two properties the catalog holds untyped, compared, print as
		// written; as dates and times a device compares them as moments. Where
		// only that print is the source's, they are dates and times.
		const pairs = untypedPairs(bound.bound.candidate, untyped);
		if (pairs.length === 0) return;
		const asMoments = pairs.map((one) => ({
			...one,
			dataType: "datetime" as const,
		}));
		const equal = (at: BlueprintDoc) => {
			const judgment = judgeSlot(at, registration, env, bound.bound);
			return judgment.kind === "bound" && judgment.equal;
		};
		if (!equal(doc) && equal(withTypes(doc, asMoments)))
			found.push(...asMoments);
	});
	for (const moduleUuid of doc.moduleOrder)
		for (const input of doc.modules[moduleUuid]?.caseListConfig?.searchInputs ??
			[])
			if (input.kind === "advanced")
				compare(input.predicate, {
					entity: "module",
					uuid: moduleUuid,
					slot: "search_input_predicate",
					member: { searchInputUuid: input.uuid },
				} as SlotContextRef);
	return withTypes(doc, agreedComparedTypes(found));
}

/** `doc` with each of `types` declared on its property. */
function withTypes(
	doc: BlueprintDoc,
	types: readonly ComparedType[],
): BlueprintDoc {
	if (types.length === 0) return doc;
	return cloned(doc, (draft) => {
		for (const one of types) {
			const declared = draft.caseTypes
				?.find((type) => type.name === one.caseType)
				?.properties.find((property) => property.name === one.property);
			if (declared !== undefined) declared.data_type = one.dataType;
		}
	});
}

/** The properties of each comparison whose two sides are properties the
 *  catalog holds untyped. */
function untypedPairs(
	tree: Expression,
	untyped: (caseType: string, property: string) => boolean,
): { caseType: string; property: string }[] {
	const out: { caseType: string; property: string }[] = [];
	const property = (side: Expression) =>
		side.kind === "term" &&
		side.term.kind === "prop" &&
		side.term.caseType !== undefined &&
		(side.term.via === undefined || side.term.via.kind === "self") &&
		untyped(side.term.caseType, side.term.property)
			? { caseType: side.term.caseType, property: side.term.property }
			: undefined;
	const visit = (node: Expression): void => {
		if (
			node.kind === "eq" ||
			node.kind === "neq" ||
			node.kind === "gt" ||
			node.kind === "gte" ||
			node.kind === "lt" ||
			node.kind === "lte"
		) {
			const left = property(node.left);
			const right = property(node.right);
			if (left !== undefined && right !== undefined) out.push(left, right);
		}
	};
	walkExpressionNodes(tree, visit);
	return out;
}

/** The case type a relation read reaches from `origin`, by its steps' own
 *  types and the catalog; undefined where the catalog does not resolve it. */
function relationDestination(
	doc: BlueprintDoc,
	origin: string | undefined,
	via: RelationPath,
): string | undefined {
	if (via.kind === "self") return origin;
	try {
		return canonicalizeRelationPath(via, {
			caseTypes: doc.caseTypes ?? [],
			...(origin === undefined ? {} : { currentCaseType: origin }),
		}).destinationCaseType;
	} catch {
		return undefined;
	}
}

/** A registration's text as the one grammar reads it, before HQ's
 *  interpolation: a search filter row's wrapper, an XForm attribute, an HQ
 *  JSON value with its hashtags. */
function textSyntax(text: string): FormSyntax | undefined {
	try {
		const read = readFormSyntax(text);
		return read.ok ? read.node : undefined;
	} catch {
		return undefined;
	}
}

const DATUM_ISSUES: ReadonlySet<string> = new Set([
	"unknown-datum",
	"placeholder-datum",
	"multi-select-datum-value",
]);

/** What decides the class of a registration's surface uses beyond its
 *  syntax: the datums its entry does not supply, by the parse issues that
 *  name them or by its refusal under M1; the computed datums of its form; and
 *  where its menu stands to a search whose answers its forms read. */
function surfaceUseFactsOf(
	doc: BlueprintDoc,
	registration: PendingExpression,
	env: ExpressionReadEnv,
	cause: SlotRefusal | undefined,
	outcome: Outcome,
): SurfaceUseFacts {
	const unsupplied = new Set<string>();
	if (cause?.kind === "parse")
		for (const issue of cause.issues) {
			if (!DATUM_ISSUES.has(issue.code)) continue;
			const node = textSyntax(registration.text.slice(issue.from, issue.to));
			let last: string | undefined;
			if (node !== undefined)
				visitSyntax(node, (at) => {
					if (at.kind === "name") last = at.name;
				});
			if (last !== undefined) unsupplied.add(last);
		}
	const m1 =
		outcome.kind === "refused" &&
		outcome.resolution.kind === "entry" &&
		outcome.resolution.entryId === M1;
	const ref = registration.ref;
	const form = slotForm(doc, ref);
	const moduleUuid =
		ref.entity === "module"
			? ref.uuid
			: form === undefined
				? undefined
				: moduleUuidOfForm(doc, form);
	const mod = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	return {
		unsupplied: m1 && unsupplied.size === 0 ? "all" : unsupplied,
		computedDatums:
			(form === undefined ? undefined : env.computedDatums.get(form)) ??
			new Set(),
		menu:
			mod !== undefined && moduleFormsReadSearch(mod)
				? "inline"
				: form !== undefined && childOfInlineSearchMenu(doc, form)
					? "child-of-inline"
					: "other",
		instanceSources:
			(form === undefined ? undefined : env.instanceSources.get(form)) ??
			new Map(),
	};
}

/** The claims of each form's `<instance>` declarations that no held
 *  expression of the form reads, at the form's place, keyed by the
 *  declaration's source. They belong to no registration: `source` is -1. */
function declarationClaims(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
	env: ExpressionReadEnv,
	held: ReadonlyMap<number, Expression>,
): ExpressionClaim[] {
	const claims: ExpressionClaim[] = [];
	for (const [form, sources] of env.instanceSources) {
		const place = env.formPlaces.get(form);
		if (place === undefined) continue;
		const read = new Set<string>();
		pending.forEach((registration, index) => {
			if (slotForm(doc, registration.ref) !== form || !held.has(index)) return;
			for (const id of instanceIdsRead(registration.text)) read.add(id);
		});
		for (const [id, src] of sources) {
			if (read.has(id)) continue;
			const use = unreadDeclarationUse(src);
			claims.push({
				source: -1,
				entryId: use.entryId,
				place,
				key: use.key,
				detail: { name: "instance" },
			});
		}
	}
	return claims;
}

/** The tree a slot's unwithheld print reads back as: the tree acceptance's
 *  re-read of Nova's emission gives, which a held slot at the second level
 *  stores so the document equals its own re-read. */
function readBack(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
	candidate: Expression,
): Expression {
	const form = slotForm(doc, pending.ref);
	const names = form === undefined ? undefined : env.sourceNames.get(form);
	let text: string;
	try {
		text = printSlot(doc, pending.ref, candidate, env, {
			...(form !== undefined && names !== undefined
				? { projection: sourceNodeProjection(doc, form, names) }
				: {}),
		});
	} catch {
		return candidate;
	}
	if (!readFormSyntax(text).ok) return candidate;
	const again = bindSlot(doc, { ...pending, text }, env, new Set());
	return again.kind === "bound" ? again.bound.candidate : candidate;
}

/** The validator's display-condition rule a held display condition breaks:
 *  a condition a device cannot evaluate, judged over the whole condition,
 *  the clauses after a leading `false()` included. The hidden spelling
 *  itself (`false()` first, the validator's other rule) is no refusal: the
 *  menu reader reads it as the item off the menu. */
function displayRefusal(
	doc: BlueprintDoc,
	ref: SlotContextRef,
): string | undefined {
	const code = "DISPLAY_CONDITION_NOT_ON_DEVICE";
	if (ref.entity === "module" && ref.slot === "module_display_condition") {
		const mod = doc.modules[ref.uuid];
		if (mod === undefined) return undefined;
		return moduleDisplayCondition(mod, ref.uuid, doc).some(
			(error) => error.code === code,
		)
			? code
			: undefined;
	}
	if (ref.entity === "form" && ref.slot === "form_display_condition") {
		const moduleUuid = Object.entries(doc.formOrder).find(([, forms]) =>
			forms.includes(ref.uuid),
		)?.[0];
		if (moduleUuid === undefined) return undefined;
		return formDisplayCondition(doc, ref.uuid, moduleUuid as Uuid).some(
			(error) => error.code === code,
		)
			? code
			: undefined;
	}
	return undefined;
}
