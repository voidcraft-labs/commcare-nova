/**
 * Every form Nova exports stays inside the envelope HQ's form builder keeps
 * on save: what the builder drops, rewrites or refuses is never written. The
 * readers that decide each rule (Vellum's two saves, HQ's build, Core) run in
 * the proof lane; this suite holds Nova's own output, in the form source HQ
 * receives and, where a rule is the runtime's too, in the local archive.
 */

import type { SyntaxNode } from "@lezer/common";
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import { collectOracleInstanceRefs } from "@/lib/commcare/validator/suiteOracle";
import { FormPath } from "@/lib/commcare/xform/formPath";
import { parser } from "@/lib/commcare/xpath/parser";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	projectedModulePreorder,
	type Uuid,
} from "@/lib/domain";
import { formWireName } from "@/lib/domain/formWireName";
import { emissionFixtures } from "./emissionFixtures";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

interface EmittedForm {
	readonly name: string;
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly source: Element[];
	readonly local: Element[];
}

function elementsOf(xml: string): Element[] {
	new SaxesParser({ xmlns: true }).write(xml).close();
	return findAll(() => true, parseDocument(xml, { xmlMode: true }).children);
}

const emitted: EmittedForm[] = emissionFixtures().flatMap(
	({ name, doc, assets }) => {
		const hq = expandDoc(doc, { assets });
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
				assets,
			}),
		);
		// The expander's own module and form order, hidden no-matches modules
		// included: the order HQ's modules and the archive's
		// `modules-<m>/forms-<f>.xml` follow.
		const wire = emissionPlan(doc).doc;
		return projectedModulePreorder(wire).flatMap((moduleUuid, moduleIndex) =>
			orderedFormUuids(wire, moduleUuid).map((formUuid, formIndex) => {
				const unique = hq.modules[moduleIndex].forms[formIndex].unique_id;
				const source = hq._attachments[`${unique}.xml`];
				if (typeof source !== "string")
					throw new Error(`${name} holds no source for its form ${unique}.`);
				return {
					name: `${name} m${moduleIndex} f${formIndex}`,
					formUuid,
					doc,
					source: elementsOf(source),
					local: elementsOf(
						zip.readAsText(`modules-${moduleIndex}/forms-${formIndex}.xml`),
					),
				};
			}),
		);
	},
);

const binds = (elements: Element[]) =>
	elements.filter((element) => element.name === "bind");

const steps = (nodeset: string | undefined) => (nodeset ?? "").split("/");

/** Every XPath expression a form's model and body carry. */
function expressions(elements: Element[]): string[] {
	const out: string[] = [];
	for (const element of elements) {
		const names =
			element.name === "bind"
				? ["calculate", "relevant", "required", "constraint"]
				: element.name === "setvalue" || element.name === "output"
					? ["value"]
					: [];
		for (const name of names) {
			const value = element.attribs[name];
			if (value !== undefined && value !== "") out.push(value);
		}
	}
	return out;
}

/** Whether `source` holds a path node whose text is exactly `path`. */
function holdsPath(source: string, path: string): boolean {
	let found = false;
	parser.parse(source).iterate({
		enter(cursor) {
			if (found) return false;
			if (
				(cursor.name === "Child" || cursor.name === "Descendant") &&
				source.slice(cursor.from, cursor.to) === path
			)
				found = true;
		},
	});
	return found;
}

/** The namespaces of every hashtag in `source`. */
function hashtagNamespaces(source: string): string[] {
	const out: string[] = [];
	parser.parse(source).iterate({
		enter(cursor) {
			if (cursor.name !== "HashtagRef") return;
			const type: SyntaxNode | null = cursor.node.getChild("HashtagType");
			if (type !== null) out.push(source.slice(type.from, type.to));
			return false;
		},
	});
	return out;
}

/**
 * The one-step `.` paths of `source` that stand inside a predicate: a
 * `SelfStep` that is a path of its own, not one step of a longer one, and
 * lies in the bracketed part of a `Filtered` expression.
 */
