/**
 * A refused thing is refused whole: a reading of a source that holds one cause
 * Nova cannot hold gives that cause's one finding, and nothing that belongs to
 * what was refused is reported again or left unclaimed.
 *
 * Contract: what belongs to a refused question, choice, repeat, control,
 * message or block and stands elsewhere in the source (the itext its label,
 * hint, help or message names, its bind's type and logic, the label of a
 * refused repeat's wrapper group, the node a refused control names) stands
 * under that refusal (`refusals.ts`, `itext.ts::settleItext`); a source
 * refused whole (blank, holding no question as CommCare HQ counts one, a data
 * root named other than `data`) refuses its form whole, so nothing of the form
 * is read; a node CommCare HQ's build or a plugin of HQ's form builder owns (a
 * root `case` or `commcare_usercase` HQ's build appends, a ledger block, a
 * case block no Save to Case role marks, content marked
 * `vellum:ignore="retain"`) is refused whole at its question; a callout is
 * refused by the decisive cause its intent names (the print action,
 * `appearance="quick"`); and a repeated language code is one finding at the
 * languages.
 *
 * The plausible failure: the true finding beside `unrecognized` findings for
 * the itext, binds and labels of what was refused, a second manifest finding
 * restating the cause (the node a refused control names read as a Hidden
 * Value, a reference to a refused text refused again at its question), or a
 * reader defect.
 */

import { describe, expect, it } from "vitest";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import {
	type InputOptions,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readHqApp } from "../../index";
import type { ReadOutcome } from "../../types";
import { XMLNS, xformSource } from "./formReading";

const Q = (id: string) => `questions/${id}`;

/** An itext block of one English translation holding each `[id, value]`. */
function itext(texts: readonly (readonly [string, string])[]): string {
	return `<itext><translation lang="en" default="">${texts
		.map(([id, value]) => `<text id="${id}">${value}</text>`)
		.join("")}</translation></itext>`;
}

interface WholeOptions {
	readonly langs?: readonly string[];
	readonly media?: InputOptions["media"];
	/** The menu's case type and the form's stored keys, beside its doc type and `xmlns`. */
	readonly caseType?: string;
	readonly form?: Readonly<Record<string, unknown>>;
}

/** A form's source read through every stage of a whole reading. */
async function readWhole(
	source: string,
	options: WholeOptions = {},
): Promise<ReadOutcome> {
	const body = {
		...retainedSourceBody("shell/app-source"),
		modules: [
			{
				doc_type: "Module",
				unique_id: "m-reader",
				name: { en: "Menu" },
				case_type: options.caseType ?? "",
				forms: [
					{
						doc_type: "Form",
						unique_id: "r1",
						xmlns: XMLNS,
						name: { en: "Form" },
						...options.form,
					},
				],
			},
		],
		_attachments: { "r1.xml": source },
		...(options.langs === undefined ? {} : { langs: options.langs }),
	};
	const input = readerInput(await sourceFromBody(body), {
		media: options.media,
	});
	return readHqApp({ ...input, recordDialect: () => undefined });
}

/** The account's every finding, by entry and the kind and path of its place, with no defect. */
function account(outcome: ReadOutcome): string[] {
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "account") return [];
	return outcome.findings.map((one) => {
		const place = one.place as { kind: string; path?: string };
		return `${one.code} @${place.kind}${place.path === undefined ? "" : `:${place.path}`}`;
	});
}

/** A text question `other` beside the case, so a form holds a question Nova reads. */
const OTHER = {
	data: "<other/>",
	bind: '<bind nodeset="/data/other" type="xsd:string"/>',
	body: '<input ref="/data/other"><label ref="jr:itext(\'other-label\')"/></input>',
	text: ["other-label", "<value>Other</value>"] as const,
};

