/**
 * The reader spells a place as the proof lane spells it.
 *
 * Contract: for every vector of `proof/checks/fixtures/place-vectors.json`,
 * `elementWhere` gives the node's `where` (an element's path by qualified
 * name and position among same-named siblings, an attribute's `/@` name, a
 * default namespace's `/namespace()`), `qualifiedName` the name a namespace
 * and a local name are written as, and the JSON cursor's pointer token the
 * token of a key. A claim on an app JSON object's class or on one of its keys
 * is recorded at the pointer the lane spells that use at (the app's own class
 * at the empty pointer), and a question CommCare HQ's question reader names
 * by its path (an attribute of a Save to Case block's case among them) is the
 * node the reader's path read gives, at the lane's place. The lane's own
 * functions are held to the same file (`proof/checks/test_place_vectors.py`),
 * so the two sides cannot spell one place two ways, which would make the
 * parity join of the reader's claim log with the lane's uses miss.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Document, type Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { inventoryIndex } from "../../surface/inventory";
import { namespaceScopes, qualifiedName } from "../../xmlNamespaces";
import { parseXml } from "../../xmlParse";
import { Accounting } from "../accounting";
import { type Claim, take } from "../claims";
import { type JsonCursor, pointerToken } from "../jsonCursor";
import { appPlace, formPlace } from "../place";
import { readDataTree, readNodePath } from "../xform/model";
import { parseXFormSource } from "../xform/parse";
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
	readonly jsonDocuments: readonly Readonly<Record<string, unknown>>[];
	readonly jsonPlaces: readonly {
		readonly document: number;
		readonly key: string;
		readonly where: string;
	}[];
	readonly questionPlaces: readonly {
		readonly document: number;
		readonly type: string;
		readonly path: string;
		readonly where: string;
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

/** A held claim of `key` under the first entry that holds it. */
function heldClaim(key: string): Claim<"take"> {
	const entry = inventoryIndex()
		.naming(key)
		.find((one) => one.standing === "held");
	if (entry === undefined) throw new Error(`No entry holds ${key}.`);
	return take(entry.id, key);
}

/** The JSON cursor at `where` of a document's root, each list's element of its `doc_type`. */
function cursorAt(root: JsonCursor, where: string): JsonCursor {
	let cursor = root;
	const tokens = where === "" ? [] : where.slice(1).split("/");
	for (let index = 0; index < tokens.length; index += 2) {
		const key = tokens[index] as string;
		const element = Number(tokens[index + 1]);
		const list = cursor.list(
			key,
			(value) => String(value.doc_type),
			heldClaim(`schema:${cursor.cls}.${key}`),
		);
		const next = list[element];
		if (next === undefined) throw new Error(`No element at ${where}.`);
		cursor = next;
	}
	return cursor;
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

	it.each(VECTORS.jsonPlaces)(
		"$key at '$where'",
		({ document, key, where }) => {
			const source = VECTORS.jsonDocuments[document];
			if (source === undefined)
				throw new Error(`No JSON document ${document}.`);
			const ledger = new Accounting(inventoryIndex(), { log: "full" });
			const root = ledger.json(source, appPlace());
			const dot = key.indexOf(".");
			if (dot === -1) {
				// The object's own class, read at its own pointer.
				const cursor = cursorAt(root, where);
				expect(cursor.cls).toBe(key.slice("schema:".length));
				void cursor.takeClass(heldClaim(key)).value;
			} else {
				const cursor = cursorAt(root, where.slice(0, where.lastIndexOf("/")));
				void cursor.take(key.slice(dot + 1), heldClaim(key), (value) => value)
					.value;
			}
			const recorded = [...ledger.close().claims.records()]
				.filter((record) => record.key === key)
				.map((record) => record.where);
			expect(recorded).toEqual([where]);
		},
	);

	it.each(VECTORS.questionPlaces)(
		"$type at $path",
		({ document, path, where }) => {
			const parsed = documents[document];
			if (parsed === undefined) throw new Error(`No document ${document}.`);
			const ledger = new Accounting(inventoryIndex(), { log: "full" });
			const place = formPlace(0, 0, "Menu", "Form");
			const cursor = ledger.xml(parsed, 0, 0, place);
			const data = elementsOf(parsed)
				.flatMap((html) => elementsOf(html))
				.flatMap((head) => elementsOf(head))
				.flatMap((model) => elementsOf(model))
				.flatMap((instance) => elementsOf(instance))[0];
			const xmlns = data?.attribs.xmlns;
			if (xmlns === undefined) throw new Error("No data root.");
			const form = parseXFormSource({
				document: parsed,
				cursor,
				accounting: ledger,
				formPlace: place,
				xmlns,
				intentIds: new Set(),
			});
			if (!("html" in form)) throw new Error("The source was refused.");
			const read = readNodePath(path, readDataTree(form, cursor, place), null);
			if (read.kind !== "node") throw new Error(`${path} names no node.`);
			expect(
				elementWhere(
					read.attribute === undefined
						? { element: read.node.element }
						: { element: read.node.element, attribute: read.attribute },
					namespaceScopes(parsed),
				),
			).toBe(where);
		},
	);
});
