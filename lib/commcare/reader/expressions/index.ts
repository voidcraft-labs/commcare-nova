/**
 * The expression stage of a reading: every expression a reader registered,
 * read at once over the finished structure into Nova's typed `Expression`,
 * or into the claim that says why not. A search filter row is no
 * registration: the search reader reads it where the search is settled
 * (`csqlRead.ts`, `searchRows.ts`). Typing is a fact of the whole document (one
 * Hidden Value's inferred type decides how another slot's comparison
 * prints), so every slot is bound, printed and compared against one
 * document, and every round of the work builds a new document object: every
 * typing fact is cached per document, and documents are replaced, never
 * changed in place. Pure; it never throws for an app's content.
 */

import { freeze, produce } from "immer";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { readChosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import type {
	ExpressionContext,
	LookupDefinitionIndex,
} from "@/lib/domain/expression/context";
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
import { isDeeplySettled } from "@/lib/domain/settled";
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
	lookupFixtureId,
	lookupFixtureSrc,
	lookupXformInstanceId,
} from "../../lookup/naming";
import { inventoryIndex } from "../../surface/inventory";
import {
	formDisplayCondition,
	moduleDisplayCondition,
} from "../../validator/rules/displayConditions";
import { rethrowWorkStop } from "../../workMeter";
import type { FormSyntax } from "../../xpath/formSyntax";
import { instanceSourcesAfterScan } from "../../xpath/instanceSources";
import { noteProperty } from "../caseManagement/catalog";
import { type HandOffKind, sameJson } from "../jsonCursor";
import {
	type PendingExpression,
	pendingPlaceholder,
} from "../pendingExpressions";
import { guessKey } from "../search/dateRangeGuesses";
import { readFormSyntax, sharedFormSyntax } from "../syntaxRead";
import type { ReaderKnownCaseTypes } from "../types";
import type { ReadSourceNames } from "../xform";
import {
	agreedComparedTypes,
	type ComparedType,
	comparedTypes,
	mergedCandidates,
	type RequiredType,
	requiredTypes,
	untypedOutputProperties,
	valueProperties,
} from "./comparedTypes";
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
	slotEntries,
	tableReadTag,
	visitSyntax,
} from "./findings";
import { levelControl, type PrintLevel } from "./printLevel";
import {
	type BoundSlot,
	bindSlot,
	instanceSourcesOf,
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
	type SurfaceUse,
	type SurfaceUseFacts,
	syntaxHoldsHashtag,
	unreadDeclarationUse,
	unreadSlotUses,
} from "./surfaceUses";

export interface ExpressionReadEnv {
	readonly factories?: import("../../xpath/instanceSources").InstanceFactories;
	readonly lookup: LookupDefinitionIndex;
	/** Per form: the source's own names, from which the binding projection is built. */
	readonly sourceNames: ReadonlyMap<Uuid, ReadSourceNames>;
	/** Per form: HQ's itext id to the unit the form reader read it as. */
	readonly itextUnits: ReadonlyMap<Uuid, ReadonlyMap<string, ItextUnit>>;
	/** Per form: each declared instance id to its `src`. */
	readonly instanceSources: ReadonlyMap<Uuid, ReadonlyMap<string, string>>;
	/** Declarations and scanned factory instances in each rendered XForm. */
	readonly formReadSources?: ReadonlyMap<Uuid, ReadonlyMap<string, string>>;
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
	/** `ReaderInput.knownCaseTypes`: the type the document Nova holds declares for each
	 *  property step 1 declares (`noteProperty`). */
	readonly knownCaseTypes?: ReaderKnownCaseTypes;
	/** The properties the search stage typed `date` only for a date range field over them
	 *  (`search/dateRangeGuesses.ts`), by `guessKey`, which a record slot's comparison types
	 *  as it compares them. */
	readonly dateRangeGuesses?: ReadonlySet<string>;
	/** The number type a list's stored order element compares each calculated column by
	 *  (`caseList/order.ts::SortReading.numericColumns`), by column: the type of the number the
	 *  column gives. */
	readonly numericSortColumns?: ReadonlyMap<Uuid, "int" | "double">;
	/** Each registration is a value a device works out inside a search row's text
	 *  (`csqlRead.ts::bindDevice`), never a slot's whole source, so none of its top-level
	 *  conjuncts is a row of the search (`folds.ts::conjunctsPrintAsRows`). */
	readonly rowValues?: true;
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
	/** Where project data's rules settle the claim instead: a read of a table
	 *  the catalog lacks is handed to its lookup table rules, which raise the
	 *  table's one finding at `{ kind: "lookup-table", tag }` whichever slot
	 *  read it, so the node is handed off and raises nothing of its own. */
	readonly handOff?: { readonly to: HandOffKind; readonly subject: string };
	/** The refusal that keeps a slot out where its entry names the key of a use the text makes
	 *  and not the slot's own key (`jr:choice-name` over a select whose choices come from a
	 *  table, in a display condition): the slot's own claim stands under the slot's allowing
	 *  entry, and the refusal, the reading's one finding, is claimed at the same node under the
	 *  use's key. Applied with the claim (`provisional.ts::applyExpressionClaim`). */
	readonly refusal?: {
		readonly entryId: string;
		readonly key: string;
		readonly detail: FindingDetail;
		readonly handOff?: { readonly to: HandOffKind; readonly subject: string };
	};
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
		/** The registration the rewrite applies at (`PendingRegistry.site`). */
		readonly source: number;
	}[];
	/** By registration, the level each tree held other than exact was held at
	 *  (`printLevel.ts`), which a stage that prints the slot again prints it at. */
	readonly levels: ReadonlyMap<number, PrintLevel>;
	/** Case properties the app reads and nothing in it writes, which step 1 declared. */
	readonly declaredProperties: readonly {
		readonly caseType: string;
		readonly property: string;
	}[];
	/** What the expressions read of the worker and of places that the document
	 *  does not hold yet: the `field` of every name-backed `session-user` leaf
	 *  a bound tree holds (`sessionUserFields`: those read from the session and
	 *  not the worker's own case), and the slug of every `location_data/<slug>`
	 *  step the texts name, each distinct, in code-unit order. */
	readonly worldReads: {
		readonly userFields: readonly string[];
		readonly sessionUserFields: readonly string[];
		readonly locationDataSlugs: readonly string[];
	};
	/** Tags an expression reads that the catalog does not hold. */
	readonly unreadTables: readonly string[];
	/** Tags a form declares (`jr://fixture/item-list:<tag>`) that the catalog
	 *  does not hold and no expression reads. */
	readonly declaredTables: readonly string[];
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

