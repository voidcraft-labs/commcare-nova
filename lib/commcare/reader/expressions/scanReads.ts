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
import type { FormSyntax } from "../../xpath/formSyntax";
import { sameJson } from "../jsonCursor";
import type { PendingExpression } from "../pendingExpressions";
import { readFormSyntax } from "../syntaxRead";
import { searchRowCsql } from "./csqlRead";
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
import { lookupTypes, preparedSource, slotForm } from "./readExpression";

export interface ScannedReads {
	readonly caseProperties: readonly {
		readonly caseType: string;
		readonly property: string;
	}[];
	readonly locationDataSlugs: readonly string[];
	readonly lookupTags: readonly string[];
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
const TABLE_ID = "item-list:";

/** Every node of a syntax tree, in document order. */
function nodesOf(root: FormSyntax): FormSyntax[] {
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
				visit(node.where);
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
	} catch {
		return [];
	}
	if (!read.ok || read.node === undefined) return [];
	const row = searchRowCsql(read.node);
	if (row === undefined) return [];
	const found: string[] = [];
	for (const run of [row, ...row.branches])
		visitRunProperties(run.csql, run.holes, found);
	return found;
}

/** Each property a run of a row's CSQL reads of the searched case, into
 *  `found`. */
function visitRunProperties(
	csql: FormSyntax,
	holes: ReadonlyMap<string, FormSyntax>,
	found: string[],
): void {
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
		if (name !== undefined && !holes.has(name)) found.push(name);
	};
	visit(csql);
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
	} catch {
		return { links, properties };
	}
	if (!read.ok || read.node === undefined) return { links, properties };
	const row = searchRowCsql(read.node);
	if (row === undefined) return { links, properties };
	// The holes of the run `visit` reads.
	let holes = row.holes;
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
		if (!related) return;
		const path = flat(at);
		if (path === undefined || path.root !== undefined) return;
		if (path.steps.length !== 1) return;
		const name = elementProperty(path.steps[0]);
		if (name !== undefined && !holes.has(name))
			properties.push({ caseType: origin, property: name });
	};
	for (const run of [row, ...row.branches]) {
		holes = run.holes;
		visit(run.csql, rowType, false);
	}
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

/** The type of the case a menu chose whose id `key` reads, as
 *  `instance('commcaresession')/session/data/<id>`, among the datums the
 *  menu's case list entry holds: under its own id or its id before HQ aligns
 *  a child entry with its root menu (`formLinkProjection.ts::caseListStepDatumId`). */
function chosenCaseType(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	key: FormSyntax | undefined,
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
	const rows = entryDatumIds(
		doc,
		formLinkProjectionContext(doc, { entryMetadataOnly: true }),
		moduleUuid,
	);
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
	const properties = new Map<string, { caseType: string; property: string }>();
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
	for (const sources of env.instanceSources.values())
		for (const source of sources.values())
			if (
				source.startsWith(TABLE_SOURCE) &&
				source.length > TABLE_SOURCE.length
			)
				tags.add(source.slice(TABLE_SOURCE.length));
	for (const registration of pending) {
		const prepared = preparedSource(doc, registration);
		if (!prepared.ok) continue;
		const context = slotContext(doc, registration.ref, lookupTypes(env));
		const row = context === undefined ? undefined : activeRowScope(context);
		const rowType = row?.kind === "case" ? row.caseType : undefined;
		const form = slotForm(doc, registration.ref);
		const moduleUuid = context?.form?.moduleUuid;
		const moduleType =
			moduleUuid === undefined ? undefined : doc.modules[moduleUuid]?.caseType;
		const reachable =
			form === undefined ? [] : [...caseTypeHopMap(doc, moduleType).entries()];
		notePresence(rowType ?? moduleType, prepared.syntax);
		const nodes = nodesOf(prepared.syntax);
		const inPredicate = new Set<FormSyntax>();
		const innerStep = partsOfPaths(nodes);
		for (const node of nodes) {
			const at = core(node);
			const inner = innerStep.has(at);
			// A predicate's reads are of the rows it filters, never the slot's
			// own row.
			if (at.kind === "filter")
				for (const inside of nodesOf(at.where)) inPredicate.add(core(inside));
			if (at.kind === "call" && at.name === "instance") {
				const id = at.args[0];
				if (id?.kind === "string" && id.value.startsWith(TABLE_ID))
					tags.add(id.value.slice(TABLE_ID.length));
			}
			if (inner) continue;
			noteWalk(rowType ?? moduleType, at);
			const path = flat(at, true);
			if (path === undefined) continue;
			if (path.root === undefined) {
				const [data, slug] = path.steps;
				if (
					data?.name === "location_data" &&
					!data.attribute &&
					slug !== undefined &&
					!slug.attribute
				)
					slugs.add(slug.name);
				continue;
			}
			const instance = instanceId(path);
			if (instance === "locations") {
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
			// case a menu above it chose.
			const chosen =
				registration.ref.entity === "module" && rowStep.where.length === 1
					? chosenCaseType(
							doc,
							registration.ref.uuid,
							caseIdKey(rowStep.where[0]),
						)
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
	}
	// Each property an untyped query reads that no case type declares, and
	// no read types, belongs to the slot's own case type: Nova's binder
	// types it by the one type that declares it, and the print, which tests
	// no type, is the same whichever type that is.
	const declared = new Set([
		...effectiveCaseTypes(doc).flatMap((type) =>
			type.properties.map((one) => one.name),
		),
		...[...properties.values()].map((one) => one.property),
	]);
	for (const read of untypedReads)
		if (
			!declared.has(read.property) &&
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
		parentLinks: [...links.values()],
	};
}
