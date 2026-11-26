import { describe, expect, it } from "vitest";
import { retainedBase } from "@/__tests__/helpers/retainedHqApps";
import { testUuid } from "@/__tests__/helpers/uuid";
import { connectSectionForm } from "@/lib/__tests__/connectSectionForm";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { connectActivitySites } from "@/lib/domain/connectActivitySites";
import { connectRecipientRule } from "@/lib/domain/connectRecipientRule";
import { connectSubmissionConflicts } from "@/lib/domain/connectSubmission";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

describe("Connect activities across a form submission", () => {
	it("refuses an ancestor HQ forwards under a Connect receiver key", async () => {
		const enclosing = testUuid("lesson-enclosing-group");
		const doc = buildDoc({
			connectRoles: ["learn"],
			appSettings: {
				showSavedForms: false,
				showIncompleteForms: false,
				runsOnlyOn: "android",
			},
			modules: [
				{
					name: "Lessons",
					forms: [
						{
							name: "Review",
							type: "survey",
							fields: [
								f({
									kind: "group",
									uuid: enclosing,
									id: "practice",
									children: [
										f({
											kind: "connect_activity",
											id: "lesson",
											activity: {
												kind: "learning-module",
												name: "Practice",
												description: "Review the lesson",
												estimatedHours: 1,
											},
										}),
									],
								}),
								f({ kind: "text", id: "assessment" }),
							],
						},
					],
				},
			],
		});
		const group = doc.fields[enclosing];
		for (const name of ["Module", "deliver", "practice"]) {
			group.id = name;
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		}
		const body = exportedBody(doc);
		const attachments = body._attachments as Record<string, string>;
		const [file, xml] = Object.entries(attachments)[0];
		attachments[file] = xml
			.replaceAll("/data/practice", "/data/module")
			.replaceAll("#form/practice", "#form/module")
			.replaceAll("<practice>", "<module>")
			.replaceAll("</practice>", "</module>");
		group.id = "module";
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toMatchObject([
			{
				code: "CONNECT_FORWARDED_ANCESTOR_ID",
				location: { fieldUuid: enclosing },
			},
		]);
		const result = readHqApp(await inputFor(body), { claims: "full" });
		expect(result.defects).toEqual([]);
		expect(result.kind).toBe("account");
		if (result.kind !== "account") throw new Error("Expected one refusal");
		expect(
			[...result.claims.records()].filter(
				(claim) => claim.entry === "questions/connect-forwarded-ancestor-name",
			),
			JSON.stringify(result.findings),
		).toContainEqual(
			expect.objectContaining({
				entry: "questions/connect-forwarded-ancestor-name",
				key: "xform:model/instance/*/*",
				standing: "fix-in-hq",
			}),
		);
	});
	it("reads a field-list around the question in a Vellum-authored Learn form and republishes both original activities beside it", async () => {
		const source = retainedBase("hq-connect-learn").source.body;
		if (!source) throw new Error("Missing saved Vellum source");
		const body = JSON.parse(source);
		const [file, xml] = Object.entries(
			body._attachments as Record<string, string>,
		)[0];
		body._attachments[file] = xml
			.replaceAll("/data/quiz_score", "/data/practice/quiz_score")
			.replaceAll("#form/quiz_score", "#form/practice/quiz_score")
			.replace("<quiz_score />", "<practice><quiz_score /></practice>")
			.replace(
				"<h:body>",
				'<h:body><group ref="/data/practice" appearance="field-list">',
			)
			.replace("</h:body>", "</group></h:body>");
		const result = readHqApp(await inputFor(body));
		expect(result.defects).toEqual([]);
		if (result.kind !== "read")
			throw new Error(JSON.stringify(result.findings));
		const read = result.draft.doc;
		const form = read.formOrder[read.moduleOrder[0]][0];
		expect(
			read.fieldOrder[form].map((id) => [
				read.fields[id].kind,
				read.fields[id].id,
			]),
		).toEqual([
			["section", "practice"],
			["connect_activity", "intro_module"],
			["connect_activity", "intro_check"],
		]);
		const saved = exportedBody(read);
		const reread = readHqApp(await inputFor(saved));
		if (reread.kind !== "read") throw new Error(JSON.stringify(reread));
		const again = reread.draft.doc;
		const formAgain = again.formOrder[again.moduleOrder[0]][0];
		expect(
			again.fieldOrder[formAgain].map((id) => again.fields[id].kind),
		).toEqual(["section", "connect_activity", "connect_activity"]);
		expect(
			connectActivitySites(again, formAgain).map((s) =>
				s.path.map((id) => again.fields[id].id),
			),
		).toEqual([["intro_module"], ["intro_check"]]);
	});

	it("keeps leading, trailing, interleaved and nested activities at their submitted addresses while reading worker pages", async () => {
		const result = readHqApp(
			await inputFor(exportedBody(connectSectionForm("worker-pages"))),
		);
		expect(result.defects).toEqual([]);
		if (result.kind !== "read") throw new Error(JSON.stringify(result));
		const doc = result.draft.doc;
		const form = doc.formOrder[doc.moduleOrder[0]][0];
		expect(
			doc.fieldOrder[form].map((id) => [
				doc.fields[id].kind,
				doc.fields[id].id,
			]),
		).toEqual([
			["connect_activity", "lesson_one"],
			["section", "practice"],
			["connect_activity", "review"],
			["section", "follow_up"],
			["connect_activity", "completion"],
		]);
		expect(
			connectActivitySites(doc, form).map((s) =>
				s.path.map((id) => doc.fields[id].id),
			),
		).toEqual([
			["lesson_one"],
			["practice", "rehearsal"],
			["review"],
			["completion"],
		]);
	});

	it.each([0, "0007"] as const)(
		"reads a lesson (%s hours) and a delivery where they were placed, preserving a blank entity and its work area",
		async (estimatedHours) => {
			const doc = buildDoc({
				connectRoles: ["learn", "deliver"],
				appSettings: {
					showSavedForms: false,
					showIncompleteForms: false,
					runsOnlyOn: "android",
				},
				modules: [
					{
						name: "Visits",
						forms: [
							{
								name: "Follow up",
								type: "survey",
								fields: [
									f({ kind: "text", id: "area" }),
									f({
										kind: "group",
										id: "visit",
										children: [
											f({
												kind: "connect_activity",
												id: "learn_care",
												activity: {
													kind: "learning-module",
													name: "Care",
													description: "Watch the demonstration",
													estimatedHours,
												},
											}),
											f({ kind: "text", id: "notes" }),
											f({
												kind: "connect_activity",
												id: "unit_visit",
												activity: {
													kind: "delivery",
													name: "Visit",
													workAreaId: "#form/area",
												},
											}),
										],
									}),
								],
							},
						],
					},
				],
			});
			const body = exportedBody(doc);
			const outcome = readHqApp(await inputFor(body), { claims: "full" });
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			if (outcome.kind !== "read")
				throw new Error("The activity form did not read.");
			const records = [...outcome.claims.records()];
			for (const [entry, key, count] of [
				[
					"connect-learn-and-deliver-blocks-in-one-app",
					"vellum-markup:model/instance//*@vellum:role",
					2,
				],
				[
					"connect-blocks-beyond-one-of-each-kind",
					"xform:model/instance//*",
					2,
				],
				[
					"connect-deliver-unit-work-area-id-expression",
					"xform:model/bind@calculate",
					1,
				],
			] as const) {
				expect(outcome.claims.counts[`questions/${entry}`]).toBe(count);
				expect(
					records.filter(
						(record) =>
							record.entry === `questions/${entry}` &&
							record.key === key &&
							record.standing === "held",
					),
				).toHaveLength(count);
			}
			const read = outcome.draft.doc;
			expect(read.connectRoles).toEqual(["learn", "deliver"]);
			const form = read.formOrder[read.moduleOrder[0]][0];
			const sites = connectActivitySites(read, form);
			expect(
				sites.map((site) => site.path.map((uuid) => read.fields[uuid].id)),
			).toEqual([
				["visit", "learn_care"],
				["visit", "unit_visit"],
			]);
			expect(sites[0].field.activity).toMatchObject({
				kind: "learning-module",
				estimatedHours,
			});
			const area = Object.values(read.fields).find(
				(field) => field.id === "area",
			);
			expect(sites[1].field.activity).toEqual({
				kind: "delivery",
				name: "Visit",
				workAreaId: { kind: "term", term: { kind: "field", uuid: area?.uuid } },
			});
			expect(connectSubmissionConflicts(read, form)).toEqual([]);
		},
	);
	it("holds an existing worker rule only when it checks the same recipient across the entire repeat", async () => {
		const repeat = testUuid("worker-visit-rows");
		const recipient = testUuid("worker-visit-recipient");
		const form = testUuid("worker-visit-form");
		const doc = buildDoc({
			connectRoles: ["deliver"],
			appSettings: {
				showSavedForms: false,
				showIncompleteForms: false,
				runsOnlyOn: "android",
			},
			modules: [
				{
					name: "Visits",
					forms: [
						{
							uuid: form,
							name: "Record visits",
							type: "survey",
							fields: [
								f({
									uuid: repeat,
									kind: "repeat",
									id: "rows",
									repeat_mode: "user_controlled",
									children: [
										f({
											uuid: recipient,
											kind: "text",
											id: "recipient",
											required: "true()",
											validate: connectRecipientRule(repeat, recipient),
										}),
										f({
											kind: "connect_activity",
											id: "visit",
											activity: {
												kind: "delivery",
												name: "Visit",
												entityId: {
													kind: "term",
													term: {
														kind: "field",
														uuid: recipient,
														spelling: "relative",
													},
												},
											},
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		expect(connectSubmissionConflicts(doc, form)).toEqual([]);
		const body = exportedBody(doc);
		const text = JSON.stringify(body._attachments);
		expect(text).toContain("../../../recipient");
		expect(text).toContain("/data/rows[true()]/recipient");
		const read = readHqApp(await inputFor(body));
		expect(read.defects).toEqual([]);
		expect(read.kind === "account" ? read.findings : []).toEqual([]);
		expect(read.kind).toBe("read");
		const answer = doc.fields[recipient];
		if (answer.kind !== "text") throw new Error("Expected the ID question");
		answer.required = undefined;
		expect(
			connectSubmissionConflicts(doc, form).map((finding) => finding.reason),
		).toEqual(["duplicate-delivery"]);
		answer.required = { kind: "match-all" };
		answer.default_value = {
			kind: "term",
			term: { kind: "literal", value: "previous" },
		};
		expect(
			connectSubmissionConflicts(doc, form).map((finding) => finding.reason),
		).toEqual(["duplicate-delivery"]);
		delete answer.default_value;
		answer.validate = connectRecipientRule(
			repeat,
			testUuid("different-recipient"),
		);
		expect(
			connectSubmissionConflicts(doc, form).map((finding) => finding.reason),
		).toEqual(["duplicate-delivery"]);
	});
	it("refuses a rule that reads calculated IDs before the worker recalculates them", async () => {
		const form = testUuid("calculated-delivery-form");
		const repeat = testUuid("calculated-delivery-rows");
		const recipient = testUuid("calculated-delivery-recipient");
		const delivery = testUuid("calculated-delivery");
		const doc = buildDoc({
			connectRoles: ["deliver"],
			appSettings: {
				showSavedForms: false,
				showIncompleteForms: false,
				runsOnlyOn: "android",
			},
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Households",
							uuid: form,
							type: "survey",
							fields: [
								f({
									uuid: repeat,
									kind: "repeat",
									id: "rows",
									repeat_mode: "user_controlled",
									children: [
										f({
											uuid: recipient,
											kind: "text",
											id: "recipient",
											required: "true()",
											validate: connectRecipientRule(repeat, recipient),
										}),
										f({
											uuid: delivery,
											kind: "connect_activity",
											id: "visit",
											activity: {
												kind: "delivery",
												name: "Visit",
												entityId: {
													kind: "term",
													term: {
														kind: "field",
														uuid: recipient,
														spelling: "relative",
													},
												},
											},
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const body = exportedBody(doc);
		const attachments = body._attachments as Record<string, string>;
		const [file, raw] = Object.entries(attachments)[0];
		expect(raw).toContain("/data/rows[true()]/recipient");
		const transformed = raw
			.replaceAll(
				"/data/rows[true()]/recipient",
				"/data/rows[true()]/visit/deliver/entity_id",
			)
			.replace(
				'calculate="../../../recipient"',
				`calculate="substr(../../../recipient, 0, 1)"`,
			);
		expect(transformed).toContain("substr(../../../recipient, 0, 1)");
		attachments[file] = transformed;
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		expect(
			outcome.kind === "account" &&
				outcome.findings.some(
					(finding) =>
						finding.code === "questions/connect-deliveries-share-receiver-key",
				),
		).toBe(true);
	});
	it.each([
		["Mira Jo", false, false],
		["Mira Mira", false, true],
		["Mira Jo", true, true],
	] as const)(
		"evaluates the receiver key across all rows of %s with outer repeat %s",
		(ids, outer, collides) => {
			const row = testUuid("delivery-visit-row");
			const form = testUuid("delivery-visit-form");
			const visit = f({
				kind: "repeat",
				uuid: row,
				id: "visits",
				repeat_mode: "query_bound",
				data_source: {
					ids_query: { kind: "term", term: { kind: "literal", value: ids } },
				},
				children: [
					f({
						kind: "connect_activity",
						id: "visit",
						activity: {
							kind: "delivery",
							name: "Visit",
							entityId: {
								kind: "term",
								term: {
									kind: "repeat-row",
									repeat: row,
									attribute: "id",
									spelling: "relative",
								},
							},
						},
					}),
				],
			});
			const doc = buildDoc({
				connectRoles: ["deliver"],
				appSettings: {
					showSavedForms: false,
					showIncompleteForms: false,
					runsOnlyOn: "android",
				},
				modules: [
					{
						name: "Work",
						forms: [
							{
								name: "Visit",
								uuid: form,
								type: "survey",
								fields: outer
									? [
											f({
												kind: "repeat",
												id: "round",
												repeat_mode: "count_bound",
												repeat_count: "2",
												children: [visit],
											}),
										]
									: [visit],
							},
						],
					},
				],
			});
			expect(
				connectSubmissionConflicts(doc, form).map((finding) => finding.reason),
			).toEqual(collides ? ["duplicate-delivery"] : []);
		},
	);
});
