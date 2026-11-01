/**
 * The cutover's pre-step fixtures, admitted and read by `main`'s own code.
 *
 * Each fixture is the stored document of an app `main` admits, and
 * `facts.json` holds what `main`'s own functions derive from it: where each
 * case block lands, which writers it preloads, which group labels show, and
 * which search shape it emits. Once a later pull request of the stack changes
 * those shapes or that code, neither can be produced again, so this file runs
 * only while `main`'s shapes still parse and `fixtures.digest.test.ts` holds
 * the bytes afterwards. `NOVA_WRITE_PRE_STEP_FACTS=1` writes `facts.json`
 * instead of comparing it; the commit hook then lays it out as Biome does.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChildNode, type Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { availableLookupContext } from "@/lib/__tests__/lookupFixtures";
import { expandDoc } from "@/lib/commcare/expander";
import { searchWireShape } from "@/lib/commcare/suite/case-search/searchWireShape";
import type { FormActions } from "@/lib/commcare/types";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import { FormPath } from "@/lib/commcare/xform/formPath";
import {
	operationGuardKinds,
	planGeneratedNodes,
} from "@/lib/commcare/xform/generatedNodes";
import { parseXml } from "@/lib/commcare/xmlParse";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	CASE_LOADING_FORM_TYPES,
	caseSelectionCardinality,
	deriveCaseWriteInventory,
	effectiveCaseSearchConfig,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";
import { writerPreloadsFromLoadedCase } from "@/lib/domain/casePreload";

const PRE_STEP = join(import.meta.dirname, "fixtures", "pre-step");
const FACTS = join(PRE_STEP, "facts.json");
const FACTS_FORMAT = "hq-round-trip-case-writes-pre-step-facts-1";

interface Placement {
	readonly formUuid: Uuid;
	readonly unit: string;
	readonly emitted: string;
}

interface FixtureFacts {
	readonly placements: readonly Placement[];
	readonly preloadedWriters: Readonly<Record<Uuid, readonly Uuid[]>>;
	readonly labelledGroups: readonly Uuid[];
	readonly searchShapes: Readonly<
		Record<Uuid, "search-first" | "skip-to-results" | "list-first">
	>;
}

interface PreStepFacts {
	readonly format: typeof FACTS_FORMAT;
	readonly fixtures: Readonly<Record<string, FixtureFacts>>;
}

/** Every fixture the directory holds, by id, in id order. */
const fixtureIds = readdirSync(PRE_STEP)
	.filter(
		(name) =>
			name.endsWith(".json") &&
			name !== "facts.json" &&
			name !== "digests.json",
	)
	.map((name) => name.slice(0, -".json".length))
	.sort();

function readFixture(id: string): unknown {
	return JSON.parse(readFileSync(join(PRE_STEP, `${id}.json`), "utf8"));
}

function admittedDoc(id: string): BlueprintDoc {
	return hydratePersistedBlueprint(blueprintDocSchema.parse(readFixture(id)));
}

/** The forms of the document in menu order, each with its module. */
function formsInOrder(doc: BlueprintDoc) {
	return doc.moduleOrder.flatMap((moduleUuid) =>
		(doc.formOrder[moduleUuid] ?? []).map((formUuid) => ({
			moduleUuid,
			formUuid,
		})),
	);
}

/** Every field of a form in data-tree order. */
function fieldsInDataOrder(doc: BlueprintDoc, parentUuid: Uuid): Uuid[] {
	return (doc.fieldOrder[parentUuid] ?? []).flatMap((fieldUuid) => [
		fieldUuid,
		...fieldsInDataOrder(doc, fieldUuid),
	]);
}

/**
 * Each authored field's absolute data path in the form's source, and each
 * repeat's iteration path (a query repeat's rows sit under its `item`).
 */
function dataPaths(doc: BlueprintDoc, formUuid: Uuid) {
	const fieldByPath = new Map<string, Uuid>();
	const iterationOf = new Map<Uuid, string>();
	const walk = (parentUuid: Uuid, parentPath: string): void => {
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[fieldUuid];
			if (field === undefined) continue;
			const path = `${parentPath}/${field.id}`;
			fieldByPath.set(path, fieldUuid);
			const childBase =
				field.kind === "repeat" && field.repeat_mode === "query_bound"
					? `${path}/item`
					: path;
			if (field.kind === "repeat") iterationOf.set(fieldUuid, childBase);
			walk(fieldUuid, childBase);
		}
	};
	walk(formUuid, "/data");
	return { fieldByPath, iterationOf };
}

function childTags(node: { children: ChildNode[] }): Element[] {
	return node.children.filter(isTag);
}

function onlyChild(node: { children: ChildNode[] }, name: string): Element {
	const matches = childTags(node).filter((child) => child.name === name);
	if (matches.length !== 1)
		throw new Error(
			`Reading the emitted form source expected one <${name}> and found ${matches.length}.`,
		);
	return matches[0];
}

