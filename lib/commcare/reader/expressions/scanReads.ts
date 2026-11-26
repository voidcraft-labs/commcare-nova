/**
 * What an app's expressions read, from their syntax alone, before any of
 * them is bound: the case properties whose case type the syntax fixes, the
 * place properties they name and the lookup tables they read. The scan reads
 * each registration's text once, after HQ's interpolation, through the one
 * grammar, and mints nothing.
 */
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { AUTHORED_CASE_PROPERTY_NAME_PATTERN } from "@/lib/domain/casePropertyName";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { activeRowScope, slotContext } from "@/lib/domain/expression/context";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import type { Uuid } from "@/lib/domain/uuid";
import { caseTypeHopMap } from "../../caseTypeDepths";
import {
	entryDatumIds,
	formLinkProjectionContext,
} from "../../formLinkProjection";
import { rethrowWorkStop } from "../../workMeter";
import { type FormSyntax, literalInstanceId } from "../../xpath/formSyntax";
import { instanceForRead } from "../../xpath/instanceSources";
import { sameJson } from "../jsonCursor";
import type { PendingExpression } from "../pendingExpressions";
import { readFormSyntax } from "../syntaxRead";
import { type CsqlRun, csqlPropertyName, searchRowCsql } from "./csqlRead";
import {
	ancestorWalk,
	casedbRow,
	caseIdKey,
	caseTypeTest,
	clauses,
	core,
	flat,
	instanceId,
	joinedClauses,
	ownCaseWalk,
	presenceShape,
	rowProperty,
	siblingCaseRow,
} from "./folds";
import type { ExpressionReadEnv } from "./index";
import { nativeInstancePaths } from "./nativeInstancePaths";
import {
	instanceSourcesOf,
	lookupTypes,
	preparedSource,
	slotForm,
} from "./readExpression";

export interface ScannedReads {
	readonly caseProperties: readonly {
		readonly caseType: string;
		readonly property: string;
	}[];
	readonly locationDataSlugs: readonly string[];
	/** The tags of the tables the expressions read: by an `item-list:<tag>`
	 *  id, or by an id a form declares from `jr://fixture/item-list:<tag>`. */
	readonly lookupTags: readonly string[];
	/** The tags of the tables a form declares from
	 *  `jr://fixture/item-list:<tag>` that no expression of that form reads and
	 *  no expression reads by its `item-list:<tag>` id. */
	readonly declaredLookupTags: readonly string[];
	/** Each case type an ancestor walk reaches through `index/parent` from a
	 *  case type the syntax fixes, by the type test the walk's hop writes. */
	readonly parentLinks: readonly {
		readonly child: string;
		readonly parent: string;
	}[];
}

const TABLE_SOURCE = "jr://fixture/item-list:";
/** The CSQL functions whose arguments name another case's relation or
 *  properties, which are no property of the searched case. */
const CSQL_RELATION_FUNCTIONS: ReadonlySet<string> = new Set([
	"ancestor-exists",
	"subcase-exists",
	"subcase-count",
]);

/** Every node of a syntax tree, in document order. */
function nodesOf(root: FormSyntax, includePredicates = true): FormSyntax[] {
	const found: FormSyntax[] = [];
	const visit = (node: FormSyntax): void => {
		found.push(node);
		switch (node.kind) {
			case "group":
			case "negative":
			case "axis":
				visit(node.value);
				return;
			case "child":
				if (node.left !== undefined) visit(node.left);
				visit(node.step);
				return;
			case "filter":
				visit(node.base);
				if (includePredicates) visit(node.where);
				return;
			case "binary":
				visit(node.left);
				visit(node.right);
				return;
			case "call":
				for (const arg of node.args) visit(arg);
				return;
			default:
				return;
		}
	};
	visit(root);
	return found;
}

/** The nodes that are part of a longer path: a path's left side and step, a
 *  predicate's base, an axis's test. Only the whole path is a read. */
