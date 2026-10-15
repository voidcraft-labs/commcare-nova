/**
 * The identities that move once for a deployment made before step 2, read by
 * parsing both emissions, never by pattern: for every corpus fixture, the
 * pre-step bytes retained under `proof/hq-reads/cutover/<document>/legacy/`
 * against what this head's emitter makes of the transformed fixture. Each
 * row of part 09's table (Why `proof/identity-moves.json` stays empty) whose
 * fix has landed adds its assertions here; what the table says moves for
 * nothing stays equal. HQ's menu and form ids for a deployment whose ids the
 * cutover recorded are the ledger test's (`ledger.postgres.test.ts`).
 */

import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { derivedFormXmlns, derivedUniqueId } from "@/lib/commcare/wireIdentity";
import {
	descendFormPathIntoField,
	FormPath,
} from "@/lib/commcare/xform/formPath";
import {
	type GeneratedNodePlan,
	isKeyedRootCreate,
	operationGuardKinds,
	planGeneratedNodes,
} from "@/lib/commcare/xform/generatedNodes";
import { parseXml } from "@/lib/commcare/xmlParse";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	asUuid,
	type BlueprintDoc,
	blueprintDocSchema,
	isContainer,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";
import { collectHqPaths } from "../matching";
import { rawDocumentAssembly, readRawDocument } from "../oldShape";
import { questionPaths } from "../questionPaths";
import { transformDocument } from "../transform";
import { readLegacyApp } from "./fixtures/legacyBodies";
import {
	LEGACY_DIRECTORY,
	readFixtureCarriers,
	readFixtureManifest,
	readFixtureProject,
} from "./fixtures/preStep";

type HqApp = {
	langs: string[];
	modules: {
		unique_id: string;
		forms: { unique_id: string; xmlns: string }[];
	}[];
	_attachments: Record<string, string>;
};

const DOCUMENTS = readFixtureManifest()
	.fixtures.filter((fixture) => fixture.kind === "corpus")
	.map((fixture) => fixture.id);

function emitted(id: string) {
	const raw = readRawDocument(id, readFixtureCarriers(id));
	const { target } = transformDocument(raw, {
		appId: id,
		projectId: "fixture-project",
		lookupColumnTypes: new Map(),
		deployments: [],
	});
	const doc = hydratePersistedBlueprint(
		blueprintDocSchema.parse(rawDocumentAssembly(id, target)),
	);
	// The Project's lookup tables, as the export boundary names them.
	const snapshot = readFixtureProject(id).lookup as
		| {
				definitions: Parameters<typeof lookupWireNaming>[0];
				rowsByTable: Record<string, unknown[]>;
		  }
		| undefined;
	const naming =
		snapshot === undefined ? undefined : lookupWireNaming(snapshot.definitions);
	const lookup =
		snapshot === undefined || naming === undefined
			? undefined
			: {
					naming,
					fixtures: buildLookupFixtures(
						naming,
						new Map(Object.entries(snapshot.rowsByTable)) as never,
					),
				};
	const hq = expandDoc(doc, {
		...(naming !== undefined && { lookupNaming: naming }),
	}) as unknown as HqApp;
	return { doc, hq, lookup, menus: questionPaths(target) };
}

/** Each form's XForm in order, by the app JSON's own form ids. */
function xforms(app: HqApp): string[] {
	return app.modules.flatMap((module) =>
		module.forms.map((form) => app._attachments[`${form.unique_id}.xml`] ?? ""),
	);
}

/** Each form's uuid in the app JSON's order. */
function formUuids(doc: BlueprintDoc, app: HqApp): Uuid[] {
	const byUniqueId = new Map(
		Object.keys(doc.forms).map((uuid) => [
			derivedUniqueId(asUuid(uuid)),
			asUuid(uuid),
		]),
	);
	return app.modules.flatMap((module) =>
		module.forms.flatMap((form) => {
			const uuid = byUniqueId.get(form.unique_id);
			return uuid === undefined ? [] : [uuid];
		}),
	);
}

function elements(node: { children: unknown[] }): Element[] {
	return node.children.filter((child): child is Element =>
		isTag(child as never),
	);
}

/** The primary instance's data root of one XForm. */
function dataRoot(xform: string): Element {
	const find = (nodes: readonly Element[]): Element | undefined => {
		for (const element of nodes) {
			if (element.name.endsWith("instance")) return elements(element)[0];
			const found = find(elements(element));
			if (found !== undefined) return found;
		}
		return undefined;
	};
	const root = find(elements(parseXml(xform)));
	if (root === undefined) throw new Error("The form holds no data root.");
	return root;
}

