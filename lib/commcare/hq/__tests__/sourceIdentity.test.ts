/**
 * `sourceIdentity` extracts what publishing an app back must not change: its
 * menus, each form's answer leaves with their repeats, controls, stored type
 * classes and choices, its groups and repeats, and the order of its controls.
 *
 * The boundary is the extraction over hand-written XML, the shapes CommCare
 * HQ's form builder and Nova both write. The plausible failures: a level of
 * nesting missed (a repeat inside a repeat, a group with no `ref` that passes
 * its context on), a relative `ref` left unresolved, a case block's elements
 * counted as answers, a control or a choice lost, a label's itext reference
 * read from the wrong element (a repeat's label stands on the group around
 * it), and a form that cannot be read passing in silence. Each would let the
 * identity comparison pass over the very bug it exists for, or compare a
 * label CommCare HQ never summarized.
 */
import { describe, expect, it } from "vitest";
import {
	CORE_BIND_TYPE_CLASSES,
	coreTypeClass,
	type FormIdentity,
	sourceIdentity,
} from "../sourceIdentity";

const NAMESPACES =
	'xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="http://commcarehq.org/xforms/vellum"';

/** An XForm whose data root is `root`, holding `data`, `binds` and `body`. */
function xform(
	data: string,
	binds: string,
	body: string,
	root = "data",
	xmlns = "http://openrosa.org/formdesigner/visit",
): string {
	return `<h:html ${NAMESPACES}><h:head><h:title>Visit</h:title><model><instance><${root} xmlns="${xmlns}" uiVersion="1" version="1" name="Visit">${data}</${root}></instance><instance id="casedb" src="jr://instance/casedb"/>${binds}</model></h:head><h:body>${body}</h:body></h:html>`;
}

interface FormSpec {
	readonly xmlns?: string;
	readonly uniqueId?: string;
	readonly xml?: string;
}

/** An application holding one menu of `forms`, each form's XML under `<unique_id>.xml`. */
function application(forms: readonly FormSpec[]): Record<string, unknown> {
	const attachments: Record<string, string> = {};
	return {
		doc_type: "Application",
		langs: ["en", "fra"],
		modules: [
			{
				doc_type: "Module",
				unique_id: "menu-1",
				case_type: "household",
				forms: forms.map((form, index) => {
					const uniqueId = form.uniqueId ?? `form-${index}`;
					if (form.xml !== undefined) attachments[`${uniqueId}.xml`] = form.xml;
					return {
						doc_type: "Form",
						unique_id: uniqueId,
						xmlns: form.xmlns ?? `http://openrosa.org/formdesigner/f${index}`,
					};
				}),
			},
		],
		_attachments: attachments,
	};
}

function onlyForm(
	xml: string,
	xmlns = "http://openrosa.org/formdesigner/visit",
) {
	const identity = sourceIdentity(application([{ xmlns, xml }]));
	expect(identity.unread).toEqual([]);
	const form = identity.forms.get(xmlns);
	if (form === undefined) throw new Error("The form was not read.");
	return form;
}

const DATA = [
	"<name/>",
	"<photo/>",
	"<village/>",
	"<colors/>",
	'<household jr:template=""><member jr:template=""><age/></member></household>',
	'<r><nova_query_ids_r/><nova_query_count_r/><item jr:template=""><nova_query_id_r/><nova_query_index_r/><note/></item></r>',
	'<nova_operations><visit vellum:role="SaveToCase" vellum:case_type="visit"><case xmlns="http://commcarehq.org/case/transaction/v2" case_id="" date_modified="" user_id=""><update><outcome/></update></case></visit></nova_operations>',
].join("");

const BINDS = [
	'<bind nodeset="/data/name" type="xsd:string"/>',
	'<bind nodeset="/data/photo" type="binary"/>',
	'<bind nodeset="/data/village"/>',
	'<bind nodeset="/data/colors" type="select"/>',
	'<bind nodeset="/data/household/member/age" type="xsd:int"/>',
	'<bind nodeset="/data/r/item/note" type="xsd:double"/>',
	'<bind nodeset="/data/nova_operations/visit/case/update/outcome" calculate="/data/name"/>',
].join("");