describe("a refused question, choice, repeat or message, with what belongs to it", () => {
	const cases: readonly (readonly [string, string, string])[] = [
		[
			"a question of a kind Nova does not hold, its label and hint itext",
			xformSource({
				data: `<w/>${OTHER.data}`,
				model: `<bind nodeset="/data/w" type="xsd:long"/>${OTHER.bind}${itext([
					["w-label", "<value>Weight</value>"],
					["w-hint", "<value>In grams</value>"],
					OTHER.text,
				])}`,
				body: `<input ref="/data/w"><label ref="jr:itext('w-label')"/><hint ref="jr:itext('w-hint')"/></input>${OTHER.body}`,
			}),
			`${Q("long-xsd-long")} @question:w`,
		],
		[
			"a choice whose value is refused, its label and the label's itext",
			xformSource({
				data: "<colour/>",
				model: `<bind nodeset="/data/colour"/>${itext([
					["colour-label", "<value>Colour</value>"],
					["colour-red", "<value>Red</value>"],
					["colour-blue", "<value>Blue</value>"],
				])}`,
				body: '<select1 ref="/data/colour"><label ref="jr:itext(\'colour-label\')"/><item><label ref="jr:itext(\'colour-red\')"/><value>red</value></item><item><label ref="jr:itext(\'colour-blue\')"/><value>sky blue</value></item></select1>',
			}),
			`${Q("choice-value-with-whitespace-empty-or-duplicated")} @question:colour`,
		],
		[
			"a repeat refused for its count, its wrapper group's label and that label's itext",
			xformSource({
				data: `<rows jr:template=""><x/></rows>${OTHER.data}`,
				model: `<bind nodeset="/data/rows/x" type="xsd:string"/>${OTHER.bind}${itext(
					[
						["rows-label", "<value>Rows</value>"],
						["x-label", "<value>X</value>"],
						OTHER.text,
					],
				)}`,
				body: `<group><label ref="jr:itext('rows-label')"/><repeat nodeset="/data/rows" jr:noAddRemove="true()"><input ref="/data/rows/x"><label ref="jr:itext('x-label')"/></input></repeat></group>${OTHER.body}`,
			}),
			`${Q("jr-noaddremove-without-jr-count")} @question:rows`,
		],
		[
			"a literal validation message, the alert and the itext it names",
			xformSource({
				data: `<age/>${OTHER.data}`,
				model: `<bind nodeset="/data/age" type="xsd:int" constraint=". &lt; 120" jr:constraintMsg="Too old"/>${OTHER.bind}${itext(
					[
						["age-label", "<value>Age</value>"],
						["age-msg", "<value>Too old</value>"],
						OTHER.text,
					],
				)}`,
				body: `<input ref="/data/age"><label ref="jr:itext('age-label')"/><alert ref="jr:itext('age-msg')"/></input>${OTHER.body}`,
			}),
			`${Q("literal-jr-constraintmsg-text-no-itext")} @question:age`,
		],
		[
			"a question bound to a node with element children, its bind's type",
			xformSource({
				data: `<info><score/></info>${OTHER.data}`,
				model: `<bind nodeset="/data/info" type="xsd:string"/>${OTHER.bind}${itext(
					[["info-label", "<value>Info</value>"], OTHER.text],
				)}`,
				body: `<input ref="/data/info"><label ref="jr:itext('info-label')"/></input>${OTHER.body}`,
			}),
			`${Q("a-question-other-than-a-group-or-repeat-whose-data-node-has")} @question:info`,
		],
		[
			"a Hidden Value with children, its bind's calculate",
			xformSource({
				data: `<grp><a/></grp>${OTHER.data}`,
				model: `<bind nodeset="/data/grp" calculate="1 + 1"/>${OTHER.bind}${itext([OTHER.text])}`,
				body: OTHER.body,
			}),
			`${Q("hidden-value-with-children")} @question:grp`,
		],
		[
			"an unknown control, the node it names and that node's bind",
			xformSource({
				data: `<level/>${OTHER.data}`,
				model: `<bind nodeset="/data/level" type="xsd:int"/>${OTHER.bind}${itext([OTHER.text])}`,
				body: `${OTHER.body}<range ref="/data/level" start="1" end="5" step="1"><label>Level</label></range>`,
			}),
			`${Q("unknown-body-control-vellum-readonly-e-g-range")} @form`,
		],
		[
			"a repeat with no group around it, the node it names and what that holds",
			xformSource({
				data: `<checks jr:template=""><check/></checks>${OTHER.data}`,
				model: `<bind nodeset="/data/checks/check" type="xsd:string"/>${OTHER.bind}${itext([OTHER.text])}`,
				body: `${OTHER.body}<repeat nodeset="/data/checks"><input ref="/data/checks/check"><label>Check</label></input></repeat>`,
			}),
			`${Q("bare-repeat-with-no-group-wrapper")} @form`,
		],
		[
			"a text two of one translation hold, and the label that names it",
			xformSource({
				data: `<w/>${OTHER.data}`,
				model: `<bind nodeset="/data/w" type="xsd:string"/>${OTHER.bind}${itext(
					[
						["w-label", "<value>Weight</value>"],
						["w-label", "<value>Weight</value>"],
						OTHER.text,
					],
				)}`,
				body: `<input ref="/data/w"><label ref="jr:itext('w-label')"/></input>${OTHER.body}`,
			}),
			`${Q("duplicate-text-id-in-one-translation-jr-itext-with-double-quotes")} @form`,
		],
		[
			"a text only an expression names, and the output in a label that reads it",
			xformSource({
				data: OTHER.data,
				model: `${OTHER.bind}${itext([
					["note", "<value>A note</value>"],
					[
						"other-label",
						"<value>Other <output value=\"jr:itext('note')\"/></value>",
					],
				])}`,
				body: OTHER.body,
			}),
			`${Q("itext-entry-referenced-only-from-jr-itext-in-an-expression")} @form`,
		],
	];
	for (const [name, source, finding] of cases)
		it(`reads ${name} as one finding`, async () => {
			expect(account(await readWhole(source))).toEqual([finding]);
		});
});