/** Every element under `root`, with its path from the data root's own name. */
function walk(root: Element): { element: Element; path: string }[] {
	const all: { element: Element; path: string }[] = [];
	const visit = (element: Element, path: string) => {
		all.push({ element, path });
		for (const child of elements(element))
			visit(child, `${path}/${child.name}`);
	};
	visit(root, `/${root.name}`);
	return all;
}

/**
 * The paths a post-step form holds through its own questions alone, and the
 * path of each question's container element, read by walking the document's
 * field tree beside the data tree. A container element holding no question's
 * element is a leaf, as `collectHqPaths` reads a pre-step one whose children
 * were all generated.
 */
function authoredTree(
	xform: string,
	doc: BlueprintDoc,
	formUuid: Uuid,
): { leaves: string[]; scopeOf: Map<Uuid, string> } {
	const leaves: string[] = [];
	const scopeOf = new Map<Uuid, string>();
	const visit = (element: Element, parentUuid: Uuid, path: string) => {
		let held = 0;
		for (const uuid of orderedFieldUuids(doc, parentUuid)) {
			const field = doc.fields[uuid];
			scopeOf.set(uuid, path);
			const child = elements(element).find((node) => node.name === field.id);
			if (child === undefined) continue;
			held += 1;
			const childPath = `${path}/${field.id}`;
			if (!isContainer(field)) {
				leaves.push(childPath);
				continue;
			}
			const item =
				field.kind === "repeat" && field.repeat_mode === "query_bound"
					? elements(child).find((node) => node.name === "item")
					: child;
			if (item === undefined) leaves.push(childPath);
			else visit(item, uuid, item === child ? childPath : `${childPath}/item`);
		}
		if (held === 0 && path !== `/${element.name}` && !leaves.includes(path))
			leaves.push(path);
	};
	const root = dataRoot(xform);
	visit(root, formUuid, `/${root.name}`);
	return { leaves, scopeOf };
}

/** Each repeat's own scope as the plan keys it, by the repeat's uuid. */
function repeatScopes(doc: BlueprintDoc, formUuid: Uuid): Map<Uuid, FormPath> {
	const scopes = new Map<Uuid, FormPath>();
	const visit = (parentUuid: Uuid, parentPath: FormPath) => {
		for (const uuid of orderedFieldUuids(doc, parentUuid)) {
			const field = doc.fields[uuid];
			if (!isContainer(field)) continue;
			const path = descendFormPathIntoField(field, parentPath.child(field.id));
			if (field.kind === "repeat") scopes.set(uuid, path);
			visit(uuid, path);
		}
	};
	visit(formUuid, FormPath.root());
	return scopes;
}

/** The Save to Case block a form's data tree holds under `name`. */
function block(
	tree: readonly { element: Element; path: string }[],
	name: string,
): Element | undefined {
	return tree.find(
		(entry) =>
			entry.element.name === name &&
			entry.element.attribs["vellum:role"] === "SaveToCase",
	)?.element;
}

function parentName(element: Element | undefined): string | undefined {
	const parent = element?.parent;
	return parent !== null && parent !== undefined && isTag(parent)
		? parent.name
		: undefined;
}

