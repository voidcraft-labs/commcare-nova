import { type Element, isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { describe, expect, it } from "vitest";
import { parseXml } from "@/lib/commcare/xmlParse";
import {
	canonicalizeXPath,
	normalizeEmittedApp,
	normalizeHqApplication,
	normalizeSuite,
	normalizeXForm,
} from "../emissionNormal";

function attribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;");
}

function xform({
	xmlns = "urn:nova:test:one",
	instances = "",
	bind = "",
	body = "",
	data = "<answer>keep me</answer>",
}: {
	xmlns?: string;
	instances?: string;
	bind?: string;
	body?: string;
	data?: string;
} = {}): string {
	return `<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:vellum="http://commcarehq.org/xforms/vellum"><h:head><model><instance><data xmlns="${attribute(xmlns)}">${data}</data></instance>${instances}${bind}</model></h:head><h:body>${body}</h:body></h:html>`;
}

function external(id: string): string {
	return `<instance id="${id}" src="jr://fixture/${id}"/>`;
}

function elements(xml: string, name: string): Element[] {
	return findAll((node) => node.name === name, parseXml(xml).children);
}

function instanceIds(parent: Element): string[] {
	return parent.children
		.filter((node): node is Element => isTag(node) && node.name === "instance")
		.map((node) => node.attribs.id);
}

function emittedFixture() {
	const first = xform();
	const second = xform({ xmlns: "urn:nova:test:two" });
	return {
		app: {
			name: "Test app",
			modules: [
				{
					unique_id: "module-one",
					name: { en: "Visits" },
					forms: [
						{ unique_id: "form-one", xmlns: "urn:nova:test:one" },
						{ unique_id: "form-two", xmlns: "urn:nova:test:two" },
					],
				},
			],
			_attachments: { "form-one.xml": first, "form-two.xml": second },
		},
		files: {
			"suite.xml": "<suite/>",
			"modules-0/forms-0.xml": first,
			"modules-0/forms-1.xml": second,
			"profile.ccpr": "<profile/>",
			"en/app_strings.txt": "label=Visible text",
		},
	};
}

describe("emission XPath normalization", () => {
	it("normalizes spelling while preserving literal contents", () => {
		expect(canonicalizeXPath(' concat( "two  spaces",(1+2) ) ')).toBe(
			"concat('two  spaces', 1 + 2)",
		);
		expect(canonicalizeXPath('"patient\'s name"')).toBe('"patient\'s name"');
		const csql = `concat("name = 'a  b' and instance('bait')", ' suffix')`;
		expect(canonicalizeXPath(csql)).toBe(csql);
	});

	it.each([
		["(a + b) * c", "a + b * c"],
		["a - (b - c)", "a - b - c"],
		["a = (b = c)", "a = b = c"],
		["(a/b)[1]", "a/b[1]"],
		["(a//b)[1]", "a//b[1]"],
		["(/a/b[1])[2]", "/a/b[1][2]"],
	])(
		"keeps the meaningful grouping in %s distinct from %s",
		(grouped, bare) => {
			const normalized = canonicalizeXPath(grouped);
			expect(normalized).not.toBe(canonicalizeXPath(bare));
			expect(canonicalizeXPath(normalized)).toBe(normalized);
		},
	);

	it("removes redundant grouping without changing a path predicate's scope", () => {
		expect(canonicalizeXPath("((a + b))")).toBe("a + b");
		expect(canonicalizeXPath("a/b[(1)]")).toBe("a/b[1]");
		expect(canonicalizeXPath("((a/b))[1]")).toBe("(a/b)[1]");
	});

	it("prints finite doubles without truncating tiny values or emitting exponent syntax", () => {
		const values = [
			"0.0000000000000000000000001",
			`1${"0".repeat(21)}`,
			`0.${"0".repeat(323)}5`,
			`17976931348623157${"0".repeat(292)}`,
		];
		for (const source of values) {
			const normalized = canonicalizeXPath(source);
			expect(Number(normalized)).toBe(Number(source));
			expect(normalized).not.toMatch(/[eE]/);
			expect(canonicalizeXPath(normalized)).toBe(normalized);
		}
		expect(canonicalizeXPath("0001.25000")).toBe("1.25");
		expect(canonicalizeXPath("0.10000000000000002")).not.toBe(
			canonicalizeXPath("0.1"),
		);
	});

	it("refuses malformed syntax and dynamic instance identities", () => {
		expect(canonicalizeXPath("instance('rows')/rows/row")).toBe(
			"instance('rows')/rows/row",
		);
		for (const source of [
			"a +",
			"concat('open)",
			"a[1",
			"instance(/data/name)/rows",
			"instance(concat('ro', 'ws'))/rows",
			"instance()",
			"instance('a', 'b')",
			`1${"0".repeat(400)}`,
		]) {
			expect(() => canonicalizeXPath(source), source).toThrow();
		}
	});
});

