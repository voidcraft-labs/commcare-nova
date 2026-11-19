/**
 * No unknown construct in a form is admitted. Over the forms CommCare HQ
 * served for the retained apps, the Nova export after each of HQ's own pages
 * saved it among them, one unknown attribute is planted on one
 * element of each qualified name, and one unknown element under each element
 * of the form's frame and body (never in the data tree, where an element is a
 * question): each planted node is reported `unrecognized` by its name, or lies
 * under a node a claim covers whose entry holds nothing (a refusal, or content
 * read past as inert). A planted node a held claim covers is admitted, and
 * fails here.
 */

import { type Document, Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { serializeXml } from "../../../serializeXml";
import { isElement, namespaceScopes, XFORMS_NS } from "../../../xmlNamespaces";
import { parseXml } from "../../../xmlParse";
import {
	closeAfterStructure,
	readContext,
	readerInput,
	retainedSaveReads,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readApplication } from "../../appShell";
import type { ReadContext } from "../../context";
import { readStructure } from "../../structure";
import { elementWhere, qualifiedElement } from "../../xmlCursor";
import { readForms } from "../index";

const APPS = [
	"hq-built/app-source",
	"navigation-base/app-source",
	"case-list-inline/app-source",
	...retainedSaveReads(),
];

interface Planted {
	readonly artifact: string;
	readonly name: string;
	/** The planted node, then each ancestor, nearest first: its `where` and its name. */
	readonly chain: readonly { readonly where: string; readonly name: string }[];
}

function elements(document: Document): Element[] {
	const all: Element[] = [];
	const walk = (node: Document | Element) => {
		for (const child of node.children)
			if (isTag(child)) {
				all.push(child);
				walk(child);
			}
	};
	walk(document);
	return all;
}

function ancestors(element: Element): Element[] {
	const list: Element[] = [];
	for (let at = element.parent; at !== null && isTag(at); at = at.parent)
		list.push(at);
	return list;
}

/** Whether an element is the primary instance or under it: the data tree, where an element is a
 *  question of its own. */
function inDataTree(
	element: Element,
	scope: ReturnType<typeof namespaceScopes>,
): boolean {
	return [element, ...ancestors(element)].some(
		(at) =>
			isElement(at, scope(at), XFORMS_NS, "instance") &&
			at.attribs.id === undefined,
	);
}

/** Plants one unknown attribute, or one unknown element, at each qualified name of a source. */
function plant(
	source: string,
	artifact: string,
	kind: "attribute" | "element",
	counter: { n: number },
): { readonly source: string; readonly planted: readonly Planted[] } {
	const document = parseXml(source);
	const scope = namespaceScopes(document);
	const seen = new Set<string>();
	const targets: Element[] = [];
	for (const element of elements(document)) {
		const name = qualifiedElement(element, scope(element));
		if (seen.has(name)) continue;
		if (kind === "element" && inDataTree(element, scope)) continue;
		seen.add(name);
		targets.push(element);
	}
	const plantedNodes: {
		readonly element: Element;
		readonly attribute?: string;
	}[] = [];
	for (const element of targets) {
		counter.n += 1;
		const name = `nova-planted-${counter.n}`;
		if (kind === "attribute") {
			element.attribs[name] = "x";
			plantedNodes.push({ element, attribute: name });
		} else {
			const child = new Element(name, {});
			child.parent = element;
			element.children.push(child);
			plantedNodes.push({ element: child });
		}
	}
	const text = serializeXml(document);
	const reparsed = parseXml(text);
	const again = namespaceScopes(reparsed);
	const byName = new Map<string, Element>();
	for (const element of elements(reparsed)) {
		byName.set(element.name, element);
		for (const attribute of Object.keys(element.attribs))
			if (attribute.startsWith("nova-planted-")) byName.set(attribute, element);
	}
	const planted = plantedNodes.map(({ element, attribute }) => {
		const name = attribute ?? element.name;
		const at = byName.get(name) as Element;
		const node =
			attribute === undefined ? { element: at } : { element: at, attribute };
		const ownName =
			attribute === undefined
				? `xform:${qualifiedElement(at, again(at))}`
				: `xform:${qualifiedElement(at, again(at))}@${attribute}`;
		return {
			artifact,
			name: ownName,
			chain: [
				{ where: elementWhere(node, again), name: ownName },
				...(attribute === undefined ? [] : [at]).map((element) => ({
					where: elementWhere({ element }, again),
					name: `xform:${qualifiedElement(element, again(element))}`,
				})),
				...ancestors(at).map((up) => ({
					where: elementWhere({ element: up }, again),
					name: `xform:${qualifiedElement(up, again(up))}`,
				})),
			],
		};
	});
	return { source: text, planted };
}

async function readPlanted(file: string, kind: "attribute" | "element") {
	const body = retainedSourceBody(file);
	const modules = body.modules as { forms: { unique_id: string }[] }[];
	const attachments = { ...(body._attachments as Record<string, string>) };
	const counter = { n: 0 };
	const planted: Planted[] = [];
	for (const [m, menu] of modules.entries())
		for (const [f, form] of menu.forms.entries()) {
			const key = `${form.unique_id}.xml`;
			const source = attachments[key];
			if (typeof source !== "string") continue;
			const result = plant(source, `form:${m}.${f}`, kind, counter);
			attachments[key] = result.source;
			planted.push(...result.planted);
		}
	const ctx: ReadContext = readContext(
		readerInput(await sourceFromBody({ ...body, _attachments: attachments })),
	);
	readApplication(ctx);
	readStructure(ctx);
	readForms(ctx);
	return { planted, closed: closeAfterStructure(ctx) };
}

/**
 * Each planted node an account admits: no `unrecognized` finding names it or an unclaimed node
 * above it, and the nearest node above it that a claim holds is held, so a held claim covers it.
 */
function admitted(
	planted: readonly Planted[],
	closed: ReturnType<ReadContext["close"]>,
): string[] {
	const reported = new Set(
		closed.findings
			.filter((finding) => finding.code === "unrecognized")
			.map((finding) => finding.detail.name),
	);
	// A hashtag a head map's text names is a use of that text, claimed at the map beside the claim
	// that covers it: it holds nothing under the map.
	const records = [...closed.claims.records()].filter(
		(record) => !record.key?.startsWith("hashtag:"),
	);
	return planted
		.filter((node) => {
			for (const at of node.chain) {
				const held = records.filter(
					(record) =>
						record.artifact === node.artifact && record.where === at.where,
				);
				if (held.length > 0)
					return (
						held.some((record) => record.standing === "held") &&
						!reported.has(node.name)
					);
				if (reported.has(at.name)) return false;
			}
			return true;
		})
		.map((node) => `${node.artifact} ${node.chain[0]?.where}`);
}

describe("an unknown construct planted in a form HQ served", () => {
	for (const file of APPS) {
		it(`is never admitted, as an attribute, in ${file}`, async () => {
			const { planted, closed } = await readPlanted(file, "attribute");
			expect(planted.length).toBeGreaterThan(10);
			expect(admitted(planted, closed)).toEqual([]);
		});
		it(`is never admitted, as an element, in ${file}`, async () => {
			const { planted, closed } = await readPlanted(file, "element");
			expect(planted.length).toBeGreaterThan(5);
			expect(admitted(planted, closed)).toEqual([]);
		});
	}
});