/** The `<data>` instance and the `<h:body>` of an emitted form source. */
function readSource(xml: string) {
	const html = onlyChild(parseXml(xml), "h:html");
	const model = onlyChild(onlyChild(html, "h:head"), "model");
	const primary = childTags(model).filter(
		(child) => child.name === "instance" && child.attribs.src === undefined,
	);
	if (primary.length !== 1)
		throw new Error(
			`Reading the emitted form source expected one primary instance and found ${primary.length}.`,
		);
	return {
		data: onlyChild(primary[0], "data"),
		body: onlyChild(html, "h:body"),
	};
}

/** Every descendant element with its absolute data path, in document order. */
function elementsWithPaths(root: Element, rootPath: string) {
	const out: { element: Element; path: string }[] = [];
	const walk = (element: Element, path: string): void => {
		for (const child of childTags(element)) {
			const childPath = `${path}/${child.name}`;
			out.push({ element: child, path: childPath });
			walk(child, childPath);
		}
	};
	walk(root, rootPath);
	return out;
}

function descendants(root: Element): Element[] {
	return childTags(root).flatMap((child) => [child, ...descendants(child)]);
}

function isActive(condition: { type: string }): boolean {
	return condition.type !== "never";
}

/** What `main`'s own code derives from one admitted document. */
function deriveFacts(doc: BlueprintDoc): FixtureFacts {
	const hq = expandDoc(doc);
	const hqForms = new Map(
		hq.modules.flatMap((module) =>
			module.forms.map((form) => [form.unique_id, form] as const),
		),
	);
	const placements: Placement[] = [];
	const preloadedWriters: Record<Uuid, Uuid[]> = {};
	const labelledGroups: Uuid[] = [];

	for (const { moduleUuid, formUuid } of formsInOrder(doc)) {
		const module = doc.modules[moduleUuid];
		const form = doc.forms[formUuid];
		const hqForm = hqForms.get(DERIVED_WIRE_IDENTITY.formUniqueId(formUuid));
		const xml = hq._attachments[`${hqForm?.unique_id}.xml`];
		if (hqForm === undefined || typeof xml !== "string")
			throw new Error(
				`The export of form "${form.name}" holds no form source, so its case blocks cannot be read.`,
			);
		const actions = hqForm.actions as FormActions;
		const { fieldByPath, iterationOf } = dataPaths(doc, formUuid);
		const place = (unit: string, emitted: string) =>
			placements.push({ formUuid, unit, emitted });

		// Basic slots: the inventory's buckets, placed where `hqCaseActions`
		// (the actions the export carries) puts each one.
		const inventory = deriveCaseWriteInventory(
			doc,
			formUuid,
			module,
			form.type,
		);
		const childBuckets = inventory.buckets.filter(
			(bucket) => bucket.kind === "child",
		);
		if (childBuckets.length !== actions.subcases.length)
			throw new Error(
				`Form "${form.name}" has ${childBuckets.length} child buckets and its export ${actions.subcases.length} subcases, so the two cannot be paired.`,
			);
		const subcaseUnit = actions.subcases.map((subcase, index) => {
			const bucket = childBuckets[index];
			const repeatContext =
				bucket.repeatUuid === undefined
					? ""
					: iterationOf.get(bucket.repeatUuid);
			if (
				bucket.caseType !== subcase.case_type ||
				repeatContext !== subcase.repeat_context
			)
				throw new Error(
					`Form "${form.name}"'s subcase ${index} (${subcase.case_type} at "${subcase.repeat_context}") does not match its child bucket (${bucket.caseType} at "${repeatContext}").`,
				);
			const kind = subcase.relationship === "extension" ? "extension" : "child";
			return `${kind}:${subcase.case_type}:${bucket.repeatUuid ?? "root"}`;
		});
		const opensOneCase =
			form.type === "registration" ||
			(CASE_LOADING_FORM_TYPES.has(form.type) &&
				caseSelectionCardinality(module) === "single");
		if (
			module.caseType !== undefined &&
			form.type !== "survey" &&
			opensOneCase &&
			(isActive(actions.open_case.condition) ||
				isActive(actions.update_case.condition))
		)
			place("own", "basic-own");
		if (isActive(actions.usercase_update.condition))
			place("usercase", "basic-usercase");
		for (const [index, subcase] of actions.subcases.entries()) {
			if (!isActive(subcase.condition)) continue;
			const sharing = actions.subcases.filter(
				(other) => other.repeat_context === subcase.repeat_context,
			).length;
			place(
				subcaseUnit[index],
				subcase.repeat_context !== "" && sharing === 1
					? "basic-subcase-row"
					: `basic-subcase:${index}`,
			);
		}

		// Save to Case blocks and model-iteration rows, read from the source.
		const source = readSource(xml);
		const nodes = planGeneratedNodes(doc, formUuid);
		const operations = orderedCaseOperations(form);
		const repeats = [...iterationOf].sort(
			([, a], [, b]) => b.length - a.length,
		);
		for (const { element, path } of elementsWithPaths(source.data, "/data")) {
			if (element.attribs["vellum:role"] === "Repeat") {
				// A several-case form's selected-cases repeat is the wrapper its
				// own case's block iterates in: no unit of its own, and the block
				// inside it records the wrapper's path as part of its own.
				const parentPath = path.slice(0, path.lastIndexOf("/"));
				if (element.name === nodes.selectedCases(FormPath.parse(parentPath)))
					continue;
				const repeatUuid = fieldByPath.get(path);
				if (repeatUuid === undefined)
					throw new Error(
						`Form "${form.name}" emits a model-iteration row at ${path} that no question owns.`,
					);
				place(`query-repeat:${repeatUuid}`, `model-iteration:${path}/item`);
				continue;
			}
			if (element.attribs["vellum:role"] !== "SaveToCase") continue;
			const scope = repeats.find(([, base]) => path.startsWith(`${base}/`));
			const scopeUuid = scope?.[0];
			const relative = path.slice((scope?.[1] ?? "/data").length + 1);
			const name = element.name;
			const inScope = operations.filter(
				(operation) => operation.forEach?.repeat === scopeUuid,
			);
			const operation =
				inScope.find((candidate) => candidate.id === name) ??
				inScope.find((candidate) =>
					operationGuardKinds(candidate).some(
						(kind) => nodes.guard(candidate.uuid, kind) === name,
					),
				);
			const scopePath =
				scope === undefined ? undefined : FormPath.parse(scope[1]);
			const subcaseIndex = actions.subcases.findIndex(
				(subcase, index) =>
					subcase.repeat_context === (scope?.[1] ?? "") &&
					(nodes.subcase(index) === name ||
						nodes.subcase(index, scopePath ?? FormPath.root()) === name),
			);
			const unit =
				operation !== undefined
					? `operation:${operation.uuid}`
					: name === nodes.updateSelectedCases()
						? "own"
						: name === nodes.closeSelectedCases() || name === nodes.close()
							? "own-close"
							: subcaseIndex >= 0
								? subcaseUnit[subcaseIndex]
								: undefined;
			if (unit === undefined)
				throw new Error(
					`Form "${form.name}" emits a Save to Case block at ${path} that no case operation, own case or subcase owns.`,
				);
			place(unit, `save-to-case:${scopeUuid ?? "root"}:${relative}`);
		}

		// Preloaded writers, in data-tree order.
		const preloaded = fieldsInDataOrder(doc, formUuid).filter((fieldUuid) => {
			const field = doc.fields[fieldUuid];
			return (
				field !== undefined && writerPreloadsFromLoadedCase(field, module, form)
			);
		});
		if (preloaded.length > 0) preloadedWriters[formUuid] = preloaded;

		// Groups whose label shows: `main`'s builder writes `field-list` on
		// exactly those, and on every section.
		for (const element of descendants(source.body)) {
			if (element.name !== "group") continue;
			if (element.attribs.appearance !== "field-list") continue;
			const fieldUuid = fieldByPath.get(element.attribs.ref ?? "");
			if (fieldUuid === undefined)
				throw new Error(
					`Form "${form.name}" emits a field-list group at "${element.attribs.ref}" that no question owns.`,
				);
			if (doc.fields[fieldUuid]?.kind === "group")
				labelledGroups.push(fieldUuid);
		}
	}

	const searchShapes: Record<
		Uuid,
		"search-first" | "skip-to-results" | "list-first"
	> = {};
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		const search = effectiveCaseSearchConfig(module);
		if (search === undefined || module.caseListConfig === undefined) continue;
		const shape = searchWireShape(module.caseListConfig, search);
		searchShapes[moduleUuid] = shape.inlineSearch
			? "search-first"
			: shape.autoLaunch
				? "skip-to-results"
				: "list-first";
	}

	return { placements, preloadedWriters, labelledGroups, searchShapes };
}