function partsOfPaths(nodes: readonly FormSyntax[]): Set<FormSyntax> {
	const parts = new Set<FormSyntax>();
	for (const node of nodes) {
		const at = core(node);
		if (at.kind === "child") {
			if (at.left !== undefined) parts.add(core(at.left));
			parts.add(core(at.step));
		}
		if (at.kind === "filter") parts.add(core(at.base));
		if (at.kind === "axis") parts.add(core(at.value));
	}
	return parts;
}

/** The properties of the searched case a search filter row's CSQL names:
 *  each one-step path outside a relation function's arguments that is no
 *  hole of a device value. */
export function searchRowProperties(text: string): string[] {
	let read: ReturnType<typeof readFormSyntax>;
	try {
		read = readFormSyntax(text);
	} catch (error) {
		rethrowWorkStop(error);
		return [];
	}
	if (!read.ok || read.node === undefined) return [];
	const row = searchRowCsql(read.node);
	if (row === undefined) return [];
	const found: string[] = [];
	visitRunProperties(row, found);
	return found;
}

/** Each property a run of a row's CSQL reads of the searched case, into
 *  `found`, and those of each choice's runs standing where the run reads the
 *  searched case. */
function visitRunProperties(run: CsqlRun, found: string[]): void {
	const { holes } = run;
	const visit = (node: FormSyntax): void => {
		const at = core(node);
		if (at.kind === "call") {
			if (!CSQL_RELATION_FUNCTIONS.has(at.name))
				for (const arg of at.args) visit(arg);
			return;
		}
		if (at.kind === "binary") {
			visit(at.left);
			visit(at.right);
			return;
		}
		if (at.kind === "negative") {
			visit(at.value);
			return;
		}
		const path = flat(at);
		if (path === undefined || path.root !== undefined) return;
		if (path.steps.length !== 1) return;
		const name = elementProperty(path.steps[0]);
		if (name === undefined) return;
		const choice = run.choices.get(name);
		if (choice !== undefined)
			for (const branch of choice) visitRunProperties(branch, found);
		else if (!holes.has(name)) found.push(csqlPropertyName(name));
	};
	visit(run.csql);
}

/** What a search filter row's relation functions name, from `rowType`, the
 *  searched case's type: each type test a relation writes into its filter
 *  (`@case_type = 'T' and (q)`, `csqlRead.ts::typedFilter`), as the parent
 *  link a `parent` hop makes, and each property its filter reads of the
 *  related case. */
export function searchRowRelations(
	text: string,
	rowType: string,
): {
	readonly links: readonly {
		readonly child: string;
		readonly parent: string;
	}[];
	readonly properties: readonly {
		readonly caseType: string;
		readonly property: string;
	}[];
} {
	const links: { child: string; parent: string }[] = [];
	const properties: { caseType: string; property: string }[] = [];
	let read: ReturnType<typeof readFormSyntax>;
	try {
		read = readFormSyntax(text);
	} catch (error) {
		rethrowWorkStop(error);
		return { links, properties };
	}
	if (!read.ok || read.node === undefined) return { links, properties };
	const row = searchRowCsql(read.node);
	if (row === undefined) return { links, properties };
	// The run `visit` reads.
	let run: CsqlRun = row;
	const visit = (node: FormSyntax, origin: string, related: boolean): void => {
		const at = core(node);
		if (at.kind === "call") {
			if (!CSQL_RELATION_FUNCTIONS.has(at.name)) {
				for (const arg of at.args) visit(arg, origin, related);
				return;
			}
			const [first, filter] = at.args;
			const both = filter === undefined ? undefined : core(filter);
			const typed =
				both?.kind === "binary" && both.op === "and"
					? caseTypeTest(core(both.left))
					: undefined;
			if (typed === undefined || both?.kind !== "binary") return;
			const firstAt = first === undefined ? undefined : core(first);
			const identifier =
				at.name === "ancestor-exists" && firstAt !== undefined
					? flat(firstAt)
					: undefined;
			const hop =
				at.name === "ancestor-exists"
					? identifier?.root === undefined &&
						identifier?.steps.length === 1 &&
						identifier.steps[0]?.attribute === false
						? identifier.steps[0].name
						: undefined
					: firstAt?.kind === "string"
						? firstAt.value
						: undefined;
			if (hop === "parent")
				links.push(
					at.name === "ancestor-exists"
						? { child: origin, parent: typed }
						: { child: typed, parent: origin },
				);
			visit(both.right, typed, true);
			return;
		}
		if (at.kind === "binary") {
			visit(at.left, origin, related);
			visit(at.right, origin, related);
			return;
		}
		if (at.kind === "negative") {
			visit(at.value, origin, related);
			return;
		}
		const path = flat(at);
		if (path === undefined || path.root !== undefined) return;
		if (path.steps.length !== 1) return;
		const name = elementProperty(path.steps[0]);
		if (name === undefined) return;
		// A choice's runs read where its marker stands: of the related case
		// inside a relation's filter, of the searched case outside one.
		const choice = run.choices.get(name);
		if (choice !== undefined) {
			const outer = run;
			for (const branch of choice) {
				run = branch;
				visit(branch.csql, origin, related);
			}
			run = outer;
			return;
		}
		if (related && !run.holes.has(name))
			properties.push({ caseType: origin, property: csqlPropertyName(name) });
	};
	visit(row.csql, rowType, false);
	return { links, properties };
}