/** The data root's `xmlns` declaration of one XForm. */
function dataXmlns(xform: string): string | undefined {
	const find = (nodes: readonly unknown[]): string | undefined => {
		for (const node of nodes) {
			if (!isTag(node as never)) continue;
			const element = node as import("domhandler").Element;
			if (element.name.endsWith("instance")) {
				const root = element.children.find((child) => isTag(child));
				return (root as import("domhandler").Element | undefined)?.attribs
					.xmlns;
			}
			const found = find(element.children);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	return find(parseXml(xform).children);
}

/**
 * Each operation's block stood in `__nova_operations`; it now stands in its
 * scope's operations group, inside its one-row repeat when it is a root
 * create keyed by an answer, and inside its condition group when it is a
 * conditional update or close. Each guard is a Save to Case block in the
 * condition group of a conditional operation and in the operations group of
 * any other.
 */
function expectOperationsMoved(
	doc: BlueprintDoc,
	formUuid: Uuid,
	plan: GeneratedNodePlan,
	tree: readonly { element: Element; path: string }[],
	previous: readonly { element: Element; path: string }[],
): void {
	const repeats = repeatScopes(doc, formUuid);
	const conditional = new Set(
		plan.nodes
			.filter((node) => node.purpose === "condition")
			.map((node) => node.owner),
	);
	for (const operation of orderedCaseOperations(doc.forms[formUuid])) {
		const repeat = operation.forEach?.repeat;
		const operations = plan.operations(
			repeat === undefined
				? FormPath.root()
				: (repeats.get(repeat) ?? FormPath.root()),
		);
		expect(parentName(block(previous, operation.id))).toBe("__nova_operations");
		const moved = block(tree, operation.id);
		const groupOf = conditional.has(operation.uuid)
			? plan.condition(operation.uuid)
			: operations;
		if (isKeyedRootCreate(operation)) {
			expect(parentName(moved)).toBe(plan.keyed(operation.uuid));
			expect(parentName(moved?.parent as Element)).toBe(operations);
		} else if (operation.action !== "create") {
			expect(parentName(moved)).toBe(groupOf);
		} else {
			expect(parentName(moved)).toBe(operations);
		}
		if (groupOf !== operations)
			expect(
				parentName(
					tree.find((entry) => entry.element.name === groupOf)?.element,
				),
			).toBe(operations);
		for (const kind of operationGuardKinds(operation)) {
			expect(parentName(block(tree, plan.guard(operation.uuid, kind)))).toBe(
				groupOf,
			);
		}
	}
}

describe.each(DOCUMENTS)("over %s", (id) => {
	const legacy = readLegacyApp(id, "republish") as unknown as HqApp;

	it("keeps every language's wire code", () => {
		expect(emitted(id).hq.langs).toEqual(legacy.langs);
	});

	it("keeps every question path no step renames", () => {
		const { doc, hq } = emitted(id);
		const after = xforms(hq);
		const before = xforms(legacy);
		const forms = formUuids(doc, hq);
		expect(after).toHaveLength(before.length);
		expect(forms).toHaveLength(before.length);
		before.forEach((xform, index) => {
			expect(
				authoredTree(after[index] ?? "", doc, forms[index]).leaves.sort(),
			).toEqual(
				collectHqPaths(xform)
					.filter((entry) => !entry.generated)
					.map((entry) => entry.path)
					.sort(),
			);
		});
	});

	it("moves every generated node's path as the plan names it, and leaves each count and message node where it stood", () => {
		const { doc, hq } = emitted(id);
		const after = xforms(hq);
		const before = xforms(legacy);
		formUuids(doc, hq).forEach((formUuid, index) => {
			const xform = after[index] ?? "";
			const plan = planGeneratedNodes(doc, formUuid);
			const { scopeOf } = authoredTree(xform, doc, formUuid);
			const tree = walk(dataRoot(xform));
			const previous = walk(dataRoot(before[index] ?? ""));
			// No node keeps the pre-step prefix.
			expect(
				tree.filter((entry) => entry.element.name.startsWith("__nova_")),
			).toEqual([]);
			// `nova_count_` and `nova_constraint_message_` do not move.
			expect(
				plan.nodes
					.filter(
						(node) =>
							node.purpose === "count" || node.purpose === "constraint-message",
					)
					.map((node) => `${scopeOf.get(node.owner)}/${node.name}`)
					.sort(),
			).toEqual(
				collectHqPaths(before[index] ?? "")
					.filter((entry) => entry.generated)
					.map((entry) => entry.path)
					.sort(),
			);
			// Each operation's block, from `__nova_operations/<id>` to its place.
			expectOperationsMoved(doc, formUuid, plan, tree, previous);
		});
	});

	it("moves every menu id, form id and xmlns of a deployment no credential read from HQ's values to the derived ones", () => {
		const { hq, menus } = emitted(id);
		const forms = menus.flatMap((menu) => menu.forms);
		expect(hq.modules.map((module) => module.unique_id)).toEqual(
			menus.map((menu) => derivedUniqueId(asUuid(menu.uuid))),
		);
		expect(
			hq.modules.flatMap((module) =>
				module.forms.map((form) => form.unique_id),
			),
		).toEqual(forms.map((form) => derivedUniqueId(asUuid(form.uuid))));
		expect(
			hq.modules.flatMap((module) => module.forms.map((form) => form.xmlns)),
		).toEqual(forms.map((form) => derivedFormXmlns(asUuid(form.uuid))));
		for (const [index, module] of legacy.modules.entries()) {
			expect(module.unique_id).not.toBe(hq.modules[index]?.unique_id);
			for (const [formIndex, form] of module.forms.entries()) {
				expect(form.xmlns).not.toBe(hq.modules[index]?.forms[formIndex]?.xmlns);
			}
		}
	});

	it("moves each form's xmlns in the local archive from a drawn one to the derived one", () => {
		const { doc, hq, lookup, menus } = emitted(id);
		const archive = new AdmZip(
			compileCcz(hq as never, doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
				...(lookup !== undefined && { lookup }),
			}),
		);
		const before = new AdmZip(`${LEGACY_DIRECTORY}/${id}/legacy/local.ccz`);
		menus.forEach((menu, menuIndex) => {
			menu.forms.forEach((form, formIndex) => {
				const entry = `modules-${menuIndex}/forms-${formIndex}.xml`;
				const now = dataXmlns(archive.readAsText(entry));
				expect(now).toBe(derivedFormXmlns(asUuid(form.uuid)));
				expect(dataXmlns(before.readAsText(entry))).not.toBe(now);
			});
		});
	});
});