const BODY = [
	'<input ref="/data/name" appearance="numeric"><label ref="jr:itext(\'name-label\')"/><setvalue event="xforms-value-changed" ref="/data/village" value="\'x\'"/></input>',
	'<upload ref="/data/photo" mediatype="image/*" appearance="signature"><label>Photo</label></upload>',
	'<group><label>Household</label><repeat nodeset="/data/household"><group><label ref="jr:itext(\'member-label\')"/><repeat nodeset="/data/household/member" jr:count="/data/name"><input ref="age"><label>Age</label></input></repeat></group></repeat></group>',
	'<select1 ref="/data/village"><label>Village</label><itemset nodeset="instance(\'casedb\')/casedb/case"><label ref="case_name"/><value ref="@case_id"/></itemset></select1>',
	'<setvalue event="xforms-ready" ref="/data/name" value="\'\'"/>',
	'<select ref="/data/colors"><label>Colors</label><item><value> red </value><label ref="jr:itext(\'red\')"/></item><item><value>blue</value><label>Blue</label></item></select>',
	'<group ref="/data/r"><group><repeat nodeset="/data/r/item"><input ref="/data/r/item/note"><label>Note</label></input></repeat></group></group>',
].join("");

describe("a form's answers", () => {
	const form: FormIdentity = onlyForm(xform(DATA, BINDS, BODY));

	it("reads every leaf of the data tree and none of a case block's", () => {
		expect([...form.leaves.keys()]).toEqual([
			"/data/name",
			"/data/photo",
			"/data/village",
			"/data/colors",
			"/data/household/member/age",
			"/data/r/nova_query_ids_r",
			"/data/r/nova_query_count_r",
			"/data/r/item/nova_query_id_r",
			"/data/r/item/nova_query_index_r",
			"/data/r/item/note",
		]);
	});

	it("gives each leaf the repeats around it, outermost first", () => {
		expect(form.leaves.get("/data/household/member/age")?.repeats).toEqual([
			"/data/household",
			"/data/household/member",
		]);
		expect(form.leaves.get("/data/r/item/note")?.repeats).toEqual([
			"/data/r/item",
		]);
		expect(form.leaves.get("/data/r/nova_query_ids_r")?.repeats).toEqual([]);
		expect(form.leaves.get("/data/name")?.repeats).toEqual([]);
	});

	it("reads each control, its type class, media type, appearance and choices", () => {
		expect(form.leaves.get("/data/name")).toEqual({
			path: "/data/name",
			repeats: [],
			control: "input",
			typeClass: "text",
			mediatype: null,
			appearance: "numeric",
			choices: null,
			itemset: false,
		});
		expect(form.leaves.get("/data/photo")).toMatchObject({
			control: "upload",
			typeClass: "binary",
			mediatype: "image/*",
			appearance: "signature",
		});
		expect(form.leaves.get("/data/village")).toMatchObject({
			control: "select1",
			typeClass: "text",
			choices: null,
			itemset: true,
		});
		expect(form.leaves.get("/data/colors")).toMatchObject({
			control: "select",
			typeClass: "choice-list",
			choices: ["red", "blue"],
			itemset: false,
		});
		// A relative `ref` resolves against the repeat that encloses it.
		expect(form.leaves.get("/data/household/member/age")).toMatchObject({
			control: "input",
			typeClass: "integer",
		});
		expect(form.leaves.get("/data/r/item/note")).toMatchObject({
			control: "input",
			typeClass: "decimal",
		});
		// A generated node with no control, and a setvalue, which is no control.
		expect(form.leaves.get("/data/r/nova_query_ids_r")).toMatchObject({
			control: "none",
			appearance: null,
		});
	});

	it("reads each group with a ref and each repeat, and passes a ref-less group's context on", () => {
		expect([...form.containers.values()]).toEqual([
			{
				path: "/data/household",
				kind: "repeat",
				appearance: null,
				counted: false,
			},
			{
				path: "/data/household/member",
				kind: "repeat",
				appearance: null,
				counted: true,
			},
			{ path: "/data/r", kind: "group", appearance: null, counted: false },
			{
				path: "/data/r/item",
				kind: "repeat",
				appearance: null,
				counted: false,
			},
		]);
	});

	it("orders the leaf controls as the body holds them", () => {
		expect(form.order).toEqual([
			"/data/name",
			"/data/photo",
			"/data/household/member/age",
			"/data/village",
			"/data/colors",
			"/data/r/item/note",
		]);
	});

	it("records which labels the source writes through itext, a repeat's on the element around it", () => {
		expect(form.written.get("/data/name")).toEqual({
			labelRef: true,
			itemLabelRefs: [],
		});
		expect(form.written.get("/data/photo")?.labelRef).toBe(false);
		expect(form.written.get("/data/household")?.labelRef).toBe(false);
		expect(form.written.get("/data/household/member")?.labelRef).toBe(true);
		expect(form.written.get("/data/colors")).toEqual({
			labelRef: false,
			itemLabelRefs: [true, false],
		});
		expect(form.written.get("/data/r")?.labelRef).toBe(false);
		expect([...form.written.keys()].sort()).toEqual(
			[
				"/data/name",
				"/data/photo",
				"/data/household",
				"/data/household/member",
				"/data/household/member/age",
				"/data/village",
				"/data/colors",
				"/data/r",
				"/data/r/item",
				"/data/r/item/note",
			].sort(),
		);
	});

	it("reads the form's own identities and the data root's namespace", () => {
		expect(form).toMatchObject({
			xmlns: "http://openrosa.org/formdesigner/visit",
			dataNamespace: "http://openrosa.org/formdesigner/visit",
			uniqueId: "form-0",
			docType: "Form",
		});
	});
});