describe("emission XML normalization", () => {
	it("drops unread external instances while retaining answer data and shadow reads", () => {
		const source = xform({
			instances: external("used") + external("shadow") + external("bait"),
			bind: `<bind nodeset="/data/answer" calculate="instance('used')/rows/value" vellum:calculate="instance('shadow')/rows/value"/>`,
			body: `<label>instance('bait')</label>`,
			data: `<answer>instance('bait')</answer><payload calculate="not XPath ["/>`,
		});
		const normalized = normalizeXForm(source);
		expect(
			elements(normalized, "instance").map((node) => node.attribs.id),
		).toEqual([undefined, "used", "shadow"]);
		expect(textContent(elements(normalized, "answer")[0])).toBe(
			"instance('bait')",
		);
		expect(textContent(elements(normalized, "label")[0])).toBe(
			"instance('bait')",
		);
		expect(elements(normalized, "payload")[0].attribs.calculate).toBe(
			"not XPath [",
		);
		expect(normalizeXForm(normalized)).toBe(normalized);
		expect(
			normalizeXForm(
				source.replace(
					"<answer>instance('bait')</answer>",
					"<answer>changed</answer>",
				),
			),
		).not.toBe(normalized);
	});

	it("treats a literal instance call as text and preserves nested CSQL bytes", () => {
		const expression = `concat("name = 'a  b' and instance('bait')", ' suffix')`;
		const source = xform({
			instances: external("bait"),
			bind: `<bind nodeset="/data/answer" calculate="${attribute(expression)}"/>`,
		});
		const normalized = normalizeXForm(source);
		expect(elements(normalized, "instance")).toHaveLength(1);
		expect(elements(normalized, "bind")[0].attribs.calculate).toBe(expression);
	});

	it("preserves a named primary instance and only the inline secondary data that is read", () => {
		const source = xform({
			instances:
				'<instance id="used"><rows><row value="not XPath ["/></rows></instance><instance id="unused"><rows><row value="also not XPath ["/></rows></instance>',
			bind: '<bind nodeset="/data/answer" calculate="instance(\'used\')/rows/row/@value"/>',
		}).replace("<instance>", '<instance id="main">');
		const normalized = normalizeXForm(source);
		expect(
			elements(normalized, "instance").map((node) => node.attribs.id),
		).toEqual(["main", "used"]);
		expect(
			elements(normalized, "row").map((node) => node.attribs.value),
		).toEqual(["not XPath ["]);
		expect(textContent(elements(normalized, "answer")[0])).toBe("keep me");
	});

	it("keeps shared detail dependencies in each referencing entry without leaking unrelated reads", () => {
		const declarations =
			external("shared") + external("private") + external("unused");
		const source = `<suite>
			<detail id="shared-detail"><field><template><text><xpath function="instance('shared')/rows/value"/></text></template></field></detail>
			<entry>${declarations}<command id="first"/><session><datum id="case_id" nodeset="instance('private')/rows/row" detail-select="shared-detail"/></session></entry>
			<entry>${declarations}<command id="second"/><session><datum id="case_id" nodeset="/rows/row" detail-confirm="shared-detail"/></session></entry>
			<entry>${declarations}<command id="third"/><session><datum id="case_id" nodeset="/rows/row"/></session></entry>
		</suite>`;
		const entries = elements(normalizeSuite(source), "entry");
		expect(entries.map(instanceIds)).toEqual([
			["shared", "private"],
			["shared"],
			[],
		]);
	});

	it("resolves menu and command expressions in their own declaration scopes", () => {
		const source = `<suite>
			<entry>${external("entry-data")}${external("command-data")}${external("unused-entry")}<command id="form"/><session><datum id="answer" value="instance('entry-data')/rows/value"/></session></entry>
			<entry>${external("command-data")}<command id="other-form"/></entry>
			<menu id="root" relevant="instance('menu-data')/rows/show">${external("menu-data")}${external("unused-menu")}<command id="form" relevant="instance('command-data')/rows/allow"/></menu>
		</suite>`;
		const normalized = normalizeSuite(source);
		expect(elements(normalized, "entry").map(instanceIds)).toEqual([
			["entry-data", "command-data"],
			[],
		]);
		expect(instanceIds(elements(normalized, "menu")[0])).toEqual(["menu-data"]);
	});

	it("excludes fixture payloads without treating their data attributes as XPath", () => {
		const before = `<suite><fixture id="rows"><rows><row value="not XPath [">first</row></rows></fixture><entry>${external("rows")}<command id="form"/><session><datum id="answer" value="instance('rows')/rows/row"/></session></entry></suite>`;
		const after = before.replace("first", "changed");
		const normalized = normalizeSuite(before);
		expect(normalizeSuite(after)).toBe(normalized);
		expect(elements(normalized, "fixture")).toHaveLength(0);
		expect(instanceIds(elements(normalized, "entry")[0])).toEqual(["rows"]);
	});

	it("refuses malformed XML and malformed XPath in actual carriers", () => {
		const valid = xform({
			bind: '<bind nodeset="/data/answer" calculate="1 + 2"/>',
		});
		expect(() => normalizeXForm(valid)).not.toThrow();
		expect(() => normalizeXForm(valid.replace("1 + 2", "1 +"))).toThrow();
		expect(() =>
			normalizeXForm(valid.replace("</model>", "</broken>")),
		).toThrow();
		expect(() =>
			normalizeSuite(
				'<suite><entry><session><datum id="answer" value="1 +"/></session></entry></suite>',
			),
		).toThrow();
	});
});