describe("a source refused whole refuses its form whole", () => {
	const cases: readonly (readonly [string, string, string])[] = [
		[
			"a source as HQ makes a new form, holding no question",
			xformSource({ data: "" }),
			"forms-and-case-writes/blank-source-or-no-non-group-question @form",
		],
		[
			"a source whose questions are all groups",
			xformSource({
				data: "",
				body: "<group><label>Empty</label></group>",
			}),
			"forms-and-case-writes/blank-source-or-no-non-group-question @form",
		],
		...["instance", "parsererror", "bind"].map(
			(root): [string, string, string] => [
				`a root called ${root} that the designer reads as its own element`,
				xformSource({
					root,
					data: "<q/>",
					model: `<bind nodeset="/${root}/q" type="xsd:string"/>`,
					body: `<input ref="/${root}/q"><label>Q</label></input>`,
				}),
				`${Q("answer-root-that-the-form-designer-reads-as-its-own-element")} @form`,
			],
		),
		[
			"a root whose name the worker cannot use in a path",
			xformSource({
				root: "患者",
				data: "<q/>",
				model:
					'<bind nodeset="/患者/q" type="xsd:string" relevant="/患者/q = 1"/>',
				body: '<input ref="/患者/q"><label>Q</label></input>',
			}),
			`${Q("data-root-name-that-workers-cannot-address")} @form`,
		],
	];
	for (const [name, source, finding] of cases)
		it(`reads ${name} as one finding, and none of what the form's actions name`, async () => {
			expect(
				account(
					await readWhole(source, {
						caseType: "patient",
						form: {
							requires: "none",
							actions: {
								doc_type: "FormActions",
								open_case: {
									doc_type: "OpenCaseAction",
									name_update: {
										doc_type: "ConditionalCaseUpdate",
										question_path: "/data/name",
										update_mode: "always",
									},
									condition: {
										doc_type: "FormActionCondition",
										type: "always",
										question: null,
										answer: null,
										operator: null,
									},
									external_id: null,
								},
							},
						},
					}),
				),
			).toEqual([finding]);
		});
});