describe("the app around its forms", () => {
	it("reads the languages and each menu's ids, case type and forms in order", () => {
		const xml = xform(
			"<q/>",
			"",
			'<input ref="/data/q"><label>Q</label></input>',
		);
		const identity = sourceIdentity(
			application([
				{ xmlns: "urn:a", xml },
				{ xmlns: "urn:b", xml },
			]),
		);
		expect(identity.languages).toEqual(["en", "fra"]);
		expect(identity.menus).toEqual([
			{
				uniqueId: "menu-1",
				docType: "Module",
				caseType: "household",
				forms: ["urn:a", "urn:b"],
			},
		]);
		expect([...identity.forms.keys()]).toEqual(["urn:a", "urn:b"]);
	});

	it("reads a data root named otherwise as data, and keeps its namespace", () => {
		const form = onlyForm(
			xform(
				"<q/>",
				'<bind nodeset="/visit/q" type="xsd:integer"/>',
				'<input ref="/visit/q"><label>Q</label></input>',
				"visit",
				"urn:other",
			),
		);
		expect(form.dataNamespace).toBe("urn:other");
		expect(form.leaves.get("/data/q")).toMatchObject({
			control: "input",
			typeClass: "integer",
		});
	});

	it("finds a control's node through its bind's id", () => {
		const form = onlyForm(
			xform(
				"<q/>",
				'<bind id="the-q" nodeset="/data/q" type="xsd:date"/>',
				'<input bind="the-q"><label>Q</label></input>',
			),
		);
		expect(form.leaves.get("/data/q")).toMatchObject({
			control: "input",
			typeClass: "date",
		});
		expect(form.order).toEqual(["/data/q"]);
	});

	// Core binds a control by its `bind` before its `ref`, a repeat by its `nodeset` and a group
	// by its `ref` alone (`XFormParser.parseControl`, `parseGroup`); the oracle follows Core, not
	// the reader, so it catches a reader that binds another node.
	it("binds a control holding `ref` and `bind` by its bind", () => {
		const form = onlyForm(
			xform(
				"<a/><b/>",
				'<bind nodeset="/data/a"/><bind id="the-b" nodeset="/data/b"/>',
				'<input ref="/data/a" bind="the-b"><label>B</label></input>',
			),
		);
		expect(form.leaves.get("/data/b")?.control).toBe("input");
		expect(form.leaves.get("/data/a")?.control).toBe("none");
	});

	it("reads a group holding only `nodeset` as a group with no node, whose context is its parent's", () => {
		const form = onlyForm(
			xform(
				"<g><q/></g><q/>",
				'<bind nodeset="/data/g/q"/><bind nodeset="/data/q"/>',
				'<group nodeset="/data/g"><input ref="q"><label>Q</label></input></group>',
			),
		);
		expect([...form.containers.keys()]).toEqual([]);
		expect(form.leaves.get("/data/q")?.control).toBe("input");
		expect(form.leaves.get("/data/g/q")?.control).toBe("none");
	});
});