describe("emission HQ JSON normalization", () => {
	it("normalizes known carriers while preserving labels and unrelated keys named like expressions", () => {
		const app = {
			name: { filter: "not XPath [", test: "Also not XPath [" },
			modules: [
				{
					unique_id: "module-one",
					module_filter: "((1+2))=3",
					name: { xpath: "Label with [", field: "Another label [" },
					case_details: {
						short: {
							columns: [
								{
									field: "(1+2)",
									useXpathExpression: true,
									header: { test: "Label [" },
								},
								{ field: "plain-property", useXpathExpression: false },
							],
						},
					},
					forms: [
						{
							unique_id: "form-one",
							form_filter: "1=1",
							form_links: [{ xpath: "1=2", datums: [{ xpath: "(1+2)" }] }],
						},
					],
					search_config: {
						properties: [
							{
								name: "age",
								default_value: "1+2",
								required: { test: "1=1", text: { test: "Not a test [" } },
							},
						],
						default_properties: [
							{ property: "_xpath_query", defaultValue: `"name = 'a  b'"` },
						],
					},
				},
			],
		};
		const expected = structuredClone(app);
		const module = expected.modules[0];
		module.module_filter = "1 + 2 = 3";
		module.case_details.short.columns[0].field = "1 + 2";
		module.forms[0].form_filter = "1 = 1";
		module.forms[0].form_links[0].xpath = "1 = 2";
		module.forms[0].form_links[0].datums[0].xpath = "1 + 2";
		module.search_config.properties[0].default_value = "1 + 2";
		module.search_config.properties[0].required.test = "1 = 1";
		expect(normalizeHqApplication(app)).toEqual(expected);
		expect(app.modules[0].module_filter).toBe("((1+2))=3");
	});
});

