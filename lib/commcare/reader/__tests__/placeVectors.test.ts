/**
 * The reader spells a place as the proof lane spells it.
 *
 * Contract: for every vector of `proof/checks/fixtures/place-vectors.json`,
 * `elementWhere` gives the node's `where` (an element's path by qualified
 * name and position among same-named siblings, an attribute's `/@` name, a
 * default namespace's `/namespace()`), `qualifiedName` the name a namespace
 * and a local name are written as, and the JSON cursor's pointer token the
 * token of a key. The lane's own functions are held to the same file
 * (`proof/checks/test_place_vectors.py`), so the two sides cannot spell one
 * place two ways, which would make the parity join of the reader's claim log
 * with the lane's uses miss.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Document, type Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { namespaceScopes, qualifiedName } from "../../xmlNamespaces";
import { parseXml } from "../../xmlParse";
import { pointerToken } from "../jsonCursor";
import { elementWhere } from "../xmlCursor";

interface PlaceVectors {
	readonly documents: readonly string[];
	readonly nodes: readonly {
		readonly document: number;
		readonly path: readonly number[];
		readonly attribute: string | null;
		readonly where: string;
	}[];
	readonly qualified: readonly {
		readonly namespace: string | null;
		readonly local: string;
		readonly name: string;
	}[];
	readonly pointerTokens: readonly {
		readonly key: string;
		readonly token: string;
	}[];
}

const VECTORS = JSON.parse(
	readFileSync(
		join(process.cwd(), "proof/checks/fixtures/place-vectors.json"),
		"utf8",
	),
) as PlaceVectors;

function elementsOf(parent: Document | Element): Element[] {
	return parent.children.filter(isTag);
}

describe("place vectors", () => {
	const documents = VECTORS.documents.map((xml) => parseXml(xml));

	it.each(VECTORS.nodes)("$where", ({ document, path, attribute, where }) => {
		const parsed = documents[document];
		if (parsed === undefined) throw new Error(`No document ${document}.`);
		let element = elementsOf(parsed)[0];
		for (const index of path) element = element && elementsOf(element)[index];
		if (element === undefined) throw new Error(`No element at ${path}.`);
		if (attribute !== null)
			expect(Object.hasOwn(element.attribs, attribute)).toBe(true);
		expect(
			elementWhere(
				attribute === null ? { element } : { element, attribute },
				namespaceScopes(parsed),
			),
		).toBe(where);
	});

	it.each(VECTORS.qualified)("$name", ({ namespace, local, name }) => {
		expect(qualifiedName(namespace, local)).toBe(name);
	});

	it.each(VECTORS.pointerTokens)("$key", ({ key, token }) => {
		expect(pointerToken(key)).toBe(token);
	});
});