describe("the cutover's pre-step fixtures under main", () => {
	it("admits each pre-step fixture under main's schema and absolute gate", () => {
		expect(fixtureIds.length).toBeGreaterThan(0);
		for (const id of fixtureIds) {
			const parsed = blueprintDocSchema.safeParse(readFixture(id));
			expect(parsed.error?.issues, id).toBeUndefined();
			const verdict = mutationCommitVerdict(
				admittedDoc(id),
				[],
				availableLookupContext([]),
			);
			expect(verdict.ok ? [] : verdict.findings, id).toEqual([]);
		}
	});

	it("records the facts main's own code derives from each fixture", () => {
		const facts: PreStepFacts = {
			format: FACTS_FORMAT,
			fixtures: Object.fromEntries(
				fixtureIds.map((id) => [id, deriveFacts(admittedDoc(id))]),
			),
		};
		if (process.env.NOVA_WRITE_PRE_STEP_FACTS === "1") {
			writeFileSync(FACTS, `${JSON.stringify(facts, null, "\t")}\n`);
			return;
		}
		// The committed bytes are Biome's layout of the same JSON; compared
		// as compact JSON, every key, its order and every value must match.
		expect(JSON.stringify(JSON.parse(readFileSync(FACTS, "utf8")))).toBe(
			JSON.stringify(facts),
		);
	});
});