describe("emission fragment identities and digests", () => {
	it("retains raw suite spelling evidence while excluding fixture data from both digests", () => {
		const { app, files } = emittedFixture();
		const suite =
			'<suite version="1"><fixture id="rows"><rows><row>first</row></rows></fixture></suite>';
		const before = normalizeEmittedApp(app, { ...files, "suite.xml": suite });
		const respelled = normalizeEmittedApp(app, {
			...files,
			"suite.xml": suite.replace('version="1"', "version='1'"),
		});
		const left = before.find(({ file }) => file === "local/suite.xml");
		const right = respelled.find(({ file }) => file === "local/suite.xml");
		expect(left?.digest).toBe(right?.digest);
		expect(left?.rawDigest).not.toBe(right?.rawDigest);
		expect(
			normalizeEmittedApp(app, {
				...files,
				"suite.xml": suite.replace("first", "changed"),
			}),
		).toEqual(before);
	});

	it("retains form identities across archive moves while detecting resource and spelling changes", () => {
		const { app, files } = emittedFixture();
		const before = normalizeEmittedApp(app, files);
		expect(before.map((fragment) => fragment.file).sort()).toEqual(
			[
				"hq/app.json",
				"hq/modules/module-one/module.json",
				"hq/modules/module-one/forms/form-one/form.json",
				"hq/modules/module-one/forms/form-two/form.json",
				"hq/xforms/form-one.xml",
				"hq/xforms/form-two.xml",
				"local/suite.xml",
				`local/xforms/${encodeURIComponent("urn:nova:test:one")}.xml`,
				`local/xforms/${encodeURIComponent("urn:nova:test:two")}.xml`,
			].sort(),
		);
		const movedFiles = new Map(Object.entries(files));
		movedFiles.set("modules-0/forms-0.xml", files["modules-0/forms-1.xml"]);
		movedFiles.set("modules-0/forms-1.xml", files["modules-0/forms-0.xml"]);
		const moved = normalizeEmittedApp(app, movedFiles);
		expect(moved.map(({ file }) => file)).toEqual(
			before.map(({ file }) => file),
		);
		expect(
			moved
				.filter(
					(fragment) =>
						fragment.digest !==
						before.find(({ file }) => file === fragment.file)?.digest,
				)
				.map(({ file }) => file),
		).toEqual([
			`local/xforms/${encodeURIComponent("urn:nova:test:one")}.xml`,
			`local/xforms/${encodeURIComponent("urn:nova:test:two")}.xml`,
		]);
		expect(normalizeEmittedApp(app, files)).toEqual(before);
		const respelled = structuredClone(app);
		respelled._attachments["form-one.xml"] = app._attachments[
			"form-one.xml"
		].replace(
			"</model>",
			'<bind nodeset="/data/answer" calculate="(1+2)"/></model>',
		);
		const canonical = structuredClone(respelled);
		canonical._attachments["form-one.xml"] = respelled._attachments[
			"form-one.xml"
		].replace("(1+2)", "1 + 2");
		const left = normalizeEmittedApp(respelled, files);
		const right = normalizeEmittedApp(canonical, files);
		expect(left.map(({ file, digest }) => ({ file, digest }))).toEqual(
			right.map(({ file, digest }) => ({ file, digest })),
		);
		expect(
			left.find(({ file }) => file === "hq/xforms/form-one.xml")?.rawDigest,
		).not.toBe(
			right.find(({ file }) => file === "hq/xforms/form-one.xml")?.rawDigest,
		);
		expect(normalizeEmittedApp(canonical, files)).toEqual(right);
	});

	it("detects module and form order changes in their owning fragments", () => {
		const { app, files } = emittedFixture();
		app.modules.push({
			unique_id: "module-two",
			name: { en: "Second" },
			forms: [],
		});
		const before = normalizeEmittedApp(app, files);
		const formReordered = structuredClone(app);
		formReordered.modules[0].forms.reverse();
		const formAfter = normalizeEmittedApp(formReordered, files);
		const changedFiles = (after: typeof before) =>
			after
				.filter(
					(fragment) =>
						fragment.digest !==
						before.find(({ file }) => file === fragment.file)?.digest,
				)
				.map(({ file }) => file);
		expect(changedFiles(formAfter)).toEqual([
			"hq/modules/module-one/module.json",
		]);
		const moduleReordered = structuredClone(app);
		moduleReordered.modules.reverse();
		expect(changedFiles(normalizeEmittedApp(moduleReordered, files))).toEqual([
			"hq/app.json",
		]);
	});

	it("detects new forms and refuses duplicate or unmatched identities", () => {
		const { app, files } = emittedFixture();
		const before = normalizeEmittedApp(app, files);
		const added = structuredClone(app);
		added.modules[0].forms.push({
			unique_id: "form-three",
			xmlns: "urn:nova:test:three",
		});
		const xml = xform({ xmlns: "urn:nova:test:three" });
		const after = normalizeEmittedApp(
			{
				...added,
				_attachments: { ...added._attachments, "form-three.xml": xml },
			},
			{ ...files, "modules-0/forms-2.xml": xml },
		);
		expect(
			after
				.filter(
					({ file }) => !before.some((fragment) => fragment.file === file),
				)
				.map(({ file }) => file)
				.sort(),
		).toEqual(
			[
				"hq/modules/module-one/forms/form-three/form.json",
				"hq/xforms/form-three.xml",
				`local/xforms/${encodeURIComponent("urn:nova:test:three")}.xml`,
			].sort(),
		);
		const duplicate = structuredClone(app);
		duplicate.modules[0].forms[1].unique_id = "form-one";
		expect(() => normalizeEmittedApp(duplicate, files)).toThrow();
		expect(() =>
			normalizeEmittedApp(app, {
				...files,
				"modules-0/forms-1.xml": xform({ xmlns: "urn:nova:unmatched" }),
			}),
		).toThrow();
	});
});