/** A whole new document with `change` applied, never the one given; deeply
 *  frozen, so the lookups a whole-document pass makes once per form or field
 *  (which menu lists a form) answer from one derivation per document rather
 *  than a scan per call.
 *
 *  A document the reading made is frozen all the way down, and a change
 *  writes slots and the case catalog, never a record's membership, so the new
 *  document is the old one with the change applied and every part it leaves
 *  alone shared: the same values a copy and a fresh hydration give, its
 *  field parents unchanged, and the work only what the change touches.
 *  Anything else is copied and hydrated whole. Exported for its test. */
export function cloned(
	doc: BlueprintDoc,
	change: (draft: BlueprintDoc) => void,
): BlueprintDoc {
	if (doc.refIndex === undefined && isDeeplySettled(doc)) {
		const next = produce(doc, (draft) => {
			change(draft as BlueprintDoc);
		});
		return freeze(next === doc ? { ...doc } : next, true);
	}
	const draft = hydratePersistedBlueprint(toPersistableDoc(doc));
	change(draft);
	return freeze(hydratePersistedBlueprint(toPersistableDoc(draft)), true);
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
		"sortUuid",
		"rowUuid",
		"tabUuid",
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
			sameJson(item.via, ref.member.via)
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
	| { readonly kind: "translation" }
	| { readonly kind: "prose"; readonly part: number };

function sitesOf(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
): readonly (Site | undefined)[] {
	const seen = new Map<string, number>();
	return pending.map((registration) => {
		const ref = registration.ref;
		if (!isProseSlotRef(ref))
			return slotHolder(doc, ref) === undefined ? undefined : { kind: "slot" };
		if (registration.translatedOutput === true) return { kind: "translation" };
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
			if (
				site === undefined ||
				site.kind === "translation" ||
				registration === undefined
			)
				continue;
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
	return segments.at(-1) ?? key;
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
		if (ref.slot === "case_list_sort_expression") {
			const sort = config?.calculatedSorts?.find(
				(rule) => rule.uuid === ref.member.sortUuid,
			);
			return sort?.label ?? "Default order";
		}
		if (
			ref.slot === "case_list_column_expression" ||
			ref.slot === "case_list_mapping_condition"
		) {
			const column = config?.columns.find(
				(candidate) => candidate.uuid === ref.member.columnUuid,
			);
			if (column !== undefined) return column.header;
		} else if ("member" in ref && "searchInputUuid" in ref.member) {
			const uuid = ref.member.searchInputUuid;
			const input = config?.searchInputs.find(
				(candidate) => candidate.uuid === uuid,
			);
			if (input !== undefined) return input.name;
		}
	}
	return claimName(registration.key);
}

type Resolution =
	| {
			readonly kind: "entry";
			readonly entryId: string;
			readonly reason: string;
			readonly name?: string;
			/** The surface key the entry is answered under, where the reader
			 *  that answered it named one. */
			readonly key?: string;
			/** The tag of a table the catalog lacks that the slot reads: the
			 *  claim is handed to project data (`ExpressionClaim.handOff`). */
			readonly table?: string;
	  }
	| { readonly kind: "unrecognized"; readonly reason: string };

const M1 =
	EXPRESSION_CLAIMS["session-data-datum-the-entry-does-not-supply"].entry;
const M2 =
	EXPRESSION_CLAIMS["an-expression-core-cannot-evaluate-as-its-author-meant"]
		.entry;
const M3 = EXPRESSION_CLAIMS["a-form-expression-outside-what-nova-types"].entry;
/** A read of the worker's own record in a menu's or a form's display condition or a case list
 *  slot, the usercase row of each of them. */
const WORKER_RECORD_IN_RECORD_SLOT =
	EXPRESSION_CLAIMS[
		"user-prop-in-module-filter-form-filter-case-list-slots-the"
	].entry;

/** Whether the tree reads the worker's own record (`#user/<p>`). */
function readsWorkerRecord(tree: Expression): boolean {
	let found = false;
	walkExpressionTerms(tree, (term) => {
		if (
			(term.kind === "session-user" || term.kind === "session-user-property") &&
			term.source === "worker-record"
		)
			found = true;
	});
	return found;
}

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
	const refused = slotEntries(ref.slot).refused(doc, ref);
	return refused === "form-default" ? form() : refused;
}

/** What the slot's form declares beside its expressions. */
function declarationsOf(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
): FormDeclarations {
	const form = slotForm(doc, pending.ref);
	return {
		instanceSources: instanceSourcesOf(doc, pending, env) ?? new Map(),
		computedDatums:
			(form === undefined ? undefined : env.computedDatums.get(form)) ??
			new Set(),
		operationIdPaths:
			(form === undefined ? undefined : env.operationIdPaths.get(form)) ??
			new Map(),
	};
}

function refusalOf(
	cause: SlotRefusal,
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
): Resolution {
	if (cause.kind === "lookup-name")
		return {
			kind: "entry",
			entryId: cause.entryId,
			key: cause.key,
			name: cause.name,
			reason: "lookup-name",
		};
	if (cause.kind === "no-case-datum")
		return { kind: "unrecognized", reason: "no-case-datum" };
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
	const declarations = declarationsOf(doc, pending, env);
	// A read of a table the catalog lacks is project data's to judge: the
	// table is one finding however many slots read it.
	const table =
		cause.kind === "parse" && cause.issues[0] !== undefined
			? tableReadTag(cause.issues[0], pending, declarations)
			: undefined;
	if (
		table !== undefined &&
		![...env.lookup.values()].some((one) => one.tag === table)
	)
		return {
			kind: "entry",
			entryId: M2,
			reason: "parse:instance-unknown",
			table,
		};
	const answer = parseIssueEntry(issue, doc, pending, declarations);
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

/** A use whose entry the manifest refuses outranks a slot answer that is no
 *  refusal: a read of a search's answers in a form the parser refuses for a
 *  reason of Nova's own (`unknown-search-input`, the slot's default) is the
 *  read the instance's own class refuses, so the expression is that one line
 *  of the account and not two. */
function withRefusingInstanceUse(
	resolution: Extract<Resolution, { kind: "entry" }>,
	uses: readonly { readonly key: string; readonly entryId: string }[],
): Extract<Resolution, { kind: "entry" }> {
	if (resolution.reason !== "parse:unknown-search-input") return resolution;
	const index = inventoryIndex();
	const refusing = (entryId: string) =>
		index.entry(entryId)?.disposition === "REFUSED";
	if (refusing(resolution.entryId)) return resolution;
	const use = uses.find(
		(one) => one.key.startsWith("instance-scheme:") && refusing(one.entryId),
	);
	return use === undefined
		? resolution
		: { ...resolution, entryId: use.entryId, key: use.key };
}

/**
 * The slot's allowing entry for its own key, where the entry refusing it does not name that key:
 * the slot's row for the tree it bound (or, for a text no tree was bound from, the placeholder a
 * slot of its expectation holds), where that entry names the key and allows it. Undefined where the refusing entry
 * names the slot's key itself, or the slot has no such entry, so the refusal stands at the key.
 */
function allowingEntryBeside(
	doc: BlueprintDoc,
	registration: PendingExpression,
	refusingEntryId: string,
	candidate: Expression | undefined,
	expectation: "condition" | "value",
): string | undefined {
	const index = inventoryIndex();
	const refusing = index.entry(refusingEntryId);
	if (refusing === undefined || refusing.surfaceKeys.includes(registration.key))
		return undefined;
	const tree = candidate ?? pendingPlaceholder(expectation);
	const held = slotEntries(registration.ref.slot).held(
		doc,
		registration.ref,
		tree,
	);
	const entry = held === undefined ? undefined : index.entry(held);
	if (
		entry === undefined ||
		!entry.surfaceKeys.includes(registration.key) ||
		!(
			entry.standing === "held" ||
			entry.standing === "kept" ||
			entry.standing === "inert"
		)
	)
		return undefined;
	return entry.id;
}

/** The refusal of `candidate`, the slot's tree, which the document the slots
 *  are judged against leaves out where the checker refuses it. */
function checkRefusal(
	error: CheckError,
	doc: BlueprintDoc,
	pending: PendingExpression,
	candidate: Expression,
): Resolution {
	const answer = checkErrorEntry(error, doc, pending, candidate);
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

/** The slots `readExpressionsSteps` binds or judges between two stops. */
const SLOTS_PER_STEP = 400;

/** A slot's context in a document, by the document and the slot's reference: `slotContext` is a
 *  function of the two (and the lookup types, one for a reading of the expressions), and a stage
 *  asks it of each registration several times over the same document. */
type SlotContextOf = (
	doc: BlueprintDoc,
	ref: SlotContextRef,
) => ExpressionContext | undefined;

function slotContexts(types: ReturnType<typeof lookupTypes>): SlotContextOf {
	const byDoc = new WeakMap<
		BlueprintDoc,
		Map<SlotContextRef, ExpressionContext | undefined>
	>();
	return (doc, ref) => {
		let known = byDoc.get(doc);
		if (known === undefined) {
			known = new Map();
			byDoc.set(doc, known);
		}
		if (known.has(ref)) return known.get(ref);
		const context = slotContext(doc, ref, types);
		known.set(ref, context);
		return context;
	};
}

export function readExpressions(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
	env: ExpressionReadEnv,
): ExpressionReading {
	const steps = readExpressionsSteps(doc, pending, env);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

/**
 * `readExpressions` a part at a time: it stops between its scan, its typing,
 * each pass of binding and judging, its leveling and its checks, and every
 * `SLOTS_PER_STEP` slots inside each of those, until it is resumed, so the
 * expression stage of an app at the bring-in byte cap is no one long piece
 * of a request.
 */
export function* readExpressionsSteps(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
	env: ExpressionReadEnv,
): Generator<void, ExpressionReading, void> {
	const types = lookupTypes(env);
	const contextOf = slotContexts(types);
	// A registration that only claims its uses binds nothing (`PendingExpression.usesOnly`).
	const live = pending.map(
		(registration) =>
			registration.usesOnly !== true &&
			contextOf(doc, registration.ref) !== undefined,
	);
	const sites = sitesOf(doc, pending);

	// 1. Scan, and declare the case properties binding will find.
	const scanned = scanReads(
		pending.filter((registration) => registration.usesOnly !== true),
		doc,
		env,
	);
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
			noteProperty(catalog, read.caseType, read.property, env.knownCaseTypes);
	});
	yield;
	// 1b. Type: a property the catalog holds untyped that a record slot
	// compares with a value of a known type is of that type.
	const base = withComparedTypes(
		scannedBase,
		pending,
		live,
		sites,
		env,
		contextOf,
	);
	yield;
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
	// Every tree bound or held so far, by registration.
	const boundTrees = (): Map<number, Expression> =>
		new Map([
			...[...bindings].map(
				([index, bound]) => [index, bound.candidate] as const,
			),
			...settled,
		]);
	// The trees the checker refuses over the document the slots are printed
	// over. A refused tree is one finding, its slot's (step 5), and is left out
	// of that document: written in, it is a tree the emitter refuses, and every
	// other slot printed over the document (a Save to Case block's others,
	// printed through the form's case wire) would fail to print beside it. The
	// check of step 5 is still made over the document that holds every tree, so
	// one refusal does not change the type another slot is checked under.
	const refusedTrees = new WeakSet<Expression>();
	const treesOf = (): Map<number, Expression> =>
		new Map([...boundTrees()].filter(([, tree]) => !refusedTrees.has(tree)));
	/** The document holding every tree the checker admits over it: each
	 *  tree is checked over the document written so far, and a refused one
	 *  is left out, until none more is. */
	const writtenAdmitted = (): BlueprintDoc => {
		for (;;) {
			const trees = treesOf();
			const doc = written(base, pending, sites, trees);
			let more = false;
			for (const [index, tree] of trees) {
				const context = contextOf(
					doc,
					(pending[index] as PendingExpression).ref,
				);
				if (
					context !== undefined &&
					refusals(checkExpression(tree, context).errors).length > 0
				) {
					refusedTrees.add(tree);
					more = true;
				}
			}
			if (!more) return doc;
		}
	};
	let current = base;
	let judgments = new Map<number, SlotJudgment>();
	let rounds = 0;
	let outcomes = new Map<number, Outcome>();
	let rewrites: ExpressionReading["rewrites"][number][] = [];
	let leveled = new Map<number, Expression>();
	let levels = new Map<number, PrintLevel>();
	for (;;) {
		const start =
			settled.size === 0
				? base
				: written(
						base,
						pending,
						sites,
						new Map([...settled].filter(([, tree]) => !refusedTrees.has(tree))),
					);
		// A leveled slot keeps the sites it withdrew; every other slot is
		// offered its folds again over the leveled document.
		withdrawn.forEach((taken, index) => {
			if (!settled.has(index)) taken.clear();
		});
		// A Details tab's records are the rows its fields read, so each field's
		// scope comes from the tab's bound collection: the collections bind
		// first, and every other slot binds over the document holding them.
		const supplies = (index: number) =>
			(pending[index] as PendingExpression).ref.slot === "case_detail_tab_rows";
		let bound = 0;
		for (const index of bindable.filter(supplies)) {
			if (bound > 0 && bound % SLOTS_PER_STEP === 0) yield;
			bound += 1;
			bindAt(start, index);
		}
		const supplied = new Map(
			bindable.filter(supplies).flatMap((index) => {
				const tree = bindings.get(index)?.candidate;
				return tree === undefined ? [] : [[index, tree] as const];
			}),
		);
		const scoped =
			supplied.size === 0 ? start : written(start, pending, sites, supplied);
		for (const index of bindable) {
			if (supplies(index)) continue;
			if (bound > 0 && bound % SLOTS_PER_STEP === 0) yield;
			bound += 1;
			bindAt(scoped, index);
		}
		yield;
		current = writtenAdmitted();
		for (;;) {
			yield;
			rounds++;
			judgments = new Map();
			for (const [index, bound] of bindings) {
				if (judgments.size > 0 && judgments.size % SLOTS_PER_STEP === 0) yield;
				judgments.set(
					index,
					judgeSlot(current, pending[index] as PendingExpression, env, bound),
				);
			}
			yield;
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
			current = writtenAdmitted();
		}

		yield;
		// 4. Level: a slot still unequal is compared with the print that leaves
		// every rewrite out, then with prints that leave out the rewrite at some
		// of its sites (`siteLevel`), and held at the level whose print is the
		// source, as the tree Nova's own print reads back as.
		outcomes = new Map<number, Outcome>();
		rewrites = [];
		leveled = new Map<number, Expression>();
		levels = new Map<number, PrintLevel>();
		let leveling = 0;
		for (const [index, judgment] of judgments) {
			if (leveling > 0 && leveling % SLOTS_PER_STEP === 0) yield;
			leveling += 1;
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
			const found =
				withheld.kind === "bound" && withheld.equal
					? { level: { kind: "withheld" } as const, withheld: reached }
					: siteLevel(current, registration, env, bound);
			if (found !== undefined) {
				// The slot stores what Nova's own print reads back as, at the
				// level found for the bound candidate (`readBack`).
				const tree = readBack(current, registration, env, bound.candidate);
				leveled.set(index, tree);
				levels.set(index, found.level);
				outcomes.set(index, { kind: "held", tree });
				for (const id of EMISSION_REWRITE_IDS)
					if (
						found.withheld.has(id) &&
						EMISSION_REWRITES[id].behavior === "changes"
					)
						rewrites.push({
							id,
							place: registration.place,
							key: registration.key,
							source: index,
						});
				continue;
			}
			const relation =
				contextOf(current, registration.ref)?.ruleSet === "record"
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
			if (bound.listedCaseInQuery) {
				// The listed case read inside another query of cases, which no
				// tree Nova holds reads: the slot's own refusal.
				outcomes.set(index, {
					kind: "refused",
					resolution: {
						kind: "entry",
						entryId: slotDefault(current, registration.ref, () => M3),
						reason: "listed-case-in-query",
					},
				});
				continue;
			}
			if (reached.size > 0) {
				// The print reaches rewrites and no choice of where to apply them the search finds
				// prints the source: a spelling Nova does not hold yet, under the slot's own entry.
				outcomes.set(index, {
					kind: "refused",
					resolution: {
						kind: "entry",
						entryId: slotDefault(current, registration.ref, () => M3),
						reason: `rewrites:${[...reached].sort().join(",")}`,
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
					!sameJson(tree, settled.get(index) ?? bindings.get(index)?.candidate),
			);
		if (!again || rounds >= EXPRESSION_ROUND_LIMIT) break;
		settled = leveled;
	}
	yield;
	const circumstances: ExpressionReading["circumstances"][number][] = [];
	const checked = written(
		base,
		pending,
		sites,
		new Map([...boundTrees(), ...leveled]),
	);

	yield;
	// 5. Check every held slot over the document that holds every bound
	// candidate; 6. hand every held record slot to the dialect's judge.
	let checking = 0;
	for (const [index, judgment] of judgments) {
		if (checking > 0 && checking % SLOTS_PER_STEP === 0) yield;
		checking += 1;
		const registration = pending[index] as PendingExpression;
		const outcome = outcomes.get(index);
		const candidate =
			outcome?.kind === "held"
				? outcome.tree
				: judgment.kind === "unprintable"
					? judgment.candidate
					: undefined;
		if (candidate === undefined) continue;
		const context = contextOf(checked, registration.ref);
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
				resolution: checkRefusal(first, checked, registration, candidate),
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

	yield;
	// 7. Report.
	const bound: (Expression | undefined)[] = pending.map(() => undefined);
	const claims: ExpressionClaim[] = [];
	const ownerless: number[] = [];
	const held = new Map<number, Expression>();
	/* The slot a text registered for its uses alone is read in, and what classes its uses, by
	 * the registration's slot: every attribute of a form registers under one. */
	const readIn = new Map<
		SlotContextRef,
		| {
				readonly context: ExpressionContext;
				readonly facts: SurfaceUseFacts;
		  }
		| undefined
	>();
	pending.forEach((registration, index) => {
		if (registration.usesOnly === true) {
			// Each use the text makes, at the node it was read from; the node itself is its
			// registrar's claim.
			let slot = readIn.get(registration.ref);
			if (!readIn.has(registration.ref)) {
				const context = contextOf(checked, registration.ref);
				slot =
					context === undefined
						? undefined
						: {
								context,
								facts: surfaceUseFactsOf(
									checked,
									registration,
									env,
									undefined,
									{
										kind: "ownerless",
									},
								),
							};
				readIn.set(registration.ref, slot);
			}
			if (slot === undefined) return;
			const name = registrationName(checked, registration);
			for (const use of registrationUses(
				registration,
				sharedSyntax(registration.text),
				undefined,
				slot.context,
				slot.facts,
			))
				claims.push({
					source: index,
					entryId: use.entryId,
					place: registration.place,
					key: use.key,
					detail: { name },
				});
			return;
		}
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
		const context = contextOf(checked, registration.ref);
		const facts =
			context === undefined
				? undefined
				: surfaceUseFactsOf(
						checked,
						registration,
						env,
						refused.get(index),
						outcome,
					);
		const uses =
			context === undefined || facts === undefined
				? []
				: registrationUses(
						registration,
						source,
						outcome.kind === "held" ? outcome.tree : undefined,
						context,
						facts,
					);
		// The keys this registration's claims hold: one claim per key at a node.
		const claimed = new Set<string>();
		if (outcome.kind === "held") {
			bound[index] = outcome.tree;
			held.set(index, outcome.tree);
			const workerProperty =
				[
					"form_display_condition",
					"module_display_condition",
					"case_list_filter",
					"case_list_column_expression",
				].includes(registration.ref.slot) && readsWorkerRecord(outcome.tree);
			const entryId = workerProperty
				? WORKER_RECORD_IN_RECORD_SLOT
				: slotEntries(registration.ref.slot).held(
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
		} else if (
			outcome.resolution.kind === "unrecognized" ||
			outcome.resolution.entryId === "unrecognized"
		)
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
			const resolution = withRefusingInstanceUse(outcome.resolution, uses);
			// The slot's own claim is under the registration's key, which the
			// frame finds it by; where the entry is registered under the key of
			// a use the text makes (an operator, a function, an instance
			// scheme), the claim is recorded under that key too, and stands for
			// that use.
			const entryKey =
				resolution.key ??
				claimKeyOfUse(
					resolution.entryId,
					uses.map((use) => use.key),
				);
			claimed.add(registration.key);
			const handOff =
				resolution.table === undefined
					? undefined
					: {
							to: "lookup-table-read" as const,
							subject: resolution.table,
						};
			// A refusing entry that names no surface key at all (`noSurfaceKey`) names neither the
			// slot's key nor a use's: its record names none (`Accounting.claimEntry`). A hand-off
			// records no claim, so it stands alone.
			const keyless =
				handOff === undefined &&
				inventoryIndex().entry(resolution.entryId)?.surfaceKeys.length === 0;
			const apart =
				!keyless && (entryKey === undefined || entryKey === registration.key)
					? undefined
					: allowingEntryBeside(
							checked,
							registration,
							resolution.entryId,
							bindings.get(index)?.candidate,
							context?.profile.expectation.kind === "condition"
								? "condition"
								: "value",
						);
			if (apart !== undefined && (entryKey !== undefined || keyless)) {
				// The refusing entry names the use's key, or no key, and not the slot's: the slot's
				// node stands under the slot's allowing entry, and the refusal beside it.
				const refusalKey = entryKey ?? registration.key;
				claimed.add(refusalKey);
				claims.push({
					source: index,
					entryId: apart,
					place: registration.place,
					key: registration.key,
					detail: { name },
					refusal: {
						entryId: resolution.entryId,
						key: refusalKey,
						detail: {
							name: resolution.name ?? name,
							reason: resolution.reason,
						},
						...(handOff !== undefined && { handOff }),
					},
				});
			} else {
				claims.push({
					source: index,
					entryId: resolution.entryId,
					place: registration.place,
					key: registration.key,
					detail: { name: resolution.name ?? name, reason: resolution.reason },
					...(handOff !== undefined && { handOff }),
				});
			}
			if (
				apart === undefined &&
				entryKey !== undefined &&
				entryKey !== registration.key
			) {
				claimed.add(entryKey);
				claims.push({
					source: index,
					entryId: resolution.entryId,
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
	const userFields = new Set<string>();
	const sessionUserFields = new Set<string>();
	for (const binding of bindings.values())
		walkExpressionTerms(binding.candidate, (term) => {
			// A field CommCare HQ writes on every worker's own case
			// (`callcenter/sync_usercase.py::_get_user_case_fields`) is no
			// worker property: the read stays the name-backed leaf.
			if (
				term.kind === "session-user" &&
				!(
					term.source === "worker-record" &&
					USERCASE_BUILT_IN_KEYS.includes(term.field)
				)
			) {
				userFields.add(term.field);
				if (term.source !== "worker-record") sessionUserFields.add(term.field);
			}
		});
	// A relation read names the type it walks from; the property it reads is
	// the type's the relation reaches.
	const reads = new Set<string>();
	for (const tree of held.values())
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
		levels,
		declaredProperties: kept,
		worldReads: {
			userFields: [...userFields].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
			sessionUserFields: [...sessionUserFields].sort((a, b) =>
				a < b ? -1 : a > b ? 1 : 0,
			),
			locationDataSlugs: scanned.locationDataSlugs,
		},
		unreadTables: scanned.lookupTags.filter(
			(tag) => ![...env.lookup.values()].some((table) => table.tag === tag),
		),
		declaredTables: scanned.declaredLookupTags.filter(
			(tag) => ![...env.lookup.values()].some((table) => table.tag === tag),
		),
		ownerless: ownerless.sort((a, b) => a - b),
		rounds,
	};
}

/** `doc` with each property its catalog holds untyped typed as the record
 *  slots compare it (`comparedTypes`): every registration bound with every
 *  fold on. A search filter row is no registration: the search reader types
 *  what its rows compare (`search/rows.ts`). */
function withComparedTypes(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
	live: readonly boolean[],
	sites: readonly (Site | undefined)[],
	env: ExpressionReadEnv,
	contextOf: SlotContextOf,
): BlueprintDoc {
	const effective = effectiveCaseTypes(doc);
	const untyped = (caseType: string, property: string): boolean => {
		const declared = (doc.caseTypes ?? [])
			.find((type) => type.name === caseType)
			?.properties.find((one) => one.name === property);
		const typed = effective
			.find((type) => type.name === caseType)
			?.properties.find((one) => one.name === property)?.data_type;
		return (
			declared !== undefined &&
			(typed === undefined ||
				(env.dateRangeGuesses?.has(guessKey(caseType, property)) === true &&
					declared.data_type === typed))
		);
	};
	const found: ComparedType[] = [];
	const required: { readonly one: RequiredType; readonly index: number }[] = [];
	pending.forEach((registration, index) => {
		if (!live[index]) return;
		const context = contextOf(doc, registration.ref);
		if (context?.ruleSet !== "record") return;
		if (sites[index] === undefined) return;
		const bound = bindSlot(doc, registration, env, new Set());
		if (bound.kind !== "bound") return;
		found.push(...comparedTypes(bound.bound.candidate, context, untyped));
		// A list that orders by a calculated column as a number tells the
		// number's type: the column's value takes it, and a number position
		// in it tries it first.
		const ref = registration.ref;
		const sorted =
			ref.entity === "module" && ref.slot === "case_list_column_expression"
				? env.numericSortColumns?.get(ref.member.columnUuid)
				: undefined;
		const sortedType = sorted === "int" ? "int" : "decimal";
		if (sorted !== undefined)
			for (const one of valueProperties(
				bound.bound.candidate,
				[sortedType],
				untyped,
			))
				required.push({ one: { ...one, told: true }, index });
		for (const one of requiredTypes(bound.bound.candidate, context, untyped))
			required.push({
				one:
					sorted !== undefined && one.candidates.includes(sortedType)
						? {
								...one,
								candidates: [
									sortedType,
									...one.candidates.filter((type) => type !== sortedType),
								],
								told: true,
							}
						: one,
				index,
			});
		// Two properties the catalog holds untyped, compared, each side itself
		// or through a value-giving branch, print as written; as dates and
		// times a device compares them as moments. Where only that print is the
		// source's, they are dates and times.
		const pairs = untypedPairs(bound.bound.candidate, untyped, false, true);
		if (pairs.length === 0) return;
		// Two such properties ordered against each other print bare as dates
		// and as numbers alike: either is a type that orders, tried after
		// every other reading of them.
		const ordered = untypedPairs(bound.bound.candidate, untyped, true);
		for (let at = 0; at + 1 < ordered.length; at += 2) {
			const left = ordered[at] as { caseType: string; property: string };
			const right = ordered[at + 1] as { caseType: string; property: string };
			required.push(
				{
					one: { ...left, candidates: ["date", "decimal"], partners: [right] },
					index,
				},
				{
					one: { ...right, candidates: ["date", "decimal"], partners: [left] },
					index,
				},
			);
		}
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
	const agreed = agreedComparedTypes(found);
	const compared = withTypes(doc, agreed);
	const typedByComparison = new Set(
		agreed.map((one) => JSON.stringify([one.caseType, one.property])),
	);
	return withRequiredTypes(
		compared,
		pending,
		required,
		env,
		(caseType, property) =>
			untyped(caseType, property) &&
			!typedByComparison.has(JSON.stringify([caseType, property])),
	);
}

/**
 * `doc` with each property a signature position reads and no comparison typed
 * (`requiredTypes`) typed as the first type that position admits under which
 * every slot reading it binds to a tree its checker admits and prints the
 * source's text, with the properties the position orders it against, which
 * take the same type in the same try. Where no type holds while the slots'
 * other untyped properties stay text (a `date-add` of two of them, whose
 * checker admits neither alone), the try is made again with each of those
 * at the first type its own position admits, and only the property tried is
 * typed. A property no such type holds stays as it was, for the slot's own
 * finding.
 */
function withRequiredTypes(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
	required: readonly { readonly one: RequiredType; readonly index: number }[],
	env: ExpressionReadEnv,
	untyped: (caseType: string, property: string) => boolean,
): BlueprintDoc {
	const types = lookupTypes(env);
	const byProperty = new Map<
		string,
		{
			one: RequiredType;
			readonly entries: RequiredType[];
			readonly slots: Set<number>;
			readonly partners: Map<string, { caseType: string; property: string }>;
		}
	>();
	for (const { one, index } of required) {
		const key = JSON.stringify([one.caseType, one.property]);
		const entry = byProperty.get(key) ?? {
			one,
			entries: [] as RequiredType[],
			slots: new Set<number>(),
			partners: new Map(),
		};
		entry.entries.push(one);
		entry.slots.add(index);
		for (const partner of one.partners ?? [])
			entry.partners.set(
				JSON.stringify([partner.caseType, partner.property]),
				partner,
			);
		byProperty.set(key, entry);
	}
	// Each property's candidates, in the order every position reading it
	// decides together.
	for (const entry of byProperty.values())
		entry.one = { ...entry.one, candidates: mergedCandidates(entry.entries) };
	let current = doc;
	const typed = new Set<string>();
	const open = (caseType: string, property: string) =>
		untyped(caseType, property) &&
		!typed.has(JSON.stringify([caseType, property]));
	for (const { one, slots, partners } of byProperty.values()) {
		if (!open(one.caseType, one.property)) continue;
		// A partner the reading has not typed yet takes the same type in the
		// same try: an ordering of two untyped properties admits neither alone.
		const along = [...partners.values()].filter((partner) =>
			open(partner.caseType, partner.property),
		);
		const judged = new Set(slots);
		for (const partner of along)
			for (const index of byProperty.get(
				JSON.stringify([partner.caseType, partner.property]),
			)?.slots ?? [])
				judged.add(index);
		// The other open properties the judged slots require, each at the first
		// type its own position admits.
		const beside = [...byProperty.values()]
			.filter(
				(other) =>
					other.one !== one &&
					!along.some(
						(partner) =>
							partner.caseType === other.one.caseType &&
							partner.property === other.one.property,
					) &&
					open(other.one.caseType, other.one.property) &&
					[...other.slots].some((index) => judged.has(index)),
			)
			.flatMap((other) => {
				const [first] = other.one.candidates;
				return first === undefined ? [] : [{ ...other.one, dataType: first }];
			});
		const tries = one.candidates.flatMap((dataType) => {
			const own = [
				{ ...one, dataType },
				...along.map((partner) => ({ ...partner, dataType })),
			];
			return [own, ...(beside.length === 0 ? [] : [[...own, ...beside]])];
		});
		for (const trial of tries) {
			const next = withTypes(current, trial);
			const holds = [...judged].every((index) => {
				const registration = pending[index] as PendingExpression;
				const context = slotContext(next, registration.ref, types);
				const bound = bindSlot(next, registration, env, new Set());
				if (context === undefined || bound.kind !== "bound") return false;
				if (
					refusals(checkExpression(bound.bound.candidate, context).errors)
						.length > 0
				)
					return false;
				const judgment = judgeSlot(next, registration, env, bound.bound);
				return judgment.kind === "bound" && judgment.equal;
			});
			if (holds) {
				const kept = trial.slice(0, 1 + along.length);
				current = withTypes(current, kept);
				for (const done of kept)
					typed.add(JSON.stringify([done.caseType, done.property]));
				break;
			}
		}
	}
	return current;
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
 *  catalog holds untyped, or, `throughBranches`, give only such properties,
 *  each itself or through a value-giving branch. */
function untypedPairs(
	tree: Expression,
	untyped: (caseType: string, property: string) => boolean,
	orderingOnly = false,
	throughBranches = false,
): { caseType: string; property: string }[] {
	const out: { caseType: string; property: string }[] = [];
	// A property of the row, or of the case a menu above chose.
	const property = (side: Expression) => {
		const term =
			side.kind === "term"
				? side.term
				: side.kind === "project" && readChosenCaseProperty(side) !== undefined
					? side.value
					: undefined;
		return term?.kind === "prop" &&
			term.caseType !== undefined &&
			(term.via === undefined || term.via.kind === "self") &&
			untyped(term.caseType, term.property)
			? { caseType: term.caseType, property: term.property }
			: undefined;
	};
	const visit = (node: Expression): void => {
		if (
			(!orderingOnly && (node.kind === "eq" || node.kind === "neq")) ||
			node.kind === "gt" ||
			node.kind === "gte" ||
			node.kind === "lt" ||
			node.kind === "lte"
		) {
			if (throughBranches) {
				const lefts = untypedOutputProperties(node.left, untyped);
				const rights = untypedOutputProperties(node.right, untyped);
				if (lefts !== undefined && rights !== undefined)
					out.push(...lefts, ...rights);
				return;
			}
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
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
}

/** `text`'s syntax as every read of it shares it, for a walk that keeps no node. */
function sharedSyntax(text: string): FormSyntax | undefined {
	try {
		const read = sharedFormSyntax(text);
		return read.ok ? read.node : undefined;
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
}

/**
 * The uses a registration's text makes at the node its claims are recorded at: its syntax's, and
 * in a slot HQ interpolates the shorthand of the text HQ interpolates there
 * (`PendingExpression.slotText`, else the registration's own text). Where that text is more than
 * the registration's and holds a hashtag, Core's lexer refuses the whole slot, so its uses are its
 * shorthand alone; where the node is no slot HQ interpolates, the text's shorthand is no use.
 */
function registrationUses(
	registration: PendingExpression,
	source: FormSyntax | undefined,
	candidate: Expression | undefined,
	context: ExpressionContext,
	slotFacts: SurfaceUseFacts,
): readonly SurfaceUse[] {
	const whole = registration.slotText;
	const facts =
		whole === null && slotFacts.shorthand
			? { ...slotFacts, shorthand: false }
			: slotFacts;
	const text = whole ?? registration.text;
	if (facts.shorthand && text !== registration.text) {
		const wholeSource = textSyntax(text);
		if (
			wholeSource !== undefined &&
			syntaxHoldsHashtag(wholeSource, context, facts)
		)
			return unreadSlotUses(text, facts);
	}
	return source === undefined
		? unreadSlotUses(text, facts)
		: expressionSurfaceUses(source, candidate, context, "xpath", facts, text);
}

/** A registration's text as the one grammar reads it, before HQ's
 *  interpolation: an XForm attribute, an HQ JSON value with its hashtags. */
function textSyntax(text: string): FormSyntax | undefined {
	try {
		const read = readFormSyntax(text);
		return read.ok ? read.node : undefined;
	} catch (error) {
		rethrowWorkStop(error);
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
		instanceSources: instanceSourcesOf(doc, registration, env) ?? new Map(),
		formInstancesOnly: instanceSourcesOf(doc, registration, env) !== undefined,
		shorthand:
			registration.mode.target === "hq-json" &&
			registration.mode.interpolation !== "none" &&
			registration.mode.interpolation !== "enum-key",
		fixtureValue: registration.fixtureValue === true,
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
	/* The instances each form's held slots read, gathered once for every
	 * form rather than found again per form. */
	const readByForm = new Map<string, Set<string>>();
	pending.forEach((registration, index) => {
		if (!held.has(index) || registration.mode.target !== "xform") return;
		const form = slotForm(doc, registration.ref);
		if (form === undefined) return;
		const read = readByForm.get(form) ?? new Set<string>();
		readByForm.set(form, read);
		for (const id of instanceIdsRead(registration.text)) read.add(id);
	});
	for (const [form, sources] of env.instanceSources) {
		const place = env.formPlaces.get(form);
		if (place === undefined) continue;
		const read = readByForm.get(form) ?? new Set<string>();
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

/**
 * The site level of a slot that neither whole level prints: the sites of its
 * print, in the order the print reaches them, whose rewrite is withheld, so
 * that the print is the source; undefined where the search finds none.
 * A source can spell a rewrite at some sites and not at others (a Search test
 * that reads one answer inside Nova's guard on its rows and another bare).
 * Starting from every rewrite applied, each step flips a site whose flip moves
 * the first difference with the source on, trying first the sites the print
 * reaches after the one flipped last. A site's flip
 * changes the print only where the site prints, so a flip moves the difference
 * on only where the site prints at it, and the sites before it already print
 * the source. Each step moves the difference strictly on through the source's
 * text, so the search ends, whatever the number of sites. Where no single flip
 * moves it (two rewrites that print at one node, one inside the other's
 * spelling, each spelled otherwise than the source) the search finds no level,
 * and the slot is refused under its own entry (`readExpressions`, step 4).
 * `withheld` names the rewrites withheld at some site, the ones a worker meets
 * once Nova prints the slot.
 */
function siteLevel(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
	bound: BoundSlot,
):
	| {
			readonly level: PrintLevel;
			readonly withheld: ReadonlySet<EmissionRewriteId>;
	  }
	| undefined {
	const judge = (sites: ReadonlySet<number>) => {
		const level: PrintLevel = { kind: "sites", withheld: sites };
		const withheld = new Set<EmissionRewriteId>();
		let reached = 0;
		const judgment = judgeSlot(
			doc,
			pending,
			env,
			bound,
			levelControl(level, (id, out) => {
				reached += 1;
				if (out) withheld.add(id);
			}),
		);
		return judgment.kind === "bound"
			? { level, withheld, reached, judgment }
			: undefined;
	};
	type Judged = NonNullable<ReturnType<typeof judge>>;
	const flipped = (from: Judged, sites: readonly number[]) => {
		const withheld = new Set(
			from.level.kind === "sites" ? from.level.withheld : [],
		);
		for (const site of sites) if (!withheld.delete(site)) withheld.add(site);
		return judge(withheld);
	};
	let now = judge(new Set());
	// The site after the last one flipped: the difference moves on through the source as the
	// print reaches the sites, so the next site to flip is most often the next one reached.
	let next = 0;
	while (now !== undefined) {
		const from = now.judgment.difference?.from;
		if (now.judgment.equal || from === undefined) return undefined;
		const current = now;
		let best: Judged | undefined;
		const order = Array.from(
			{ length: current.reached },
			(_, at) => (next + at) % current.reached,
		);
		for (const site of order) {
			const tried = flipped(current, [site]);
			if (tried === undefined) continue;
			if (tried.judgment.equal) return tried;
			const at = tried.judgment.difference?.from;
			if (at !== undefined && at > from) {
				best = tried;
				next = site + 1;
				break;
			}
		}
		now = best;
	}
	return undefined;
}

/** The tree a slot's unwithheld print `P` reads back as: the tree acceptance's
 *  re-read of Nova's emission gives, which a held slot at the second level
 *  stores so the document equals its own re-read. The re-read is a reading of
 *  `P` like any other: every fold is a proposal, so a binding of `P` is judged
 *  against `P` and a fold site whose print differs is withdrawn, as the first
 *  level withdraws one from the source, until the binding prints `P` exactly.
 *  Where none does, the slot keeps `candidate`, which prints `P` by
 *  construction: a tree that prints something else is never stored.
 *  The slot keeps the level found for `candidate` (`readExpressions`, step
 *  4). Where the re-read is another tree, it either prints the source at that
 *  level too (a form read whose `absolute` spelling Nova prints anyway), or
 *  holds Nova's own spelling where the source spells another that no withheld
 *  rewrite prints from it: a read of its repeat's own answer spelled from
 *  `current()` (`row-predicate-current`, `default-reads-current`), a case list
 *  filter without the identities Nova drops (`filter-identities-dropped`). No
 *  level prints the source from that tree, so none is searched for it. A site
 *  level counts the candidate's sites, and a read relocated to `current()` is
 *  a site the stored tree no longer reaches; that read is a form's, inside a
 *  repeat, and no settle prints such a slot again (`printLevel.ts`). */
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
			bindCalculationText: true,
			...(form !== undefined && names !== undefined
				? { projection: sourceNodeProjection(doc, form, names) }
				: {}),
		});
	} catch (error) {
		rethrowWorkStop(error);
		return candidate;
	}
	if (!readFormSyntax(text).ok) return candidate;
	const print: PendingExpression = { ...pending, text };
	// This second read is of Nova’s own print. Its form declares Nova’s
	// local IDs, even when the adopted source used an entirely different alias.
	let printEnv = env;
	if (form !== undefined && pending.mode.target === "xform") {
		const declarations = new Map<string, string>();
		walkExpression(candidate, {
			visitExpression(node) {
				if (node.kind === "table-rows" || node.kind === "table-lookup") {
					const table = env.lookup.get(node.tableId);
					if (table !== undefined)
						declarations.set(
							lookupXformInstanceId(table.tag),
							lookupFixtureSrc(lookupFixtureId(table.tag)),
						);
				}
			},
		});
		printEnv = {
			...env,
			formReadSources: new Map([
				[form, instanceSourcesAfterScan(declarations, { xmlValue: text })],
			]),
		};
	}
	const withdrawn = new Set<string>();
	// Each turn withdraws a site not withdrawn before, and a binding uses
	// finitely many, so the loop ends.
	for (;;) {
		const again = bindSlot(doc, print, printEnv, withdrawn);
		if (again.kind === "refused") return candidate;
		const judged = judgeSlot(doc, print, printEnv, again.bound);
		if (judged.kind !== "bound") return candidate;
		if (judged.equal) return judged.candidate;
		if (judged.withdraw === undefined || withdrawn.has(judged.withdraw))
			return candidate;
		withdrawn.add(judged.withdraw);
	}
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
