/**
 * The reader's own defects and the closure of their lines.
 *
 * Contract: a defect of the reader's own stands behind exactly one
 * `unrecognized` finding whose name is a surface key, never the defect's
 * sentence; and its line (`ReaderDefectWhy`) is exactly its row's template
 * filled from closed slots, so no word of an app can reach the log. The
 * closure case calls every constructor with places whose every name, path and
 * tag is a marker, with each member of each closed argument and with values
 * outside them (an unregistered claim, an entry the index lacks, an issue
 * whose path holds the marker), and holds each line to its literal template:
 * a line holding the marker, an unknown claim or entry printed as given, or a
 * template that drifted fails by its text. The defects a stage raises from
 * what it reads (a source Nova's parser refuses, an `xmlns` that differs) are
 * provoked through the forms stage, each with its one finding, and the text stage's translation that Nova's own rule
 * refuses after the pairing passed it through every stage; the expression
 * stage's two are provoked in `provisional.test.ts`, the assembly's in
 * `assemble.test.ts`. A relation finding the manifest no longer permits names
 * its claim's surface key, or the object its place stands in, never an entry.
 */

import { current, produce } from "immer";
import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { translationUnitRoles } from "@/lib/domain/translationUnits";
import { type HqPlace, READ_STANDINGS } from "@/lib/publish/hqFindings";
import { inventoryIndex } from "../../surface/inventory";
import { Accounting } from "../accounting";
import { defineClaims, drop, take } from "../claims";
import { READER_DEFECT_CODES, readerDefect } from "../defects";
import { EXTERNAL_ENTITY_KINDS, type ExternalEntityKind } from "../identity";
import { STAGES } from "../index";
import { appPlace, formPlace, menuPlace, placeKey } from "../place";
import { readForm, XMLNS, xformSource } from "../xform/__tests__/formReading";
import { finishText } from "../xform/prose";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "./readerInput";

const MARKER = "MARKER";
const COMMENTS = "questions/xml-comments-processing-instructions";
const HELD = "application-and-settings/doc-type-application";

const CLAIMS = defineClaims("defectsTest", {
	held: take(HELD, "schema:Application.doc_type"),
	heldAgain: take(HELD, "schema:Application.doc_type"),
	heldDrop: drop(HELD, "schema:Application.doc_type"),
	wrongKey: take(HELD, "schema:Application.name"),
	comment: drop(COMMENTS, null),
});

/** Every kind of place, each name, path and tag the marker, with its key. */
const PLACES: readonly (readonly [HqPlace, string])[] = [
	[{ kind: "app" }, "app"],
	[{ kind: "app-settings" }, "app-settings"],
	[{ kind: "languages" }, "languages"],
	[{ kind: "organization" }, "organization"],
	[{ kind: "lookup-table", tag: MARKER }, "lookup-table"],
	[{ kind: "media", path: MARKER }, "media"],
	[{ kind: "menu", menu: 2, name: MARKER }, "menu[2]"],
	[{ kind: "case-list", menu: 2, name: MARKER }, "case-list[2]"],
	[{ kind: "case-detail", menu: 2, name: MARKER }, "case-detail[2]"],
	[{ kind: "search", menu: 2, name: MARKER }, "search[2]"],
	[
		{ kind: "form", menu: 2, form: 0, menuName: MARKER, name: MARKER },
		"form[2,0]",
	],
	[
		{
			kind: "question",
			menu: 2,
			form: 0,
			menuName: MARKER,
			formName: MARKER,
			path: `${MARKER}/${MARKER}`,
		},
		"question[2,0]",
	],
];

