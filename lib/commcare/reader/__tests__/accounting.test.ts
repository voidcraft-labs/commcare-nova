/**
 * The accounting that makes admission a property of the reader's code.
 *
 * Contract: every JSON key at a value other than HQ's default and every XML
 * element and attribute a reading meets is either claimed under a manifest
 * entry whose standing permits the use, covered by a finding, or handed off to
 * project data; whatever is left at the close is one `unrecognized` finding at
 * its place, named by its surface key, and a value a `take` admitted must be
 * read. Each case here plants one failure over a hand-built object or
 * document and names it: a used key that passes unclaimed, a default-valued
 * or absent key counted as a use, a held value dropped after `take`, a second
 * claim, `refuseWhole` leaking a nested `unrecognized`, a handed-off node
 * reported or missing from `handOffs`, `finding` accepted under a held entry,
 * a list of strings claimed per element, `claimEntry` refused under another
 * key or accepted twice under one, a covered node reported again, and the
 * XML rules (an unclaimed element collapsing what it holds, a default
 * namespace that is a construct, stray text, comments dropped).
 */

import type { Document, Element } from "domhandler";
import { isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import type { ReadStanding } from "@/lib/publish/hqFindings";
import { loadManifest } from "../../surface/__tests__/loadManifest";
import { inventoryIndex } from "../../surface/inventory";
import { standingOf } from "../../surface/standing";
import { parseXml } from "../../xmlParse";
import { Accounting, serializeClaimLog } from "../accounting";
import { account, defineClaims, derived, drop, refuse, take } from "../claims";
import { appPlace, formPlace } from "../place";

const MANIFEST = loadManifest();

/** An entry of the standing, the first in file order. */
function entryOf(standing: ReadStanding): string {
	const found = MANIFEST.inventory.find(
		(entry) => standingOf(entry) === standing,
	);
	if (found === undefined)
		throw new Error(`The manifest holds no ${standing} entry to claim under.`);
	return found.id;
}

const HELD = entryOf("held");
const INERT = entryOf("inert");
const NOT_YET = entryOf("not-yet");

const CLAIMS = defineClaims("accountingTest", {
	name: take(HELD, "schema:Application.name"),
	nameAgain: take(HELD, "schema:Application.name"),
	container: derived(HELD, null),
	dropped: drop(INERT, null),
	refused: refuse(NOT_YET, null),
	accounted: account(NOT_YET, null),
	heldRelation: refuse(HELD, null),
	heldDrop: drop(HELD, null),
	element: derived(HELD, null),
	subtree: drop(INERT, null),
});

const APP = appPlace();
const FORM = formPlace(0, 0, "Visits", "Register");

function accounting(): Accounting {
	return new Accounting(inventoryIndex(), { log: "full" });
}

function unrecognized(
	findings: readonly { code: string; detail: { name?: string } }[],
) {
	return findings
		.filter((finding) => finding.code === "unrecognized")
		.map((finding) => finding.detail.name);
}

describe("the JSON cursor", () => {
	it("reports a used key no claim reaches, declared or not, and nothing at its default", () => {
		const books = accounting();
		books.json(
			{ name: "Visits", planted_key: 1, cloudcare_enabled: false, langs: [] },
			APP,
		);
		const { findings } = books.close();
		expect(unrecognized(findings)).toEqual([
			"schema:Application.name",
			"Application.planted_key",
		]);
	});

	it("records no use for an absent declared key and hands out its default", () => {
		const books = accounting();
		const root = books.json({}, APP);
		expect(root.used("name")).toBe(false);
		expect(root.take("name", CLAIMS.name, (value) => value).value).toBeNull();
		const { findings, claims } = books.close();
		expect(findings).toEqual([]);
		expect([...claims.records()]).toEqual([]);
	});

	it("requires a held value to be read", () => {
		const books = accounting();
		books.json({ name: "Visits" }, APP).take("name", CLAIMS.name, String);
		const { findings, defects } = books.close();
		expect(unrecognized(findings)).toEqual(["schema:Application.name"]);
		expect(defects.map((defect) => defect.why)).toEqual([
			"claimed and not read at app: accountingTest.name",
		]);
	});

	it("keeps the first of two claims on one key and records the second as a defect", () => {
		const books = accounting();
		const root = books.json({ name: "Visits" }, APP);
		expect(root.take("name", CLAIMS.name, String).value).toBe("Visits");
		root.take("name", CLAIMS.nameAgain, String);
		const { findings, defects, claims } = books.close();
		expect(unrecognized(findings)).toEqual(["schema:Application.name"]);
		expect(defects).toEqual([
			{
				place: APP,
				name: "schema:Application.name",
				why: "claimed twice at app: first by accountingTest.name, then by accountingTest.nameAgain",
			},
		]);
		expect(claims.counts).toEqual({ [HELD]: 1 });
	});

	it("covers every key below an object refused whole, children opened before and after", () => {
		const books = accounting();
		const root = books.json(
			{
				build_spec: { version: "2.53.0", deep: { planted: true } },
			},
			APP,
		);
		const spec = root.object("build_spec", "BuildSpec", CLAIMS.container);
		const deep = spec.object("deep", "Planted", CLAIMS.container);
		spec.refuseWhole(CLAIMS.refused);
		deep.object("later", "Planted", CLAIMS.container);
		const { findings } = books.close();
		expect(unrecognized(findings)).toEqual([]);
		expect(findings.map((finding) => finding.code)).toEqual([NOT_YET]);
	});

	it("claims a list of strings once, at the list", () => {
		const books = accounting();
		const root = books.json({ langs: ["en", "fra"] }, APP);
		expect(root.list("langs", "StringProperty", CLAIMS.container)).toEqual([]);
		const { findings, claims } = books.close();
		expect(findings).toEqual([]);
		expect([...claims.records()]).toEqual([
			{
				artifact: "app.json",
				where: "/langs",
				key: null,
				entry: HELD,
				standing: "held",
			},
		]);
	});

	it("leaves a used container of another shape unclaimed", () => {
		const books = accounting();
		const root = books.json({ modules: "not a list" }, APP);
		expect(root.list("modules", "Module", CLAIMS.container)).toEqual([]);
		expect(unrecognized(books.close().findings)).toEqual([
			"schema:Application.modules",
		]);
	});

	it("lists a hand-off and reports nothing for it", () => {
		const books = accounting();
		books
			.json({ logo_refs: { hq_logo_android_home: {} } }, APP)
			.handOff("logo_refs", "media-reference", "jr://file/commcare/logo.png");
		const { findings, claims } = books.close();
		expect(findings).toEqual([]);
		expect(claims.handOffs).toEqual([
			{
				artifact: "app.json",
				where: "/logo_refs",
				key: "schema:Application.logo_refs",
				to: "media-reference",
				subject: "jr://file/commcare/logo.png",
			},
		]);
	});

	it("drops an inert key, refuses under a finding standing, and accounts by the standing", () => {
		const books = accounting();
		const root = books.json(
			{ comment: "x", recipients: "y", domain: "z" },
			APP,
		);
		root.drop("comment", CLAIMS.dropped);
		root.refuse("recipients", CLAIMS.refused, { name: "recipients" });
		root.account("domain", CLAIMS.accounted);
		const { findings, claims } = books.close();
		expect(findings.map((finding) => [finding.code, finding.detail])).toEqual([
			[NOT_YET, { name: "recipients" }],
			[NOT_YET, {}],
		]);
		expect(claims.counts).toEqual({ [INERT]: 1, [NOT_YET]: 2 });
	});

	it("refuses a use its entry's standing does not permit", () => {
		const books = accounting();
		books.json({ comment: "x" }, APP).drop("comment", CLAIMS.heldDrop);
		const { findings, defects, claims } = books.close();
		expect(unrecognized(findings)).toEqual(["schema:Application.comment"]);
		expect(defects.map((defect) => defect.why)).toEqual([
			`claim accountingTest.heldDrop at app is not permitted by ${HELD}, which is now held`,
		]);
		expect(claims.counts).toEqual({});
	});
});

describe("a finding between nodes", () => {
	it("is made under an entry whose standing makes one", () => {
		const books = accounting();
		books.finding(CLAIMS.refused, APP, { name: "two forms" });
		expect(books.close().findings).toMatchObject([
			{ code: NOT_YET, place: APP, detail: { name: "two forms" } },
		]);
	});

	it("is refused under a held entry", () => {
		const books = accounting();
		books.finding(CLAIMS.heldRelation, APP);
		const { findings, defects } = books.close();
		expect(findings.map((finding) => finding.code)).toEqual(["unrecognized"]);
		expect(defects.map((defect) => defect.why)).toEqual([
			`claim accountingTest.heldRelation at app is not permitted by ${HELD}, which is now held`,
		]);
	});
});

const XFORM = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa">
	<h:head>
		<model>
			<instance>
				<data xmlns="http://example.org/form" uiVersion="1">
					<q>an answer</q>
				</data>
			</instance>
			<bind nodeset="/data/q" jr:preload="x"/>
		</model>
	</h:head>
	<!-- a note -->
	<h:body><input ref="/data/q"/></h:body>
</h:html>`;

function child(parent: Document | Element, local: string): Element {
	const found = parent.children.find(
		(node): node is Element =>
			isTag(node) && node.name.split(":").pop() === local,
	);
	if (found === undefined) throw new Error(`No ${local} element.`);
	return found;
}

function xform() {
	const document = parseXml(XFORM);
	const html = child(document, "html");
	const head = child(html, "head");
	const model = child(head, "model");
	const instance = child(model, "instance");
	const data = child(instance, "data");
	const bind = child(model, "bind");
	const body = child(html, "body");
	return { document, html, head, model, instance, data, bind, body };
}

describe("the XML cursor", () => {
	it("reports an unclaimed element once, with what it holds", () => {
		const books = accounting();
		const form = xform();
		const cursor = books.xml(form.document, 0, 0, FORM);
		for (const element of [form.html, form.head, form.model, form.bind])
			cursor.derived({ element }, CLAIMS.element);
		cursor.derived(
			{ element: form.bind, attribute: "nodeset" },
			CLAIMS.element,
		);
		cursor.dropSubtree(form.body, CLAIMS.subtree);
		const { findings, claims } = books.close();
		expect(unrecognized(findings)).toEqual([
			"xform:instance",
			"xform:bind@jr:preload",
		]);
		expect(
			[...claims.records()].filter(
				(record) =>
					record.entry === "questions/xml-comments-processing-instructions",
			),
		).toEqual([
			{
				artifact: "form:0.0",
				where: "/h:html/comment()",
				key: null,
				entry: "questions/xml-comments-processing-instructions",
				standing: "inert",
			},
		]);
	});

	it("holds a default namespace that changes an element's namespace to a claim, and stray text too", () => {
		const books = accounting();
		const form = xform();
		const cursor = books.xml(form.document, 0, 0, FORM);
		for (const element of [form.html, form.head, form.model, form.instance])
			cursor.derived({ element }, CLAIMS.element);
		cursor.dropSubtree(form.bind, CLAIMS.subtree);
		cursor.dropSubtree(form.body, CLAIMS.subtree);
		cursor.derived({ element: form.data }, CLAIMS.element);
		const q = child(form.data, "q");
		cursor.derived({ element: q }, CLAIMS.element);
		const { findings } = books.close();
		expect(unrecognized(findings)).toEqual([
			"xform:{http://example.org/form}data@xmlns",
			"xform:{http://example.org/form}data@uiVersion",
			"xform:{http://example.org/form}q/text()",
		]);
	});

	it("records a namespace claim at the lane's `namespace()` place, and a take reads text", () => {
		const books = accounting();
		const form = xform();
		const cursor = books.xml(form.document, 0, 0, FORM);
		for (const element of [form.html, form.head, form.model, form.instance])
			cursor.derived({ element }, CLAIMS.element);
		cursor.dropSubtree(form.bind, CLAIMS.subtree);
		cursor.dropSubtree(form.body, CLAIMS.subtree);
		cursor.derived({ element: form.data }, CLAIMS.element);
		cursor.derived({ element: form.data, attribute: "xmlns" }, CLAIMS.element);
		cursor.derived(
			{ element: form.data, attribute: "uiVersion" },
			CLAIMS.element,
		);
		const q = child(form.data, "q");
		expect(cursor.take({ element: q }, CLAIMS.name).value).toBe("an answer");
		const { findings, claims } = books.close();
		expect(findings).toEqual([]);
		expect(
			[...claims.records()]
				.map((record) => record.where)
				.filter((where) => where.includes("data")),
		).toEqual([
			"/h:html/h:head[1]/model[1]/instance[1]/{http://example.org/form}data[1]",
			"/h:html/h:head[1]/model[1]/instance[1]/{http://example.org/form}data[1]/@uiVersion",
			"/h:html/h:head[1]/model[1]/instance[1]/{http://example.org/form}data[1]/namespace()",
			"/h:html/h:head[1]/model[1]/instance[1]/{http://example.org/form}data[1]/{http://example.org/form}q[1]",
		]);
	});

	it("lists a handed-off subtree and reports nothing under it", () => {
		const books = accounting();
		const form = xform();
		const cursor = books.xml(form.document, 0, 0, FORM);
		for (const element of [form.html, form.head, form.model])
			cursor.derived({ element }, CLAIMS.element);
		cursor.handOffSubtree(form.instance, "lookup-table-read", "districts");
		cursor.dropSubtree(form.bind, CLAIMS.subtree);
		cursor.dropSubtree(form.body, CLAIMS.subtree);
		const { findings, claims } = books.close();
		expect(findings).toEqual([]);
		expect(claims.handOffs).toEqual([
			{
				artifact: "form:0.0",
				where: "/h:html/h:head[1]/model[1]/instance[1]",
				key: "xform:instance",
				to: "lookup-table-read",
				subject: "districts",
			},
		]);
	});
});

describe("claims another stage decides", () => {
	function bound() {
		const books = accounting();
		const form = xform();
		const cursor = books.xml(form.document, 0, 0, FORM);
		for (const element of [form.html, form.head, form.model, form.bind])
			cursor.derived({ element }, CLAIMS.element);
		cursor.derived(
			{ element: form.bind, attribute: "nodeset" },
			CLAIMS.element,
		);
		cursor.dropSubtree(form.instance, CLAIMS.subtree);
		cursor.dropSubtree(form.body, CLAIMS.subtree);
		return { books, site: { element: form.bind, attribute: "jr:preload" } };
	}

	it("holds one claim per surface key on a node, several keys alike", () => {
		const { books, site } = bound();
		books.claimEntry(site, HELD, "xform:model/bind@jr:preload", FORM);
		books.claimEntry(site, INERT, "jr-fn:count", FORM);
		const { findings, claims } = books.close();
		expect(findings).toEqual([]);
		expect(
			[...claims.records()]
				.filter((record) => record.where.endsWith("/@jr:preload"))
				.map((record) => [record.key, record.entry]),
		).toEqual([
			["jr-fn:count", INERT],
			["xform:model/bind@jr:preload", HELD],
		]);
	});

	it("refuses a second claim under one key", () => {
		const { books, site } = bound();
		books.claimEntry(site, HELD, "xform:model/bind@jr:preload", FORM);
		books.claimEntry(site, INERT, "xform:model/bind@jr:preload", FORM);
		const { defects } = books.close();
		expect(defects.map((defect) => defect.why)).toEqual([
			"claimed twice at form[0,0]: first by accountingTest.name, then by accountingTest.dropped",
		]);
	});

	it("refuses an entry no registered claim holds", () => {
		const { books, site } = bound();
		books.claimEntry(site, "questions/no-such-entry-anywhere", "k", FORM);
		const { findings, defects } = books.close();
		expect(unrecognized(findings)).toEqual(["xform:bind@jr:preload"]);
		expect(defects.map((defect) => defect.why)).toEqual([
			"expression claim at form[0,0] names no-such-entry, which no registered claim holds",
		]);
	});

	it("covers a node by a finding already raised, and reports it no more", () => {
		const { books, site } = bound();
		books.finding(CLAIMS.refused, FORM);
		books.cover(site, {
			code: NOT_YET,
			standing: "not-yet",
			place: FORM,
			subject: "app-settings",
			detail: {},
		});
		const { findings, claims } = books.close();
		expect(findings.map((finding) => finding.code)).toEqual([NOT_YET]);
		expect(claims.counts).toEqual(expect.objectContaining({ [NOT_YET]: 1 }));
	});
});

describe("the claim log", () => {
	it("keeps counts alone unless asked for every claim", () => {
		const books = new Accounting(inventoryIndex(), { log: "counts" });
		expect(
			books.json({ name: "Visits" }, APP).take("name", CLAIMS.name, String)
				.value,
		).toBe("Visits");
		const { claims } = books.close();
		expect(claims.counts).toEqual({ [HELD]: 1 });
		expect(() => claims.records()).toThrow(/claims: "full"/);
	});

	it("serializes one JSON object a line, keys in the lane's order", () => {
		const books = accounting();
		expect(
			books.json({ name: "Visits" }, APP).take("name", CLAIMS.name, String)
				.value,
		).toBe("Visits");
		expect(serializeClaimLog(books.close().claims)).toBe(
			`{"artifact":"app.json","where":"/name","key":"schema:Application.name","entry":"${HELD}","standing":"held"}\n`,
		);
	});
});

describe("identities", () => {
	it("reports a key met twice that no stage claimed first", () => {
		const books = accounting();
		expect(
			books.identity(
				{
					ok: false,
					key: { kind: "form", parts: ["http://example.org/form"] },
					firstPlace: "3",
				},
				FORM,
				"schema:Form.xmlns",
			),
		).toBeUndefined();
		const { findings, defects } = books.close();
		expect(unrecognized(findings)).toEqual(["schema:Form.xmlns"]);
		expect(defects.map((defect) => defect.why)).toEqual([
			"identity met twice at form[0,0]: a form key",
		]);
	});
});