/** The leading step of a path with no root, the property a row's own
 *  relative read names. */
function relativeProperty(node: FormSyntax): string | undefined {
	const path = flat(node);
	if (path === undefined || path.root !== undefined) return undefined;
	return elementProperty(path.steps[0]);
}

/** The property an element step names; an attribute step names the row's
 *  own metadata, which is no declared property. */
function elementProperty(
	step: Parameters<typeof rowProperty>[0],
): string | undefined {
	return step === undefined || step.attribute ? undefined : rowProperty(step);
}

/** A menu's or a form's entry datums, each worked out once in one scan. */
type EntryRows = (
	moduleUuid: Uuid,
	formUuid?: Uuid,
) => ReturnType<typeof entryDatumIds>;

function entryRowsOf(doc: BlueprintDoc): EntryRows {
	const held = new Map<string, ReturnType<typeof entryDatumIds>>();
	let projection: ReturnType<typeof formLinkProjectionContext> | undefined;
	return (moduleUuid, formUuid) => {
		const key = `${moduleUuid}\u0000${formUuid ?? ""}`;
		let rows = held.get(key);
		if (rows === undefined) {
			projection ??= formLinkProjectionContext(doc, {
				entryMetadataOnly: true,
			});
			rows = entryDatumIds(doc, projection, moduleUuid, formUuid);
			held.set(key, rows);
		}
		return rows;
	};
}

/** The type of the case a menu chose whose id `key` reads, as
 *  `instance('commcaresession')/session/data/<id>`, among the datums the
 *  menu's case list entry holds, or the form's entry where `formUuid` names
 *  one: under its own id or its id before HQ aligns a child entry with its
 *  root menu (`formLinkProjection.ts::caseListStepDatumId`). */
function chosenCaseType(
	doc: BlueprintDoc,
	entryRows: EntryRows,
	moduleUuid: Uuid,
	key: FormSyntax | undefined,
	formUuid?: Uuid,
): string | undefined {
	const path = key === undefined ? undefined : flat(key);
	if (instanceId(path) !== "commcaresession" || path === undefined)
		return undefined;
	const [session, data, leaf, ...more] = path.steps;
	if (
		more.length > 0 ||
		session?.name !== "session" ||
		data?.name !== "data" ||
		leaf === undefined ||
		leaf.attribute ||
		[session, data, leaf].some((step) => step.where.length > 0)
	)
		return undefined;
	const rows = entryRows(moduleUuid, formUuid);
	const row =
		rows.find((one) => one.id === leaf.name) ??
		rows.find((one) => one.chainId === leaf.name);
	const ref = row?.refs.find((one) => one.kind === "selected-case");
	return ref?.kind === "selected-case"
		? doc.modules[ref.module]?.caseType
		: undefined;
}