describe("a node CommCare HQ's build or a plugin of HQ's form builder owns", () => {
	const ALWAYS = {
		doc_type: "FormActionCondition",
		type: "always",
		question: null,
		answer: null,
		operator: null,
	};
	const registration = {
		requires: "none",
		actions: {
			doc_type: "FormActions",
			open_case: {
				doc_type: "OpenCaseAction",
				name_update: {
					doc_type: "ConditionalCaseUpdate",
					question_path: "/data/other",
					update_mode: "always",
				},
				condition: ALWAYS,
				external_id: null,
			},
		},
	};
	const savesToWorker = {
		requires: "none",
		actions: {
			doc_type: "FormActions",
			usercase_update: {
				doc_type: "UpdateCaseAction",
				update: {
					note: {
						doc_type: "ConditionalCaseUpdate",
						question_path: "/data/other",
						update_mode: "always",
					},
				},
				condition: ALWAYS,
			},
		},
	};
	const rootQuestion = (name: string) =>
		xformSource({
			data: `${OTHER.data}<${name}/>`,
			model: `${OTHER.bind}<bind nodeset="/data/${name}" type="xsd:string"/>${itext(
				[OTHER.text, [`${name}-label`, "<value>Note</value>"]],
			)}`,
			body: `${OTHER.body}<input ref="/data/${name}"><label ref="jr:itext('${name}-label')"/></input>`,
		});

	it("refuses a root question `case` where HQ's build writes the form's own case block", async () => {
		expect(
			account(
				await readWhole(rootQuestion("case"), {
					caseType: "patient",
					form: registration,
				}),
			),
		).toEqual([
			`${Q("a-root-question-case-in-a-form-where-hq-writes-the-primary-case")} @question:case`,
		]);
	});

	it("refuses a submitted case answer in a form that HQ can build", async () => {
		expect(account(await readWhole(rootQuestion("case")))).toEqual([
			`${Q("submitted-node-consumed-as-case")} @question:case`,
		]);
	});

	it.each(["Case", "CASE"])(
		"refuses %s even outside HQ's case-writing form",
		async (name) => {
			expect(account(await readWhole(rootQuestion(name)))).toEqual([
				`${Q("submitted-node-consumed-as-case")} @question:${name}`,
			]);
		},
	);

	it.each(["case_note", "script", "registration", "FiXtUrE", "schema", "sync"])(
		"can bring in the ordinary answer %s",
		async (name) => {
			expect(account(await readWhole(rootQuestion(name)))).toEqual([]);
		},
	);

	it("offers Android for a question Web Apps would read as an instruction", async () => {
		const result = await readWhole(rootQuestion("Registration"));
		if (result.kind !== "read")
			throw new Error(JSON.stringify(result.findings));
		expect(result.draft.declaration).toMatchObject({
			kind: "choices",
			choices: [{ runsOnlyOn: "android" }],
		});
	});

	it("refuses a root question `commcare_usercase` where the form saves to the worker's record", async () => {
		expect(
			account(
				await readWhole(rootQuestion("commcare_usercase"), {
					form: savesToWorker,
				}),
			),
		).toEqual([
			`${Q("a-root-question-commcare-usercase-in-a-form-with-usercase")} @question:commcare_usercase`,
		]);
	});

	it("refuses a ledger block as the form builder's CommTrack plugin writes it, with its predicate binds and setvalues", async () => {
		expect(
			account(
				await readWhole(
					xformSource({
						data: `${OTHER.data}<balance xmlns="http://commcarehq.org/ledger/v1" entity-id="" date="" section-id="stock" type="bal-0"><entry id="" quantity=""/></balance>`,
						model: `${OTHER.bind}<bind nodeset="/data/balance[@type='bal-0']/entry/@quantity" calculate="/data/other"/><setvalue event="xforms-ready" ref="/data/balance[@type='bal-0']/@date" value="now()"/>${itext([OTHER.text])}`,
						body: OTHER.body,
					}),
				),
			),
		).toEqual([
			`${Q("balance-transfer-dispense-receive-ledger-blocks")} @question:balance`,
		]);
	});

	it("refuses a root case block no Save to Case role marks, with its attribute binds", async () => {
		expect(
			account(
				await readWhole(
					xformSource({
						data: `${OTHER.data}<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="" date_modified="" user_id=""><update><note/></update></case>`,
						model: `${OTHER.bind}<bind nodeset="/data/case/@case_id" calculate="uuid()"/><bind nodeset="/data/case/update/note" calculate="/data/other"/>${itext([OTHER.text])}`,
						body: OTHER.body,
					}),
				),
			),
		).toEqual([
			`${Q("hand-written-case-block-without-vellum-role-incl-a-root-data")} @question:case`,
		]);
	});

	it("refuses a data node marked to be kept as it stands, with its control and its texts", async () => {
		expect(
			account(
				await readWhole(
					xformSource({
						data: `${OTHER.data}<kept vellum:ignore="retain"/>`,
						model: `${OTHER.bind}<bind nodeset="/data/kept" type="xsd:string"/>${itext(
							[OTHER.text, ["kept-label", "<value>Kept</value>"]],
						)}`,
						body: `${OTHER.body}<input ref="/data/kept"><label ref="jr:itext('kept-label')"/></input>`,
					}),
				),
			),
		).toEqual([
			`${Q("content-marked-vellum-ignore-retain-vellum-ignored")} @question:kept`,
		]);
	});
});

