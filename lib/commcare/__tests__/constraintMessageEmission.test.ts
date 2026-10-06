// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Native constraint markers must remain literal test data.

import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import {
	makeTranslationUnitId,
	type ProseTemplate,
	proseText,
	translationUnitsById,
} from "@/lib/domain";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import { buildXForm } from "../xform/builder";
import {
	admitConstraintMessageFixture,
	CONSTRAINT_CHECKED,
	CONSTRAINT_VALUE,
	constraintMessageFixture,
} from "./constraintMessageFixture";
import { containerWireFixture } from "./containerWireFixture";
import { mediaIds, mediaManifest } from "./mediaWireFixtures";
import { onlyXml, readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

function descendants(node: XmlEvidence, name: string): XmlEvidence[] {
	return [
		...(node.name === name ? [node] : []),
		...node.children.flatMap((child) => descendants(child, name)),
	];
}
function entry(
	root: XmlEvidence,
	language: string,
	id = "checked-constraintMsg",
): XmlEvidence {
	return onlyXml(
		onlyXml(
			descendants(root, "translation").filter(
				(node) => node.attributes.lang === language,
			),
		).children.filter((node) => node.attributes.id === id),
	);
}
function bind(root: XmlEvidence, path = "/data/checked"): XmlEvidence {
	return onlyXml(
		descendants(root, "bind").filter(
			(node) => node.attributes.nodeset === path,
		),
	);
}
function carrierBinds(root: XmlEvidence): XmlEvidence[] {
	return descendants(root, "bind").filter(
		(node) =>
			node.attributes.nodeset
				.split("/")
				.at(-1)
				?.startsWith("nova_constraint_message_") &&
			node.attributes.relevant === "false()" &&
			node.attributes.readonly === "true()",
	);
}
function routes(
	fixture: ReturnType<typeof constraintMessageFixture>,
): XmlEvidence[] {
	const hq = expandDoc(fixture.doc, { assets: fixture.assets });
	const source = Object.values(hq._attachments)[0];
	if (typeof source !== "string") throw new Error("Missing HQ source.");
	return [
		readXmlEvidence(source),
		readXmlEvidence(
			new AdmZip(
				compileCcz(hq, fixture.doc.appName, fixture.doc, {
					assets: fixture.assets,
				}),
			).readAsText("modules-0/forms-0.xml"),
		),
	];
}
function translate(
	fixture: ReturnType<typeof constraintMessageFixture>,
	value: ProseTemplate,
	stale = false,
): void {
	const unitId = makeTranslationUnitId(
		"field",
		CONSTRAINT_CHECKED,
		"validate_msg",
	);
	const unit = translationUnitsById(fixture.doc).get(unitId);
	if (unit === undefined) throw new Error("Missing translation unit.");
	fixture.doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		translations: {
			spa: {
				[unitId]: {
					value,
					sourceFingerprint: stale ? "stale" : unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		},
	};
	admitConstraintMessageFixture(fixture.doc, fixture.assets);
}

describe("constraint message emission", () => {
	it.each(["plain", "empty"] as const)(
		"keeps %s messages on their existing wire path",
		(scenario) => {
			const fixture = constraintMessageFixture(scenario);
			// Captured from the independently bundled former production builder,
			// with this admitted document and this fixed namespace.
			expect(
				createHash("sha256")
					.update(
						buildXForm(fixture.doc, fixture.formUuid, {
							xmlns: "urn:constraint-baseline",
							assets: fixture.assets,
						}),
					)
					.digest("hex"),
			).toBe(
				scenario === "plain"
					? "a3f7dd50d56f4cde8977c208086296480c151eba4b4783d826c6b2dd24d60fcf"
					: "372082d6908a2c62bafa62f2062ac44fcc45e93b843c21f9bab5fd7fc547ff78",
			);
			for (const root of routes(fixture)) {
				expect(carrierBinds(root)).toEqual([]);
				expect(
					descendants(root, "value").some((value) =>
						value.attributes.form?.startsWith("__nova_"),
					),
				).toBe(false);
				expect(bind(root).attributes["jr:constraintMsg"]).toBe(
					scenario === "plain"
						? "jr:itext('checked-constraintMsg')"
						: undefined,
				);
				expect(
					descendants(root, "alert").map((node) => node.attributes),
				).toEqual(
					scenario === "plain"
						? [{ ref: "jr:itext('checked-constraintMsg')" }]
						: [],
				);
			}
		},
	);

	it("keeps empty media-only messages on their existing alert path and gates media-off in lockstep", () => {
		const fixture = constraintMessageFixture("empty");
		const field = fixture.doc.fields[CONSTRAINT_CHECKED];
		if (field.kind !== "int") throw new Error("Expected integer field.");
		field.validate_msg_media = {
			image: mediaIds.icon,
			audio: mediaIds.audio,
			video: mediaIds.video,
		};
		admitConstraintMessageFixture(fixture.doc, fixture.assets);
		expect(
			createHash("sha256")
				.update(
					buildXForm(fixture.doc, fixture.formUuid, {
						xmlns: "urn:constraint-baseline",
						assets: fixture.assets,
					}),
				)
				.digest("hex"),
		).toBe("46f0d4103f193330f15a9991277e4ed933e7b0b2e3c4415a76cdff1521a4a6cb");
		for (const root of routes(fixture)) {
			expect(carrierBinds(root)).toEqual([]);
			expect(bind(root).attributes["jr:constraintMsg"]).toBe(
				"jr:itext('checked-constraintMsg')",
			);
			expect(
				entry(root, "en").children.map((value) => value.attributes.form),
			).toEqual([undefined, "markdown", "image", "audio", "video"]);
		}
		const off = readXmlEvidence(
			buildXForm(fixture.doc, fixture.formUuid, { xmlns: "urn:constraint" }),
		);
		expect(bind(off).attributes["jr:constraintMsg"]).toBeUndefined();
		expect(descendants(off, "alert")).toEqual([]);
	});

	it.each(["${0}", "${00}", "${12}", "${not-a-number}", "${", "&#36;&#123;0}"])(
		"protects decoded marker %s with exact literal data",
		(marker) => {
			const fixture = constraintMessageFixture("plain");
			const field = fixture.doc.fields[CONSTRAINT_CHECKED];
			if (field.kind !== "int") throw new Error("Expected integer field.");
			const suffix =
				" ' \" \\ <output/> &amp; 😀\u00a0\t\n\r \u0085\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
			field.validate_msg = proseText(marker + suffix);
			admitConstraintMessageFixture(fixture.doc, fixture.assets);
			for (const root of routes(fixture)) {
				const payload = onlyXml(
					entry(root, "en").children.filter(
						(value) => value.attributes.form === "__nova_piece_0",
					),
				).text;
				expect(payload).toMatch(/^[\x20-\x7e]+$/);
				expect(JSON.parse(payload)).toEqual({
					v:
						(marker === "&#36;&#123;0}" ? "${0}" : marker) +
						suffix.replace("&amp;", "&"),
				});
				expect(carrierBinds(root).map((node) => node.attributes)).toEqual([
					{
						nodeset: "/data/nova_constraint_message_checked",
						type: "xsd:string",
						relevant: "false()",
						readonly: "true()",
					},
				]);
				expect(descendants(root, "alert")).toEqual([]);
				expect(bind(root).attributes["jr:constraintMsg"]).toContain(
					"json-property(jr:itext('checked-constraintMsg;__nova_piece_0'), 'v')",
				);
				const control = onlyXml(
					descendants(root, "input").filter(
						(node) =>
							node.attributes.ref === "/data/nova_constraint_message_checked",
					),
				);
				expect(control.children.map((node) => node.attributes)).toEqual([
					{ ref: "jr:itext('checked-constraintMsg')" },
				]);
			}
		},
	);

	it("preserves all five prose kinds, standard text/media, instance requirements and strict identity resolution", () => {
		const fixture = constraintMessageFixture("all-kinds");
		for (const root of routes(fixture)) {
			const message = entry(root, "en");
			const ordinary = entry(root, "en", "ordinary_output-label");
			expect(message.children.slice(0, 2)).toEqual(
				ordinary.children.slice(0, 2),
			);
			expect(
				message.children
					.filter((value) =>
						["image", "audio", "video"].includes(value.attributes.form),
					)
					.map((value) => value.text),
			).toEqual(
				[mediaIds.icon, mediaIds.audio, mediaIds.video].map(
					(id) => `jr://file/${fixture.assets.get(id)?.wirePath}`,
				),
			);
			expect(
				descendants(root, "instance")
					.filter((node) => node.attributes.id !== undefined)
					.map((node) => node.attributes.id)
					.sort(),
			).toEqual(["casedb", "commcaresession"]);
			const expression = bind(root).attributes["jr:constraintMsg"];
			for (const value of message.children[0].children.filter(
				(node) =>
					node.name === "output" &&
					!node.attributes.value.startsWith("json-property("),
			)) {
				expect(expression).toContain(value.attributes.value);
				expect(expression).toContain(`count(${value.attributes.value}) > 1`);
			}
			expect(expression).toContain(
				"[hq_user_id=instance('commcaresession')/session/context/userid]/worker_status",
			);
			expect(expression).toContain("/external_extra");
			expect(expression).toContain("/data/checked");
			expect(expression).not.toContain(CONSTRAINT_VALUE);
		}
		delete fixture.doc.fields[CONSTRAINT_VALUE];
		fixture.doc.fieldOrder[fixture.formUuid] = fixture.doc.fieldOrder[
			fixture.formUuid
		].filter((uuid) => uuid !== CONSTRAINT_VALUE);
		expect(() =>
			buildXForm(fixture.doc, fixture.formUuid, {
				xmlns: "urn:constraint",
				moduleCaseType: "patient",
				assets: fixture.assets,
			}),
		).toThrow();
	});

	it("projects unchanged reference identities through renamed and nested paths", () => {
		const message: ProseTemplate = {
			parts: [
				{ kind: "field-ref", uuid: CONSTRAINT_VALUE },
				{ kind: "text", text: " / " },
				{ kind: "field-ref", uuid: CONSTRAINT_CHECKED },
			],
		};
		const stored = structuredClone(message);
		for (const nested of [false, true]) {
			const children = [
				f({
					kind: "text",
					uuid: CONSTRAINT_VALUE,
					id: nested ? "renamed" : "value",
				}),
				f({
					kind: "int",
					uuid: CONSTRAINT_CHECKED,
					id: "checked",
					validate: ". < 10",
					validate_msg: message,
				}),
			];
			const doc = buildDoc({
				modules: [
					{
						name: "Work",
						forms: [
							{
								name: "Check",
								type: "survey",
								fields: nested
									? [
											f({ kind: "group", id: "group", children }),
											f({
												kind: "group",
												id: "cousin",
												children: [
													f({
														kind: "int",
														id: "checked",
														validate: ". < 10",
														validate_msg: proseText("${0}"),
													}),
												],
											}),
										]
									: children,
							},
						],
					},
				],
			});
			admitConstraintMessageFixture(doc);
			const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
			const before = structuredClone(doc);
			const root = readXmlEvidence(
				buildXForm(doc, formUuid, { xmlns: "urn:constraint" }),
			);
			expect(
				bind(root, nested ? "/data/group/checked" : "/data/checked").attributes[
					"jr:constraintMsg"
				],
			).toContain(nested ? "/data/group/renamed" : "/data/value");
			expect(
				carrierBinds(root).map((owner) => owner.attributes.nodeset),
			).toEqual(
				nested
					? [
							"/data/group/nova_constraint_message_checked",
							"/data/cousin/nova_constraint_message_checked",
						]
					: ["/data/nova_constraint_message_checked"],
			);
			expect(doc).toEqual(before);
			expect(message).toEqual(stored);
		}
	});

	it("uses effective locale fallback, uniform form sets and direct single-reference terms", () => {
		const fixture = constraintMessageFixture("single");
		translate(fixture, {
			parts: [
				{ kind: "text", text: "Español ${0}: " },
				{ kind: "field-ref", uuid: CONSTRAINT_VALUE },
			],
		});
		for (const root of routes(fixture)) {
			const en = entry(root, "en"),
				es = entry(root, "es");
			expect(en.children.map((value) => value.attributes.form)).toEqual(
				es.children.map((value) => value.attributes.form),
			);
			expect(
				JSON.parse(
					onlyXml(
						en.children.filter(
							(value) => value.attributes.form === "__nova_piece_0",
						),
					).text,
				),
			).toEqual({ v: "" });
			expect(
				JSON.parse(
					onlyXml(
						es.children.filter(
							(value) => value.attributes.form === "__nova_piece_0",
						),
					).text,
				),
			).toEqual({ v: "Español ${0}: " });
			expect(bind(root).attributes["jr:constraintMsg"]).toContain(
				"= 'en', if(count(/data/value) > 1, '', /data/value), if(count(/data/value) > 1, '', concat(",
			);
			expect(bind(root).attributes["jr:constraintMsg"]).not.toContain(
				"concat(/data/value)",
			);
		}
		const plain = constraintMessageFixture("plain");
		translate(plain, proseText("Español ${0}"));
		expect(carrierBinds(routes(plain)[0])).toHaveLength(1);
		translate(plain, proseText("Español ${0}"), true);
		for (const root of routes(plain)) expect(carrierBinds(root)).toEqual([]);
	});

	it.each(["literal", "typed"] as const)(
		"keeps duplicate %s message groups distinct in every locale",
		(kind) => {
			const message: ProseTemplate =
				kind === "literal"
					? proseText("Literal ${0} / ${00}")
					: { parts: [{ kind: "field-ref", uuid: CONSTRAINT_VALUE }] };
			const doc = buildDoc({
				appName: "Duplicate wording",
				modules: [
					{
						name: "Checks",
						forms: [
							{
								name: "Check",
								type: "survey",
								fields: [
									f({ kind: "text", uuid: CONSTRAINT_VALUE, id: "value" }),
									...(["first", "second"] as const).map((id) =>
										f({
											kind: "int",
											id,
											validate: ". < 10",
											validate_msg: message,
										}),
									),
								],
							},
						],
					},
				],
			});
			doc.localization = {
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "spa"],
				translations: { spa: {} },
			};
			admitConstraintMessageFixture(doc);
			const fixture = {
				doc,
				formUuid: doc.formOrder[doc.moduleOrder[0]][0],
				assets: new Map(mediaManifest()),
			};
			for (const root of routes(fixture)) {
				for (const language of ["en", "es"]) {
					const groups = ["first", "second"].map((id) =>
						entry(root, language, `${id}-constraintMsg`),
					);
					expect(
						groups.map(
							(group) =>
								onlyXml(
									group.children.filter(
										(value) => value.attributes.form === "__nova_identity",
									),
								).text,
						),
					).toEqual(["first-constraintMsg", "second-constraintMsg"]);
					// Equal standard wording can still share every display/media
					// value; the inert identity alone prevents HQ's group merge.
					const otherValues = groups.map((group) =>
						group.children.filter(
							(value) => value.attributes.form !== "__nova_identity",
						),
					);
					expect(otherValues[0]).toEqual(otherValues[1]);
				}
			}
		},
	);

	it("reserves earlier and later authored siblings, previous allocations and Connect block ids", () => {
		for (const reverse of [false, true]) {
			const fields = [
				f({ kind: "text", id: "nova_constraint_message_checked" }),
				f({
					kind: "int",
					id: "checked",
					validate: ". < 10",
					validate_msg: proseText("${0}"),
				}),
				f({
					kind: "int",
					id: "checked_1",
					validate: ". < 10",
					validate_msg: proseText("${0}"),
				}),
				f({ kind: "text", id: "nova_constraint_message_checked_1" }),
			];
			const doc = buildDoc({
				modules: [
					{
						name: "Work",
						forms: [
							{
								name: "Check",
								type: "survey",
								fields: reverse ? fields.reverse() : fields,
							},
						],
					},
				],
			});
			admitConstraintMessageFixture(doc);
			const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
			const root = readXmlEvidence(
				buildXForm(doc, formUuid, {
					xmlns: "urn:constraint",
					connect: {
						learn_module: {
							id: "nova_constraint_message_checked_2",
							name: "Lesson",
							description: "Learn",
							time_estimate: 1,
						},
					},
				}),
			);
			const data = onlyXml(
				descendants(root, "instance").filter(
					(node) => node.attributes.id === undefined,
				),
			).children[0];
			expect(new Set(data.children.map((node) => node.name)).size).toBe(
				data.children.length,
			);
			expect(
				carrierBinds(root)
					.map((node) => node.attributes.nodeset)
					.sort(),
			).toEqual([
				"/data/nova_constraint_message_checked_1_1",
				"/data/nova_constraint_message_checked_3",
			]);
			expect(
				data.children.some(
					(node) =>
						node.name === "nova_constraint_message_checked_2" &&
						node.attributes["vellum:role"] === "ConnectLearnModule",
				),
			).toBe(true);
		}
	});

	it.each(["user", "expression", "query", "nested-query"] as const)(
		"keeps %s repeat owners beside the actual answer scope without count collisions",
		(scenario) => {
			const doc = containerWireFixture(scenario);
			for (const field of Object.values(doc.fields))
				if (field.kind === "text") {
					field.validate = xp(". = 'ok'");
					field.validate_msg = proseText("${0}");
				}
			admitConstraintMessageFixture(doc, mediaManifest());
			const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
			const root = readXmlEvidence(
				buildXForm(doc, formUuid, { xmlns: "urn:constraint" }),
			);
			const owners = carrierBinds(root);
			expect(owners.length).toBeGreaterThan(0);
			for (const owner of owners) {
				const parent = owner.attributes.nodeset.slice(
					0,
					owner.attributes.nodeset.lastIndexOf("/"),
				);
				expect(
					descendants(root, "input").some(
						(node) => node.attributes.ref === `${parent}/answer`,
					),
				).toBe(true);
			}
			const binds = descendants(root, "bind").map(
				(node) => node.attributes.nodeset,
			);
			expect(new Set(binds).size).toBe(binds.length);
			if (scenario.includes("query"))
				expect(
					owners.every((owner) => owner.attributes.nodeset.includes("/item/")),
				).toBe(true);
		},
	);

	it.each(["blank", "irrelevant", "multiple"] as const)(
		"guards the %s reference boundary without joining or changing admission",
		(scenario) => {
			const fixture = constraintMessageFixture(scenario);
			for (const root of routes(fixture)) {
				const path =
					scenario === "multiple" ? "/data/rows/value" : "/data/value";
				expect(bind(root).attributes["jr:constraintMsg"]).toBe(
					`if(jr:itext('checked-constraintMsg;__nova_mode') = 'media', jr:itext('checked-constraintMsg'), if(count(${path}) > 1, '', ${path}))`,
				);
				expect(
					entry(root, "en").children[0].children.map(
						(node) => node.attributes.value,
					),
				).toEqual([path]);
				if (scenario === "irrelevant")
					expect(bind(root, path).attributes.relevant).toBe("false()");
				if (scenario === "multiple")
					expect(
						onlyXml(descendants(root, "repeat")).attributes["jr:count"],
					).toContain("nova_count_rows");
			}
		},
	);
});