function predicateSelfSteps(source: string): string[] {
	const out: string[] = [];
	parser.parse(source).iterate({
		enter(cursor) {
			if (cursor.name !== "SelfStep") return;
			const node = cursor.node;
			if (node.parent?.name === "Child" || node.parent?.name === "Descendant")
				return;
			let child: SyntaxNode = node;
			for (let up = node.parent; up !== null; up = up.parent) {
				if (up.name === "Filtered" && child.from >= (up.firstChild?.to ?? 0)) {
					out.push(source);
					return;
				}
				child = up;
			}
		},
	});
	return out;
}

/**
 * Every `calculate`, `relevant` and `required` of a bind and every setvalue's
 * `value`: the carriers where HQ's form builder reads a bare `.` as the
 * question itself. A `constraint` is left out, where `.` is the answer.
 */
function selfReadingCarriers(elements: Element[]): string[] {
	const out: string[] = [];
	for (const element of elements) {
		const names =
			element.name === "bind"
				? ["calculate", "relevant", "required"]
				: element.name === "setvalue"
					? ["value"]
					: [];
		for (const name of names) {
			const value = element.attribs[name];
			if (value !== undefined && value !== "") out.push(value);
		}
	}
	return out;
}

const CASE_TRANSACTION = "http://commcarehq.org/case/transaction/v2";

/** The form's primary instance root. */
function dataRoot(elements: Element[]): Element {
	const data = elements.find(
		(element) =>
			element.name === "data" &&
			element.parent !== null &&
			isTag(element.parent) &&
			element.parent.name === "instance" &&
			element.parent.attribs.src === undefined,
	);
	if (data === undefined)
		throw new Error("The form holds no primary instance.");
	return data;
}

/** The data element a structural `/data/...` path names, if any. */
function resolve(data: Element, path: string): Element | undefined {
	let target: FormPath;
	try {
		target = FormPath.parse(path);
	} catch {
		return undefined;
	}
	let node: Element | undefined = data;
	for (const segment of target.segments().slice(1)) {
		if (segment.kind === "attribute") break;
		node = node?.children
			.filter(isTag)
			.find((element) => element.name === segment.name);
	}
	return node;
}

/** A model-iteration row stands for its repeat in HQ's form builder. */
function editorNode(node: Element): Element {
	const parent = node.parent;
	return node.name === "item" &&
		parent !== null &&
		isTag(parent) &&
		parent.attribs.ids !== undefined
		? parent
		: node;
}

/** The data parent HQ's form builder gives a node. */
function editorParent(node: Element): Element | undefined {
	const parent = node.parent;
	return parent !== null && isTag(parent) ? editorNode(parent) : undefined;
}

/** Every body control with the data node it names. */
function controls(elements: Element[]): { control: Element; node: Element }[] {
	const data = dataRoot(elements);
	const body = elements.find((element) => element.name === "h:body");
	return findAll(() => true, body?.children ?? []).flatMap((control) => {
		const path =
			control.name === "repeat" ? control.attribs.nodeset : control.attribs.ref;
		if (path === undefined || !path.startsWith("/data/")) return [];
		const node = resolve(data, path);
		if (node === undefined)
			throw new Error(
				`The control ${control.name} names ${path}, which the data tree does not hold.`,
			);
		return [{ control, node: editorNode(node) }];
	});
}