describe("a callout, by the decisive cause its intent names", () => {
	const callout = (intentAttributes: string, inner = "") =>
		xformSource({
			data: `${OTHER.data}<code/>`,
			model: `${OTHER.bind}<bind nodeset="/data/code" type="intent"/>${itext([
				OTHER.text,
				["code-label", "<value>Code</value>"],
			])}`,
			head: `<odkx:intent id="scan" ${intentAttributes}>${inner}</odkx:intent>`,
			body: `${OTHER.body}<input ref="/data/code" appearance="intent:scan"><label ref="jr:itext('code-label')"/></input>`,
		});

	it("refuses a callout whose action and question IDs disagree, including its label text", async () => {
		expect(
			account(await readWhole(callout('class="org.example.SCAN"'))),
		).toEqual([
			`${Q("android-app-callout-that-cannot-be-recreated")} @question:code`,
		]);
	});

	it("refuses a callout given the print action as the print question", async () => {
		expect(
			account(
				await readWhole(
					callout(
						'class="org.commcare.dalvik.action.PRINT"',
						'<extra key="cc:print_template_reference" ref="\'jr://file/commcare/text/print.html\'"/>',
					),
				),
			),
		).toEqual([
			`${Q("print-callout-class-org-commcare-dalvik-action-print-extra-cc")} @question:code`,
		]);
	});

	it("refuses a callout whose intent appears quick by that appearance", async () => {
		expect(
			account(
				await readWhole(callout('class="org.example.SCAN" appearance="quick"')),
			),
		).toEqual([`${Q("odkx-intent-appearance-quick")} @question:code`]);
	});
});

describe("a language code `langs` repeats", () => {
	it("is one finding at the languages, every text of its translation under it", async () => {
		expect(
			account(
				await readWhole(
					xformSource({
						data: OTHER.data,
						model: `${OTHER.bind}${itext([OTHER.text])}`,
						body: OTHER.body,
					}),
					{ langs: ["en", "en"] },
				),
			),
		).toEqual([
			"application-and-settings/a-non-empty-langs-code-outside-that-grammar-or-repeated @languages",
		]);
	});
});