describe("each line is its template, from closed slots", () => {
	it.each(PLACES)("at %j", (place, key) => {
		const lines: [string, string][] = [
			[
				readerDefect.claimedTwice(place, "defectsTest.held", MARKER),
				`claimed twice at ${key}: first by defectsTest.held, then by unregistered-claim`,
			],
			[
				readerDefect.claimNotPermitted(place, MARKER, null),
				`claim unregistered-claim at ${key} is not permitted by no-such-entry, which is now no-standing`,
			],
			[
				readerDefect.claimedNotRead(place, "defectsTest.comment"),
				`claimed and not read at ${key}: defectsTest.comment`,
			],
			[
				readerDefect.identityMetTwice(place, MARKER as ExternalEntityKind),
				`identity met twice at ${key}: a unknown-kind key`,
			],
			[
				readerDefect.formSource(place, MARKER as "malformed"),
				`form source at ${key}: Nova's parser answered unknown-kind`,
			],
			[
				readerDefect.xmlnsDiffers(place),
				`xmlns differs between the form and its source at ${key}`,
			],
			[
				readerDefect.assembly(place, {
					path: ["modules", MARKER, 3],
					code: "invalid_type",
				}),
				`assembly at ${key}: modules: invalid_type`,
			],
			[
				readerDefect.assembly(place, { path: [MARKER], code: MARKER }),
				`assembly at ${key}: root: unknown-code`,
			],
			[
				readerDefect.unregisteredExpressionClaim(place, MARKER),
				`expression claim at ${key} names no-such-entry, which no registered claim holds`,
			],
			[
				readerDefect.unregisteredExpressionClaim(place, COMMENTS),
				`expression claim at ${key} names ${COMMENTS}, which no registered claim holds`,
			],
			[
				readerDefect.translation(
					place,
					MARKER as "form-name",
					-1,
					MARKER as "value-kind",
				),
				`translation at ${key}: unknown-role, language unknown-position: unknown-issue`,
			],
			[
				readerDefect.expressionNotWrittenBack(place, MARKER),
				`Nova read an expression from CommCare HQ and could not write the same expression back, at ${key}: unknown-reason. Nova treats the spellings in \`lib/commcare/reader/syntaxCompare.ts\` as one; this one needs a row there with a native vector, or a manifest entry that names it.`,
			],
			[
				readerDefect.noCaseDatum(place),
				`Nova couldn't find the session value that holds the case this form opens with, at ${key}, so it can't read the form's display condition as CommCare HQ builds it. CommCare HQ treats the form as one that opens on a case and Nova's reading of its menu and case operations does not; check what the case management reader made of this form.`,
			],
			[
				readerDefect.keyNotNamed(place, MARKER, MARKER, MARKER),
				`claim unregistered-claim at ${key} would record unnamed-key under no-such-entry, which does not name that key. Record the claim under the entry that reads that key, or with no key where its entry names none of the node's keys.`,
			],
			[
				readerDefect.keyNotNamed(
					place,
					"defectsTest.held",
					HELD,
					"xform:model/bind@calculate",
				),
				`claim defectsTest.held at ${key} would record xform:model/bind@calculate under ${HELD}, which does not name that key. Record the claim under the entry that reads that key, or with no key where its entry names none of the node's keys.`,
			],
			[
				readerDefect.emissionThrew(place, MARKER),
				`Nova read part of an app from CommCare HQ and its own writer could not write that part back, at ${key}: another-emitter threw. The reader built something Nova's documents never hold; check what the stages before it made of this place.`,
			],
		];
		for (const [line, template] of lines) {
			expect(line).toBe(template);
			expect(line).not.toContain(MARKER);
		}
	});

	it("writes each member of each closed slot as itself", () => {
		const place = appPlace();
		for (const standing of READ_STANDINGS)
			expect(
				readerDefect.claimNotPermitted(place, "defectsTest.held", standing),
			).toBe(
				`claim defectsTest.held at app is not permitted by ${HELD}, which is now ${standing}`,
			);
		for (const kind of EXTERNAL_ENTITY_KINDS)
			expect(readerDefect.identityMetTwice(place, kind)).toBe(
				`identity met twice at app: a ${kind} key`,
			);
		for (const kind of ["xml-version", "malformed"] as const)
			expect(readerDefect.formSource(place, kind)).toBe(
				`form source at app: Nova's parser answered ${kind}`,
			);
		for (const role of translationUnitRoles)
			for (const issue of [
				"value-kind",
				"blank-content",
				"protected-content",
			] as const)
				expect(readerDefect.translation(place, role, 2, issue)).toBe(
					`translation at app: ${role}, language 2: ${issue}`,
				);
		for (const reason of ["no-case-datum", "parse:syntax", "differs:binary"])
			expect(readerDefect.expressionNotWrittenBack(place, reason)).toContain(
				`at app: ${reason}.`,
			);
		expect(
			readerDefect.expressionNotWrittenBack(place, "differs:MARKER"),
		).toContain("at app: unknown-reason.");
	});

	it("names an emitter only from its closed list", () => {
		const place = appPlace();
		expect(readerDefect.emissionThrew(place, "expandDoc")).toContain(
			"at app: expandDoc threw.",
		);
		expect(readerDefect.emissionThrew(place, "MARKER")).toContain(
			"at app: another-emitter threw.",
		);
	});

	it("names thirteen codes", () => {
		expect(READER_DEFECT_CODES).toHaveLength(13);
	});
});