describe("a form left out", () => {
	const plain = xform(
		"<q/>",
		"",
		'<input ref="/data/q"><label>Q</label></input>',
	);

	it("names a form with no xmlns, or a blank one", () => {
		const identity = sourceIdentity(application([{ xmlns: "  ", xml: plain }]));
		expect(identity.unread).toEqual([{ menu: 0, form: 0, reason: "no-xmlns" }]);
		expect(identity.menus[0]?.forms).toEqual([""]);
	});

	it("reads neither of two forms that share an xmlns", () => {
		const identity = sourceIdentity(
			application([
				{ xmlns: "urn:same", xml: plain },
				{ xmlns: "urn:same", xml: plain },
			]),
		);
		expect(identity.forms.size).toBe(0);
		expect(identity.unread).toEqual([
			{ menu: 0, form: 0, reason: "shared-xmlns" },
			{ menu: 0, form: 1, reason: "shared-xmlns" },
		]);
	});

	it("names a form whose XForm the attachments do not hold", () => {
		const identity = sourceIdentity(application([{ xmlns: "urn:gone" }]));
		expect(identity.unread).toEqual([{ menu: 0, form: 0, reason: "no-xform" }]);
	});

	it.each([
		["XML that does not parse", "<h:html"],
		["no model", `<h:html ${NAMESPACES}><h:head/><h:body/></h:html>`],
		[
			"two data roots",
			`<h:html ${NAMESPACES}><h:head><model><instance><data/><data/></instance></model></h:head></h:html>`,
		],
		[
			"a control whose path names no leaf",
			xform(
				"<q/>",
				"",
				'<input ref="/data/elsewhere"><label>Q</label></input>',
			),
		],
		[
			"two controls on one leaf",
			xform(
				"<q/>",
				"",
				'<input ref="/data/q"><label>Q</label></input><input ref="/data/q"><label>Q</label></input>',
			),
		],
		[
			"a body element Core reads as no control",
			xform("<q/>", "", '<range ref="/data/q"><label>Q</label></range>'),
		],
		["a repeat with no nodeset", xform("<q/>", "", "<group><repeat/></group>")],
	])("names a form with %s as unparsed", (_, xml) => {
		const identity = sourceIdentity(application([{ xmlns: "urn:x", xml }]));
		expect(identity.unread).toEqual([
			{ menu: 0, form: 0, reason: "xform-unparsed" },
		]);
		expect(identity.forms.size).toBe(0);
	});

	it("reads nothing of a value that is no application", () => {
		expect(sourceIdentity(null)).toEqual({
			languages: [],
			menus: [],
			forms: new Map(),
			unread: [],
		});
	});
});

describe("Core's type classes", () => {
	it("gives each pair Core reads as one data type one class, and nothing else", () => {
		expect(coreTypeClass("xsd:int")).toBe(coreTypeClass("xsd:integer"));
		expect(coreTypeClass("xsd:double")).toBe(coreTypeClass("xsd:decimal"));
		expect(coreTypeClass("xsd:float")).toBe("decimal");
		expect(coreTypeClass("xsd:long")).not.toBe(coreTypeClass("xsd:int"));
		expect(coreTypeClass("xsd:date")).not.toBe(coreTypeClass("xsd:dateTime"));
		expect(coreTypeClass("xsd:gYear")).toBe("unsupported");
	});

	it("reads an absent type as text, and the type after any prefix", () => {
		expect(coreTypeClass(null)).toBe("text");
		expect(coreTypeClass("xsd:string")).toBe("text");
		expect(coreTypeClass("geopoint")).toBe("geopoint");
		expect(coreTypeClass("odk:geopoint")).toBe("geopoint");
	});

	it("keeps an unknown type's own name, so two unknown types never compare equal", () => {
		expect(coreTypeClass("xsd:duration")).toBe("other:duration");
		expect(coreTypeClass("xsd:duration")).not.toBe(coreTypeClass("xsd:token"));
	});

	it("holds each key with and without the xsd prefix", () => {
		for (const [type, typeClass] of CORE_BIND_TYPE_CLASSES) {
			const local = type.startsWith("xsd:") ? type.slice(4) : type;
			expect(CORE_BIND_TYPE_CLASSES.get(local)).toBe(typeClass);
			expect(CORE_BIND_TYPE_CLASSES.get(`xsd:${local}`)).toBe(typeClass);
			expect(coreTypeClass(type)).toBe(typeClass);
		}
		expect(CORE_BIND_TYPE_CLASSES.size).toBe(52);
	});
});