/** The indices of the own-case walk a case id key reads: an own-case walk's,
 *  or the `@case_id` of a case keyed on one, which is that case's own id. */
function keyWalk(key: FormSyntax | undefined): readonly string[] | undefined {
	if (key === undefined) return undefined;
	const walk = ownCaseWalk(key);
	if (walk !== undefined) return walk;
	const read = casedbRow(key);
	const [id, ...more] = read?.rest ?? [];
	if (
		read === undefined ||
		read.row.where.length !== 1 ||
		more.length > 0 ||
		id?.attribute !== true ||
		id.name !== "case_id" ||
		id.where.length > 0
	)
		return undefined;
	return keyWalk(caseIdKey(read.row.where[0]));
}

function sortedDistinct(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function scanReads(
	pending: readonly PendingExpression[],
	doc: BlueprintDoc,
	env: ExpressionReadEnv,
): ScannedReads {
	const scanner = readsScanner(doc, env);
	for (const registration of pending) {
		const prepared = preparedSource(doc, registration);
		if (prepared.ok)
			scanner.scan(
				prepared.syntax,
				registration.ref,
				true,
				instanceSourcesOf(doc, registration, env),
			);
	}
	return scanner.finish();
}

/**
 * The case properties the device values of a search filter row read (each
 * hole `csqlRead.ts::searchRowCsql` finds, a choice's included), read as the
 * searched menu's own slot reads them: a property of the case a menu above
 * chose through the datum the menu's case list entry holds for it, and one of
 * a case type the read's own type test names. No hole is evaluated at a row
 * of the search, so `searchRowProperties` and `searchRowRelations`, which
 * read the searched case and the cases related to it, leave every hole out.
 * `docOf` gives the document the menus are read into, asked only where a
 * hole reads a case.
 */
export function searchRowHoleReads(
	text: string,
	moduleUuid: Uuid,
	docOf: () => BlueprintDoc,
	env: ExpressionReadEnv,
): ScannedReads["caseProperties"] {
	let read: ReturnType<typeof readFormSyntax>;
	try {
		read = readFormSyntax(text);
	} catch (error) {
		rethrowWorkStop(error);
		return [];
	}
	if (!read.ok || read.node === undefined) return [];
	const row = searchRowCsql(read.node);
	if (row === undefined) return [];
	const holes: FormSyntax[] = [];
	const collect = (run: CsqlRun): void => {
		for (const hole of run.holes.values()) holes.push(hole);
		for (const branches of run.choices.values())
			for (const branch of branches) collect(branch);
	};
	collect(row);
	const readsCase = holes.some((hole) =>
		nodesOf(hole).some(
			(node) =>
				casedbRow(core(node)) !== undefined ||
				siblingCaseRow(core(node)) !== undefined,
		),
	);
	if (!readsCase) return [];
	const scanner = readsScanner(docOf(), env);
	for (const hole of holes)
		scanner.scan(
			hole,
			{ entity: "module", uuid: moduleUuid, slot: "case_list_filter" },
			false,
		);
	return scanner.finish().caseProperties;
}

/** One scan of an app's reads: `scan` reads one slot's syntax into it, and
 *  `finish` gives what every syntax it read reads. `ownRow` says whether the
 *  syntax is evaluated at the slot's own row, which a device value of a
 *  search's row is not. */
function readsScanner(
	doc: BlueprintDoc,
	env: ExpressionReadEnv,
): {
	readonly scan: (
		syntax: FormSyntax,
		ref: PendingExpression["ref"],
		ownRow: boolean,
		sources?: ReadonlyMap<string, string>,
	) => void;
	readonly finish: () => ScannedReads;
} {
	const properties = new Map<string, { caseType: string; property: string }>();
	const entryRows = entryRowsOf(doc);
	const slugs = new Set<string>();
	const tags = new Set<string>();
	const links = new Map<string, { child: string; parent: string }>();
	const untypedReads: { caseType: string; property: string }[] = [];
	// A presence test over one relation names the other end's type; the
	// test in its candidates' predicate starts from those candidates.
	const notePresence = (origin: string | undefined, node: FormSyntax): void => {
		const presence = presenceShape(node);
		if (presence === undefined) {
			const at = core(node);
			const parts = clauses(at, "and");
			if (parts.length > 2) {
				// A test's two halves are two clauses of a longer chain.
				let index = 0;
				while (index < parts.length) {
					const first = parts[index] as FormSyntax;
					const second = parts[index + 1];
					const run =
						second === undefined ? undefined : joinedClauses([first, second]);
					if (run !== undefined && presenceShape(run) !== undefined) {
						notePresence(origin, run);
						index += 2;
					} else {
						notePresence(origin, first);
						index += 1;
					}
				}
			} else if (at.kind === "binary") {
				notePresence(origin, at.left);
				notePresence(origin, at.right);
			} else if (at.kind === "call") {
				// A count of subcases, `count(casedb/case[index/parent = … and
				// @case_type = 'T'])`, names the subcases' type.
				const counted =
					at.name === "count" && at.args.length === 1
						? casedbRow(at.args[0] as FormSyntax)
						: undefined;
				const link = counted?.row.where[0];
				const typed = link === undefined ? undefined : core(link);
				const both =
					typed?.kind === "binary" && typed.op === "and" ? typed : undefined;
				const indexTest = both === undefined ? typed : core(both.left);
				const index =
					indexTest?.kind === "binary" && indexTest.op === "="
						? flat(indexTest.left)
						: undefined;
				const subcaseType =
					both === undefined ? undefined : caseTypeTest(both.right);
				if (
					origin !== undefined &&
					subcaseType !== undefined &&
					counted?.rest.length === 0 &&
					index?.root === undefined &&
					index?.steps.length === 2 &&
					index.steps[0]?.name === "index" &&
					index.steps[1]?.name === "parent"
				)
					links.set(JSON.stringify([subcaseType, origin]), {
						child: subcaseType,
						parent: origin,
					});
				for (const arg of at.args) notePresence(origin, arg);
			} else if (at.kind === "negative") notePresence(origin, at.value);
			else if (at.kind === "child") {
				if (at.left !== undefined) notePresence(origin, at.left);
				notePresence(origin, at.step);
			} else if (at.kind === "filter") {
				// A row predicate's tests start from the rows it filters, whose
				// type its own type test names.
				const own = clauses(at.where, "and")
					.map((clause) => caseTypeTest(clause))
					.find((type) => type !== undefined);
				notePresence(origin, at.base);
				notePresence(own ?? origin, at.where);
			}
			return;
		}
		if (presence.caseType === undefined) return;
		if (presence.identifier === "parent" && origin !== undefined) {
			const link =
				presence.kind === "ancestor"
					? { child: origin, parent: presence.caseType }
					: { child: presence.caseType, parent: origin };
			links.set(JSON.stringify([link.child, link.parent]), link);
		}
		notePresence(presence.caseType, presence.where);
	};
	const noteWalk = (origin: string | undefined, node: FormSyntax) => {
		let at = origin;
		for (const hop of ancestorWalk(node) ?? []) {
			if (at === undefined || hop.throughCaseType === undefined) return;
			if (hop.identifier === "parent")
				links.set(JSON.stringify([at, hop.throughCaseType]), {
					child: at,
					parent: hop.throughCaseType,
				});
			at = hop.throughCaseType;
		}
	};
	const note = (caseType: string | undefined, property: string | undefined) => {
		if (caseType === undefined || property === undefined) return;
		if (!AUTHORED_CASE_PROPERTY_NAME_PATTERN.test(property)) return;
		properties.set(JSON.stringify([caseType, property]), {
			caseType,
			property,
		});
	};
	// The instance ids each form's expressions read, so a declaration of a
	// table is a read only where an expression of its form reads its id.
	const readIds = new Map<Uuid, Set<string>>();
	const noteLocationProperty = (path: NonNullable<ReturnType<typeof flat>>) => {
		const [data, slug] = path.steps;
		if (
			data?.name === "location_data" &&
			!data.attribute &&
			slug &&
			!slug.attribute
		)
			slugs.add(slug.name);
	};
	const scan = (
		syntax: FormSyntax,
		ref: PendingExpression["ref"],
		ownRow: boolean,
		sources?: ReadonlyMap<string, string>,
	): void => {
		const context = slotContext(doc, ref, lookupTypes(env));
		const row =
			context === undefined || !ownRow ? undefined : activeRowScope(context);
		const rowType = row?.kind === "case" ? row.caseType : undefined;
		const form = slotForm(doc, ref);
		const moduleUuid = context?.form?.moduleUuid;
		const moduleType =
			moduleUuid === undefined ? undefined : doc.modules[moduleUuid]?.caseType;
		const reachable =
			form === undefined ? [] : [...caseTypeHopMap(doc, moduleType).entries()];
		const native = nativeInstancePaths(syntax, sources);
		notePresence(rowType ?? moduleType, native.syntax);
		const nodes = nodesOf(native.syntax);
		const inPredicate = new Set<FormSyntax>();
		const innerStep = partsOfPaths(nodes);
		for (const node of nodes) {
			const at = core(node);
			const inner = innerStep.has(at);
			// A predicate's reads are of the rows it filters, never the slot's
			// own row.
			if (at.kind === "filter")
				for (const inside of nodesOf(at.where)) inPredicate.add(core(inside));
			const id = literalInstanceId(at);
			if (id !== undefined) {
				const localId = native.localIds.get(id.from) ?? id.value;
				if (form !== undefined && sources !== undefined) {
					const read = readIds.get(form) ?? new Set<string>();
					readIds.set(form, read);
					read.add(localId);
				}
				const bound = instanceForRead(localId, sources);
				if (bound?.kind === "table") tags.add(bound.tag);
			}
			if (inner) continue;
			noteWalk(rowType ?? moduleType, at);
			const path = flat(at, true);
			if (path === undefined) continue;
			if (path.root === undefined) {
				if (row?.kind === "location" && !inPredicate.has(at))
					noteLocationProperty(path);
				continue;
			}
			const instance = instanceId(path);
			if (instance === "locations") {
				const location = path.steps[1];
				if (
					path.steps[0]?.name === "locations" &&
					location?.name === "location"
				)
					for (const where of location.where)
						for (const candidate of nodesOf(where, false)) {
							const relative = flat(candidate);
							if (relative?.root === undefined && relative)
								noteLocationProperty(relative);
						}
				const index = path.steps.findIndex(
					(step) => step.name === "location_data" && !step.attribute,
				);
				const slug = index < 0 ? undefined : path.steps[index + 1];
				if (slug !== undefined && !slug.attribute) slugs.add(slug.name);
				continue;
			}
			const read = casedbRow(at) ?? siblingCaseRow(at);
			const results =
				(instance === "results" || instance === "results:inline") &&
				path.steps[0]?.name === "results" &&
				path.steps[1]?.name === "case";
			const rowStep = read?.row ?? (results ? path.steps[1] : undefined);
			const rest = read?.rest ?? (results ? path.steps.slice(2) : []);
			if (rowStep === undefined) continue;
			// The type test among a predicate's clauses, the first of them where
			// the clauses after it lean left on it.
			const typed = rowStep.where
				.flatMap((where) => clauses(where, "and"))
				.map((clause) => caseTypeTest(clause))
				.find((type) => type !== undefined);
			const ownWalk =
				rowStep.where.length === 1
					? keyWalk(caseIdKey(rowStep.where[0]))
					: undefined;
			// In a menu's own slot, a case keyed on a session value is the
			// case a menu above it chose; in a form's own slot (its display
			// condition, its case changes), a case its entry chose.
			const key =
				rowStep.where.length === 1 ? caseIdKey(rowStep.where[0]) : undefined;
			const chosen =
				key === undefined
					? undefined
					: ref.entity === "module"
						? chosenCaseType(doc, entryRows, ref.uuid, key)
						: ref.entity === "form" && moduleUuid !== undefined
							? chosenCaseType(doc, entryRows, moduleUuid, key, ref.uuid)
							: undefined;
			// A search's rows are the searched menu's case type.
			const searched =
				results && context?.supplies.searchResults !== undefined
					? context.facts.moduleCaseTypes.get(
							context.supplies.searchResults.module,
						)
					: undefined;
			const caseType =
				typed ??
				searched ??
				chosen ??
				(ownWalk === undefined
					? undefined
					: reachable.find(([, hops]) => sameJson(hops, ownWalk))?.[0]);
			if (caseType === undefined) {
				// A query of every case, which Nova writes for a property one
				// case type alone declares: the slot's own case type, where
				// no read types the property. A case read by its id is one
				// case of any type, which this names nothing of.
				const fallback = rowType ?? moduleType;
				if (
					read === undefined ||
					fallback === undefined ||
					rowStep.where.some((where) => caseIdKey(where) !== undefined)
				)
					continue;
				const named = [
					...(rest.length === 1 ? [elementProperty(rest[0])] : []),
					...rowStep.where.flatMap((where) => {
						const nodes = nodesOf(where);
						const parts = partsOfPaths(nodes);
						return nodes
							.filter((inner) => !parts.has(core(inner)))
							.map((inner) => relativeProperty(inner));
					}),
				];
				for (const property of named)
					if (property !== undefined)
						untypedReads.push({ caseType: fallback, property });
				continue;
			}
			if (rest.length === 1) note(caseType, elementProperty(rest[0]));
			if (typed !== undefined)
				for (const where of rowStep.where) {
					const nodes = nodesOf(where);
					const parts = partsOfPaths(nodes);
					for (const inner of nodes)
						if (!parts.has(core(inner)))
							note(caseType, relativeProperty(inner));
				}
		}
		if (rowType !== undefined && context?.ruleSet === "record")
			for (const node of nodes) {
				const at = core(node);
				if (innerStep.has(at)) continue;
				const path = flat(at);
				if (path === undefined) continue;
				// A read from `current()` is of the slot's own row inside a
				// predicate too.
				const fromCurrent =
					path.root?.kind === "call" &&
					path.root.name === "current" &&
					path.root.args.length === 0;
				if (inPredicate.has(at) && !fromCurrent) continue;
				if (path.root === undefined || fromCurrent)
					note(rowType, elementProperty(path.steps[0]));
			}
	};
	const finish = (): ScannedReads => {
		const declared = new Set<string>();
		for (const [form, sources] of env.instanceSources)
			for (const [id, source] of sources) {
				if (
					!source.startsWith(TABLE_SOURCE) ||
					source.length === TABLE_SOURCE.length
				)
					continue;
				const tag = source.slice(TABLE_SOURCE.length);
				if (readIds.get(form)?.has(id) === true) tags.add(tag);
				else declared.add(tag);
			}
		// Each property an untyped query reads that no case type declares, and
		// no read types, belongs to the slot's own case type: Nova's binder
		// types it by the one type that declares it, and the print, which tests
		// no type, is the same whichever type that is.
		const declaredNames = new Set([
			...effectiveCaseTypes(doc).flatMap((type) =>
				type.properties.map((one) => one.name),
			),
			...[...properties.values()].map((one) => one.property),
		]);
		for (const read of untypedReads)
			if (
				!declaredNames.has(read.property) &&
				!isStandardCaseListProperty(read.property)
			)
				note(read.caseType, read.property);
		return {
			caseProperties: [...properties.values()].sort((a, b) =>
				a.caseType === b.caseType
					? a.property < b.property
						? -1
						: a.property > b.property
							? 1
							: 0
					: a.caseType < b.caseType
						? -1
						: 1,
			),
			locationDataSlugs: sortedDistinct(slugs),
			lookupTags: sortedDistinct(tags),
			declaredLookupTags: sortedDistinct(
				[...declared].filter((tag) => !tags.has(tag)),
			),
			parentLinks: [...links.values()],
		};
	};
	return { scan, finish };
}