describe("a defect stands behind one finding named by a surface key", () => {
	const place = appPlace();
	it.each([
		[
			"a second claim",
			(books: Accounting) => {
				const root = books.json({ doc_type: "LinkedApplication" }, place);
				expect(root.take("doc_type", CLAIMS.held, String).value).toBe(
					"LinkedApplication",
				);
				root.take("doc_type", CLAIMS.heldAgain, String);
			},
			"claimed twice at app: first by defectsTest.held, then by defectsTest.heldAgain",
		],
		[
			"a claim the manifest no longer permits",
			(books: Accounting) => {
				books
					.json({ doc_type: "LinkedApplication" }, place)
					.drop("doc_type", CLAIMS.heldDrop);
			},
			`claim defectsTest.heldDrop at app is not permitted by ${HELD}, which is now held`,
		],
		[
			"a claim under a key its entry does not name",
			(books: Accounting) => {
				books
					.json({ doc_type: "LinkedApplication" }, place)
					.take("doc_type", CLAIMS.wrongKey, String);
			},
			`claim defectsTest.wrongKey at app would record schema:Application.name under ${HELD}, which does not name that key. Record the claim under the entry that reads that key, or with no key where its entry names none of the node's keys.`,
		],
		[
			"a held value nothing read",
			(books: Accounting) => {
				books
					.json({ doc_type: "LinkedApplication" }, place)
					.take("doc_type", CLAIMS.held, String);
			},
			"claimed and not read at app: defectsTest.held",
		],
		[
			"an identity met twice",
			(books: Accounting) => {
				books.json({}, place);
				books.identity(
					{
						ok: false,
						key: { kind: "module", parts: [MARKER] },
						firstPlace: MARKER,
					},
					place,
					"schema:Application.doc_type",
				);
			},
			"identity met twice at app: a module key",
		],
	])("%s", (_label, provoke, line) => {
		const books = new Accounting(inventoryIndex(), { log: "counts" });
		provoke(books);
		const { findings, defects } = books.close();
		expect(defects.map((defect) => defect.why)).toEqual([line]);
		expect(findings).toEqual([
			{
				code: "unrecognized",
				standing: "not-yet",
				place,
				subject: null,
				detail: { name: "schema:Application.doc_type" },
			},
		]);
	});
});

describe("a relation finding the manifest no longer permits", () => {
	it.each([
		[appPlace(), "schema:Application"],
		[menuPlace(2, MARKER), "schema:Module"],
		[formPlace(2, 0, MARKER, MARKER), "schema:Form"],
	])(
		"names the object its place stands in, never the entry, where the claim has no key (%j)",
		(place, name) => {
			const books = new Accounting(inventoryIndex(), { log: "counts" });
			books.finding(CLAIMS.comment, place);
			const { findings, defects } = books.close();
			expect(defects.map((defect) => defect.why)).toEqual([
				`claim defectsTest.comment at ${placeKey(place)} is not permitted by ${COMMENTS}, which is now inert`,
			]);
			expect(defects.map((defect) => defect.name)).toEqual([name]);
			expect(findings).toEqual([
				{
					code: "unrecognized",
					standing: "not-yet",
					place,
					subject: null,
					detail: { name },
				},
			]);
		},
	);

	it("names the claim's own surface key where it has one", () => {
		const books = new Accounting(inventoryIndex(), { log: "counts" });
		books.finding(CLAIMS.heldDrop, appPlace());
		const { findings } = books.close();
		expect(findings.map((finding) => finding.detail.name)).toEqual([
			"schema:Application.doc_type",
		]);
	});
});