it("reads a photo’s help text and a message’s help image even when the help has no text", async () => {
	const photo = await readWhole(
		xformSource({
			data: `<photo/>${OTHER.data}`,
			model: `<bind nodeset="/data/photo" type="binary"/>${OTHER.bind}${itext([
				["photo-label", "<value>Photo</value>"],
				["photo-help", "<value>Hold it still</value>"],
				OTHER.text,
			])}`,
			body: `<upload mediatype="image/*" ref="/data/photo"><label ref="jr:itext('photo-label')"/><help ref="jr:itext('photo-help')"/></upload>${OTHER.body}`,
		}),
	);
	expect(photo.kind === "account" ? photo.findings : []).toEqual([]);
	expect(photo.kind).toBe("read");
	if (photo.kind !== "read") return;
	expect(
		Object.values(photo.draft.doc.fields).find((field) => field.id === "photo"),
	).toMatchObject({
		kind: "image",
		help: { parts: [{ kind: "text", text: "Hold it still" }] },
	});
	const note = await readWhole(
		xformSource({
			data: `<note/>${OTHER.data}`,
			model: `${OTHER.bind}${itext([
				["note-label", "<value>Note</value>"],
				[
					"note-help",
					'<value/><value form="image">jr://file/commcare/image/note.png</value>',
				],
				OTHER.text,
			])}`,
			body: `<trigger ref="/data/note" appearance="minimal"><label ref="jr:itext('note-label')"/><help ref="jr:itext('note-help')"/></trigger>${OTHER.body}`,
		}),
		{
			media: (path) =>
				path === "jr://file/commcare/image/note.png"
					? {
							kind: "asset",
							assetId: "065c5781-429a-40b7-8d13-0cb6ad9a743d",
							mediaKind: "image",
						}
					: { kind: "no-entry" },
		},
	);
	expect(note.kind === "account" ? note.findings : []).toEqual([]);
	expect(note.kind).toBe("read");
	if (note.kind !== "read") return;
	expect(
		Object.values(note.draft.doc.fields).find((field) => field.id === "note"),
	).toMatchObject({
		kind: "label",
		help_media: { image: "065c5781-429a-40b7-8d13-0cb6ad9a743d" },
	});
});

it("reads and republishes a locked question and a locked hidden value in the receiving namespace", async () => {
	const source = xformSource({
		data: '<service xmlns="urn:receiving-service:household" vellum:lock="all"/><note/>',
		model:
			'<bind nodeset="/data/service" type="xsd:string"/><bind nodeset="/data/note" type="xsd:string" vellum:lock="all"/>' +
			itext([["note-label", "<value>Household notes</value>"]]),
		body: `<input ref="/data/note"><label ref="jr:itext('note-label')"/></input>`,
	});
	const original = await readWhole(source);
	if (original.kind !== "read")
		throw new Error(JSON.stringify(original.findings));
	const check = (doc: typeof original.draft.doc) => {
		expect(Object.values(doc.fields)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "service",
					kind: "hidden",
					answerNamespace: "urn:receiving-service:household",
					lockedInHq: true,
				}),
				expect.objectContaining({ id: "note", kind: "text", lockedInHq: true }),
			]),
		);
	};
	check(original.draft.doc);
	const exported = exportedBody(original.draft.doc);
	const next = readHqApp(await inputFor(exported));
	if (next.kind !== "read") throw new Error(JSON.stringify(next.findings));
	check(next.draft.doc);
});

it("explains an empty hidden namespace the designer removes on save", async () => {
	const source = xformSource({
		data: `<service xmlns=""/>${OTHER.data}`,
		model:
			'<bind nodeset="/data/service" type="xsd:string"/>' +
			OTHER.bind +
			itext([OTHER.text]),
		body: OTHER.body,
	});
	expect(account(await readWhole(source))).toEqual([
		`${Q("submitted-namespace-the-form-designer-cannot-keep")} @question:service`,
	]);
});
