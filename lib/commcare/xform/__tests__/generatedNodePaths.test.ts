/**
 * `generatedNodePaths` places each generated node where the XForm builder
 * writes it.
 *
 * Contract: over the compiler's fuzz corpora, with and without an attachment
 * target, every path `generatedNodePaths` gives is a leaf of the emitted
 * form's data tree whose name is the node's; and every leaf of that tree
 * named `nova_`, outside the case and Connect regions and other than a
 * question, is one of its paths.
 *
 * The plausible failure is a generated node cut from neither side of the
 * identity comparison: a node the plan reserves and the builder does not
 * write (a count that needs no node, a link no case change reads), which
 * the comparison would call a phantom, or a node the builder writes that
 * the paths miss, which it would report as an added answer.
 */
import type { Element } from "domhandler";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	caseCaptureFixture,
	caseCaptureScenarios,
} from "@/lib/commcare/__tests__/caseCaptureFixture";
import {
	caseOperationFixture,
	operationScenarios,
} from "@/lib/commcare/__tests__/caseOperationFixture";
import {
	assertGenerated,
	manifestFor,
} from "@/lib/commcare/__tests__/compilerEvidence";
import {
	constraintMessageFixture,
	constraintMessageScenarios,
} from "@/lib/commcare/__tests__/constraintMessageFixture";
import {
	extensionCaseFixture,
	extensionScenarios,
} from "@/lib/commcare/__tests__/extensionCaseFixture";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { expandDoc } from "@/lib/commcare/expander";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import {
	elementChildren,
	isElement,
	type NamespaceScope,
	splitName,
	XFORMS_NS,
	XHTML_NS,
} from "@/lib/commcare/xmlNamespaces";
import { parseXml } from "@/lib/commcare/xmlParse";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import type { AttachmentUrlTarget } from "../captureUrlNode";
import { collectFieldLocations } from "../caseOps";
import {
	type GeneratedNodePurpose,
	generatedNodePaths,
} from "../generatedNodes";
import { inRegion, regionRoots } from "./formRegions";

const TARGET: AttachmentUrlTarget = {
	origin: "https://www.commcarehq.org",
	domain: "fuzz-space",
};

interface Scoped {
	readonly element: Element;
	readonly scope: NamespaceScope;
}

/** Every element of the form's data tree by absolute path, and whether it is a leaf. */
function dataTree(xml: string): ReadonlyMap<string, boolean> {
	const [html] = elementChildren(parseXml(xml).children, new Map());
	if (html === undefined) throw new Error("The form has no root.");
	const child = (parent: Scoped, uri: string, local: string): Scoped => {
		const found = elementChildren(parent.element.children, parent.scope).find(
			({ element, scope }) => isElement(element, scope, uri, local),
		);
		if (found === undefined)
			throw new Error(`The form has no ${local} where one stands.`);
		return found;
	};
	const instance = elementChildren(
		child(child(html, XHTML_NS, "head"), XFORMS_NS, "model").element.children,
		child(child(html, XHTML_NS, "head"), XFORMS_NS, "model").scope,
	).find(
		({ element, scope }) =>
			isElement(element, scope, XFORMS_NS, "instance") &&
			element.attribs.id === undefined,
	);
	const [root] =
		instance === undefined
			? []
			: elementChildren(instance.element.children, instance.scope);
	if (root === undefined) throw new Error("The form has no data root.");
	const tree = new Map<string, boolean>();
	const walk = (parent: Scoped, path: string): void => {
		for (const next of elementChildren(parent.element.children, parent.scope)) {
			const nextPath = `${path}/${splitName(next.element.name).local}`;
			const children = elementChildren(next.element.children, next.scope);
			tree.set(nextPath, children.length === 0);
			walk(next, nextPath);
		}
	};
	walk(root, "/data");
	return tree;
}

function placesEveryNode(
	doc: BlueprintDoc,
	seen: Set<GeneratedNodePurpose>,
): void {
	rebuildFieldParent(doc);
	for (const attachmentTarget of [null, TARGET]) {
		const hq = expandDoc(doc, { assets: manifestFor(doc), attachmentTarget });
		for (const form of Object.values(doc.forms)) {
			const xml =
				hq._attachments[`${DERIVED_WIRE_IDENTITY.formUniqueId(form.uuid)}.xml`];
			if (typeof xml !== "string")
				throw new Error(`The emission holds no source of form ${form.uuid}.`);
			const tree = dataTree(xml);
			const paths = generatedNodePaths(doc, form.uuid, attachmentTarget);
			for (const [path, node] of paths) {
				seen.add(node.purpose);
				expect({ path, leaf: tree.get(path) }).toEqual({ path, leaf: true });
				expect(path.slice(path.lastIndexOf("/") + 1)).toBe(node.name);
			}
			const questions = new Set(
				[...collectFieldLocations(doc, form.uuid).values()].map((location) =>
					location.path.toXPath(),
				),
			);
			const regions = regionRoots(doc, form.uuid);
			const unplaced = [...tree]
				.filter(
					([path, leaf]) =>
						leaf &&
						path.slice(path.lastIndexOf("/") + 1).startsWith("nova_") &&
						!questions.has(path) &&
						!inRegion(path, regions),
				)
				.map(([path]) => path)
				.filter((path) => !paths.has(path));
			expect(unplaced).toEqual([]);
		}
	}
}

describe("generatedNodePaths", () => {
	it("places each generated node beside the content as the builder writes it, over the fuzz corpora", {
		timeout: 120_000,
	}, () => {
		const seen = new Set<GeneratedNodePurpose>();
		const holds = (doc: BlueprintDoc) => placesEveryNode(doc, seen);
		assertGenerated(fc.property(blueprintDocArbitrary, holds), {
			seed: 20261115,
			numRuns: 60,
		});
		assertGenerated(fc.property(suiteDocArbitrary, holds), {
			seed: 20261115,
			numRuns: 60,
		});
		expect([...seen]).toEqual(
			expect.arrayContaining([
				"count",
				"query-ids",
				"query-count",
				"query-id",
				"query-index",
				"trimmed",
			]),
		);
	});

	it("places the nodes the corpora do not draw: a link, a protected message, an owner, and none of the case region's", () => {
		const seen = new Set<GeneratedNodePurpose>();
		for (const scenario of caseCaptureScenarios)
			placesEveryNode(caseCaptureFixture(scenario), seen);
		for (const scenario of constraintMessageScenarios)
			placesEveryNode(constraintMessageFixture(scenario).doc, seen);
		for (const scenario of operationScenarios)
			placesEveryNode(caseOperationFixture(scenario), seen);
		for (const scenario of extensionScenarios)
			placesEveryNode(extensionCaseFixture(scenario), seen);
		expect([...seen]).toEqual(
			expect.arrayContaining([
				"constraint-message",
				"datetime",
				"owner",
				"trimmed",
				"url",
			]),
		);
		// The case region's nodes are compared as the blocks they stand with.
		for (const purpose of [
			"keyed",
			"keyed-count",
			"condition",
			"guard",
			"instant",
		] as const)
			expect(seen.has(purpose)).toBe(false);
	});
});