describe("a defect the forms stage raises", () => {
	/** The one finding and the defect lines of a reading of `source`. */
	async function provoked(
		source: string,
		options: Parameters<typeof readForm>[1] = {},
	) {
		const reading = await readForm(source, options);
		return {
			place: reading.form.place,
			findings: reading.closed.findings
				.filter(
					(finding) =>
						finding.place.kind === "form" || finding.place.kind === "question",
				)
				.map((finding) => [finding.code, finding.place, finding.detail.name]),
			whys: reading.closed.defects.map((defect) => defect.why),
		};
	}

	it("stands behind a source Nova's parser refuses, by the kind it answered", async () => {
		const source = xformSource({ data: "<q/>" }).replace(
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<?xml version="1.1" encoding="UTF-8"?>',
		);
		const { place, findings, whys } = await provoked(source);
		expect(whys).toEqual([readerDefect.formSource(place, "xml-version")]);
		expect(findings).toEqual([["unrecognized", place, "xform:h:html"]]);
	});

	it("stands behind an xmlns that differs between the form and its source", async () => {
		const source = xformSource({
			data: "<q/>",
			model: '<bind nodeset="/data/q" type="xsd:string"/>',
		}).replace(
			`xmlns="${XMLNS}"`,
			'xmlns="http://openrosa.org/formdesigner/another-form"',
		);
		const { place, findings, whys } = await provoked(source);
		expect(whys).toEqual([readerDefect.xmlnsDiffers(place)]);
		expect(findings).toContainEqual([
			"unrecognized",
			place,
			"schema:Form.xmlns",
		]);
	});
});

describe("a defect the text stage raises", () => {
	it("stands behind a translation Nova's own rule refuses after the pairing passed it", async () => {
		const label = (lang: string, text: string) =>
			`<translation lang="${lang}"${lang === "en" ? ' default=""' : ""}><text id="q-label"><value>${text} <output value="/data/who"/></value></text></translation>`;
		const source = xformSource({
			data: "<who/><q/>",
			model: [
				'<bind nodeset="/data/who" type="xsd:string"/>',
				'<bind nodeset="/data/q" type="xsd:string"/>',
				`<itext>${label("en", "Hello")}${label("fr", "Bonjour")}</itext>`,
			].join(""),
			body: [
				'<input ref="/data/who"><label>Who</label></input>',
				'<input ref="/data/q"><label ref="jr:itext(\'q-label\')"/></input>',
			].join(""),
		});
		const body = {
			...retainedSourceBody("shell/app-source"),
			modules: [
				{
					doc_type: "Module",
					unique_id: "m-reader",
					name: { en: "Menu" },
					case_type: "",
					forms: [
						{
							doc_type: "Form",
							unique_id: "r1",
							xmlns: XMLNS,
							name: { en: "Form" },
						},
					],
				},
			],
			_attachments: { "r1.xml": source },
			langs: ["en", "fr"],
		};
		const input = readerInput(await sourceFromBody(body));
		const ctx = readContext({ ...input, recordDialect: () => undefined });
		for (const stage of STAGES) {
			if (stage === finishText) {
				// The French text pairs its one output with the English one, so the
				// pairing passes it; the English label then holds the reference twice,
				// which a translation holding it once does not keep.
				ctx.doc = produce(ctx.doc as BlueprintDoc, (doc) => {
					for (const field of Object.values(doc.fields)) {
						if (field.id !== "q" || !("label" in field)) continue;
						const parts = field.label?.parts ?? [];
						const reference = parts.find((part) => part.kind !== "text");
						if (reference === undefined)
							throw new Error("The label read no reference.");
						parts.push(current(reference));
					}
				});
			}
			stage(ctx);
		}
		const { findings, defects } = ctx.close();
		const question = findings.find(
			(finding) => finding.place.kind === "question",
		)?.place;
		if (question === undefined) throw new Error("No finding at the question.");
		expect(defects.map((defect) => defect.why)).toEqual([
			readerDefect.translation(question, "field-label", 1, "protected-content"),
		]);
		expect(
			findings
				.filter((finding) => finding.code === "unrecognized")
				.map((finding) => [finding.place, finding.detail.name]),
		).toEqual([[question, "xform:model/itext/translation/text/value"]]);
	});
});