describe.each(emitted)("$name", (form) => {
	it("writes no constraint on a case-block leaf, in the source or the local archive", () => {
		for (const elements of [form.source, form.local]) {
			expect(
				binds(elements)
					.filter((bind) => bind.attribs.constraint !== undefined)
					.filter((bind) => steps(bind.attribs.nodeset).includes("case"))
					.map((bind) => bind.attribs.nodeset),
			).toEqual([]);
		}
	});

	it("writes no type on a create or update leaf of a Save to Case block", () => {
		expect(
			binds(form.source)
				.filter((bind) => bind.attribs.type !== undefined)
				.filter((bind) => {
					const path = steps(bind.attribs.nodeset);
					return path.some(
						(step, index) =>
							step === "case" &&
							(path[index + 1] === "update" || path[index + 1] === "create"),
					);
				})
				.map((bind) => bind.attribs.nodeset),
		).toEqual([]);
	});

	it("never reads the build's own case block for the registered case's id", () => {
		expect(
			expressions(form.source).filter((source) =>
				holdsPath(source, "/data/case/@case_id"),
			),
		).toEqual([]);
	});

	it("declares the session instance wherever it reads the session", () => {
		for (const elements of [form.source, form.local]) {
			const reads = expressions(elements).some((source) =>
				collectOracleInstanceRefs(source).has("commcaresession"),
			);
			const declared = elements.some(
				(element) =>
					element.name === "instance" &&
					element.attribs.id === "commcaresession",
			);
			if (reads) expect(declared).toBe(true);
		}
	});

	it("wraps every repeat in a group with no ref", () => {
		for (const elements of [form.source, form.local]) {
			for (const repeat of elements.filter((e) => e.name === "repeat")) {
				const wrapper = repeat.parent;
				if (wrapper !== null && isTag(wrapper) && wrapper.name === "group")
					expect(wrapper.attribs.ref).toBeUndefined();
			}
		}
	});

	it("carries #form/ alone in its shadows and no head hashtag maps", () => {
		expect(
			form.source.filter(
				(element) =>
					element.name === "vellum:hashtags" ||
					element.name === "vellum:hashtagTransforms",
			),
		).toEqual([]);
		for (const element of form.source) {
			for (const [name, value] of Object.entries(element.attribs)) {
				if (
					!name.startsWith("vellum:") ||
					name === "vellum:role" ||
					name === "vellum:case_type"
				)
					continue;
				expect(
					hashtagNamespaces(value).filter((namespace) => namespace !== "form"),
				).toEqual([]);
			}
		}
	});

	it("gives a default no shadow and a Hidden Value no required", () => {
		const body = form.source.find((element) => element.name === "h:body");
		const controlled = new Set(
			findAll(() => true, body?.children ?? []).flatMap((control) =>
				control.attribs.ref === undefined ? [] : [control.attribs.ref],
			),
		);
		expect(
			form.source
				.filter((element) => element.name === "setvalue")
				.filter((setvalue) => setvalue.attribs["vellum:value"] !== undefined),
		).toEqual([]);
		expect(
			binds(form.source)
				.filter((bind) => bind.attribs.required !== undefined)
				.filter((bind) => !controlled.has(bind.attribs.nodeset))
				.map((bind) => bind.attribs.nodeset),
		).toEqual([]);
	});

	it("spells a predicate's own node `./.` in every calculate, relevant, required and setvalue", () => {
		for (const elements of [form.source, form.local]) {
			expect(selfReadingCarriers(elements).flatMap(predicateSelfSteps)).toEqual(
				[],
			);
		}
	});

	it("lists each parent's controls in the order its data holds them", () => {
		for (const elements of [form.source, form.local]) {
			const named = controls(elements);
			const byParent = new Map<Element, Element[]>();
			for (const { node } of named) {
				const parent = editorParent(node);
				if (parent === undefined) continue;
				byParent.set(parent, [...(byParent.get(parent) ?? []), node]);
			}
			for (const [parent, inBody] of byParent) {
				const controlled = new Set(inBody);
				const inData = parent.children.filter(isTag).flatMap((child) => {
					if (controlled.has(child)) return [child];
					// A model-iteration row's children are its repeat's.
					return child.name === "item" && editorNode(child) === parent
						? child.children.filter(
								(row): row is Element => isTag(row) && controlled.has(row),
							)
						: [];
				});
				expect(inBody.map((node) => node.name)).toEqual(
					inData.map((node) => node.name),
				);
			}
		}
	});

	it("puts each control inside its data parent's control", () => {
		for (const elements of [form.source, form.local]) {
			const named = controls(elements);
			const nodeOf = new Map(named.map(({ control, node }) => [control, node]));
			for (const { control, node } of named) {
				let up = control.parent;
				while (up !== null && isTag(up) && !nodeOf.has(up)) up = up.parent;
				const parentControlNode =
					up !== null && isTag(up) ? nodeOf.get(up) : dataRoot(elements);
				expect(editorParent(node)).toBe(parentControlNode);
			}
		}
	});

	it("writes setvalues in the order their targets stand in the data tree", () => {
		for (const elements of [form.source]) {
			const order = new Map<Element, number>();
			for (const node of findAll(() => true, [dataRoot(elements)]))
				order.set(node, order.size);
			const data = dataRoot(elements);
			const positions = elements
				.filter((element) => element.name === "setvalue")
				.map((setvalue) => {
					const target = resolve(data, setvalue.attribs.ref ?? "");
					return target === undefined ? -1 : (order.get(target) ?? -1);
				});
			expect(positions).not.toContain(-1);
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
		}
	});

	it("never names a node inside a case block by an absolute path", () => {
		const data = dataRoot(form.source);
		const insideBlock = (path: string): boolean => {
			let target: FormPath;
			try {
				target = FormPath.parse(path);
			} catch {
				return false;
			}
			let node: Element | undefined = data;
			for (const segment of target.segments().slice(1)) {
				if (segment.kind === "attribute" || node === undefined) break;
				node = node.children
					.filter(isTag)
					.find((element) => element.name === segment.name);
				if (node?.name === "case" && node.attribs.xmlns === CASE_TRANSACTION)
					return true;
			}
			return false;
		};
		const absolute: string[] = [];
		for (const source of expressions(form.source)) {
			parser.parse(source).iterate({
				enter(cursor) {
					if (cursor.name !== "Child" && cursor.name !== "Descendant") return;
					const path = source.slice(cursor.from, cursor.to);
					if (path.startsWith("/data/")) absolute.push(path);
					return false;
				},
			});
		}
		expect(absolute.filter(insideBlock)).toEqual([]);
	});

	it("names the form by its default-language name in the title and the data node", () => {
		const title = form.source.find((element) => element.name === "h:title");
		const data = form.source.find(
			(element) =>
				element.name === "data" &&
				element.parent !== null &&
				isTag(element.parent) &&
				element.parent.name === "instance" &&
				element.parent.attribs.src === undefined,
		);
		const name = formWireName(form.doc, form.formUuid);
		expect(title === undefined ? undefined : textContent(title)).toBe(name);
		expect(data?.attribs.name).toBe(name);
	});
});

it("walks forms that hold each shape the rules above read", () => {
	const some = (test: (elements: Element[]) => boolean) =>
		emitted.some((form) => test(form.source));
	expect(some((elements) => elements.some((e) => e.name === "repeat"))).toBe(
		true,
	);
	expect(
		some((elements) =>
			binds(elements).some((bind) =>
				steps(bind.attribs.nodeset).includes("case"),
			),
		),
	).toBe(true);
	expect(
		some((elements) =>
			expressions(elements).some((source) =>
				collectOracleInstanceRefs(source).has("commcaresession"),
			),
		),
	).toBe(true);
	expect(some((elements) => elements.some((e) => e.name === "setvalue"))).toBe(
		true,
	);
	expect(
		some((elements) =>
			selfReadingCarriers(elements).some((source) => {
				let spelled = false;
				parser.parse(source).iterate({
					enter(cursor) {
						if (
							cursor.name === "Child" &&
							source.slice(cursor.from, cursor.to) === "./."
						)
							spelled = true;
					},
				});
				return spelled;
			}),
		),
	).toBe(true);
	expect(
		emitted.some((form) =>
			binds(form.local).some((bind) =>
				steps(bind.attribs.nodeset).includes("case"),
			),
		),
	).toBe(true);
});
