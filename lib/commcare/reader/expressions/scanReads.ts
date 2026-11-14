/**
 * What an app's expressions read, from their syntax alone, before any of
 * them is bound: the case properties whose case type the syntax fixes, the
 * place properties they name and the lookup tables they read. The scan reads
 * each registration's text once, after HQ's interpolation, through the one
 * grammar, and mints nothing.
 */
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { AUTHORED_CASE_PROPERTY_NAME_PATTERN } from "@/lib/domain/casePropertyName";
import { reachableCaseTypes } from "@/lib/domain/caseTypes";
import { activeRowScope, slotContext } from "@/lib/domain/expression/context";
import { type FormSyntax, readFormSyntax } from "../../xpath/formSyntax";
import type { PendingExpression } from "../pendingExpressions";
import { searchRowCsql } from "./csqlRead";
import {
	casedbRow,
	caseIdKey,
	caseTypeTest,
	core,
	flat,
	instanceId,
	ownCaseDepth,
	rowProperty,
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
		if (name !== undefined && !row.holes.has(name)) found.push(name);
	};
	visit(row.csql);
	return found;
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
		if (registration.mode.target === "search-row") {
			const context = slotContext(doc, registration.ref, lookupTypes(env));
			const row = context === undefined ? undefined : activeRowScope(context);
			if (row?.kind === "case")
				for (const property of searchRowProperties(registration.text))
					note(row.caseType, property);
			continue;
		}
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
			form === undefined
				? []
				: reachableCaseTypes(moduleType, doc.caseTypes ?? []);
		const nodes = nodesOf(prepared.syntax);
		const inPredicate = new Set<FormSyntax>();
		const innerStep = partsOfPaths(nodes);
		for (const node of nodes) {
			const at = core(node);
			const inner = innerStep.has(at);
			if (at.kind === "filter") inPredicate.add(core(at.where));
			if (at.kind === "call" && at.name === "instance") {
				const id = at.args[0];
				if (id?.kind === "string" && id.value.startsWith(TABLE_ID))
					tags.add(id.value.slice(TABLE_ID.length));
			}
			if (inner) continue;
			const path = flat(at);
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
			const read = casedbRow(at);
			const results =
				(instance === "results" || instance === "results:inline") &&
				path.steps[0]?.name === "results" &&
				path.steps[1]?.name === "case";
			const rowStep = read?.row ?? (results ? path.steps[1] : undefined);
			const rest = read?.rest ?? (results ? path.steps.slice(2) : []);
			if (rowStep === undefined) continue;
			const typed = rowStep.where
				.map((where) => {
					const both = core(where);
					return (
						caseTypeTest(where) ??
						(both.kind === "binary" && both.op === "and"
							? (caseTypeTest(both.left) ?? caseTypeTest(both.right))
							: undefined)
					);
				})
				.find((type) => type !== undefined);
			const ownDepth =
				rowStep.where.length === 1
					? ownCaseDepth(caseIdKey(rowStep.where[0]))
					: undefined;
			const caseType =
				typed ??
				(ownDepth === undefined
					? undefined
					: reachable.find((type) => type.depth === ownDepth)?.name);
			if (caseType === undefined) continue;
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
				if (inPredicate.has(core(node)) || innerStep.has(core(node))) continue;
				const at = core(node);
				const path = flat(at);
				if (path === undefined) continue;
				const own =
					path.root === undefined ||
					(path.root.kind === "call" &&
						path.root.name === "current" &&
						path.root.args.length === 0);
				if (own) note(rowType, elementProperty(path.steps[0]));
			}
	}
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
	};
}
