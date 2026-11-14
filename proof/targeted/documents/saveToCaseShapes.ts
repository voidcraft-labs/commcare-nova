/**
 * Every shape of Save to Case block Nova's emitter writes
 * (`targeted-save-to-case-shapes`): the document whose first publish, each
 * form then saved once in CommCare HQ's form builder, is the HQ-authored
 * base `hq-nova-then-builder`, over which the reader of HQ's apps is held to
 * recognize each block the builder kept (`xform/caseOps.ts::saveToCaseBlockShape`
 * gives each block's path).
 *
 * Households, chosen one at a time, and a second menu of households chosen
 * several at once:
 *
 * - "Assess household" saves its score as text with its unit, a computed
 *   value Case Management cannot state, so its own case is a block of the
 *   root `nova_operations` group (the own arm in a block). It creates a
 *   visit at the root (a root create) and updates it where the note is
 *   `revisit` (a conditional update, in its condition group).
 * - "Record members" creates a member in each row of `members` (a create in
 *   a repeat), linked to the household.
 * - "Close household" closes the household where the reason given matches
 *   the reason confirmed, a condition Case Management cannot state, so the
 *   own close is a block of its own in a condition group.
 * - "Log a visit", a survey, creates a visit keyed by an answer (a keyed
 *   create, in its one-row repeat) and closes it (a close). A keyed id may
 *   name a case that already exists, the chosen household's among them, so
 *   the keyed create stands in a form that loads no case of its own.
 * - "Mark visited", in the menu that chooses several households, saves an
 *   answer to each chosen household (a several-case form).
 *
 * Choosing several cases runs in Web Apps alone, so the app declares Web
 * Apps.
 *
 * Fixed values: each symptom is HQ's form builder's save and the reader,
 * which no value check reads, so the document carries the check of a
 * question its symptom leaves alone (`./echo.ts`) on HQ's build of its first
 * publish.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { concat, eq, formField, literal, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-save-to-case-shapes";
const uuid = (name: string) => targetedUuid(ID, name);

/** The app, with every Save to Case shape its forms' case changes take. */
export function saveToCaseShapesApp(): BlueprintDoc {
	const assess = uuid("assess");
	const members = uuid("record-members");
	const close = uuid("close-household");
	const mark = uuid("mark-visited");
	const log = uuid("log-visit");
	const read = (key: string) => term(formField(uuid(key)));
	const text = (id: string, label: string) =>
		f({ kind: "text", uuid: uuid(id), id, label: proseText(label) });
	const firstVisit = uuid("first-visit");
	const keyedVisit = uuid("keyed-visit");
	const assessOperations: CaseOperation[] = [
		{
			uuid: uuid("assess-own"),
			id: "household",
			action: "own",
			writes: [
				{
					property: "score_text",
					value: concat(read("score"), term(literal(" points"))),
				},
			],
		},
		{
			uuid: firstVisit,
			id: "first_visit",
			action: "create",
			caseType: "visit",
			target: { kind: "new" },
			name: read("note"),
		},
		{
			uuid: uuid("revisit"),
			id: "revisit",
			action: "update",
			caseType: "visit",
			target: { kind: "op", opUuid: firstVisit },
			condition: eq(formField(uuid("note")), literal("revisit")),
			writes: [{ property: "kind", value: term(literal("revisit")) }],
		},
	];
	const logOperations: CaseOperation[] = [
		{
			uuid: keyedVisit,
			id: "keyed_visit",
			action: "create",
			caseType: "visit",
			target: { kind: "new", idFrom: uuid("visit_key") },
			name: read("visit_note"),
		},
		{
			uuid: uuid("finish-keyed"),
			id: "finish_keyed",
			action: "close",
			caseType: "visit",
			target: { kind: "op", opUuid: keyedVisit },
		},
	];
	const memberOperations: CaseOperation[] = [
		{
			uuid: uuid("member"),
			id: "member",
			action: "create",
			caseType: "member",
			target: { kind: "new" },
			name: read("member_name"),
			forEach: { repeat: uuid("members") },
			links: [
				{
					identifier: "parent",
					targetType: "household",
					target: { kind: "session" },
					relationship: "child",
				},
			],
		},
	];
	const markOperations: CaseOperation[] = [
		{
			uuid: uuid("mark-each"),
			id: "mark_each",
			action: "update",
			caseType: "household",
			target: { kind: "session" },
			writes: [{ property: "last_seen", value: read("seen") }],
		},
	];
	const nameColumn = (key: string) =>
		plainColumn(uuid(`${key}-name`), "case_name", "Name");
	return buildDoc(
		{
			appId: ID,
			appName: "Household visits",
			// Choosing several households runs in Web Apps alone.
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
			caseTypes: [
				{
					name: "household",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{
							name: "score_text",
							label: proseText("Score"),
							data_type: "text",
						},
						{
							name: "last_seen",
							label: proseText("Last seen"),
							data_type: "text",
						},
					],
				},
				{
					name: "visit",
					parent_type: "household",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "kind", label: proseText("Kind"), data_type: "text" },
					],
				},
				{
					name: "member",
					parent_type: "household",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: uuid("households"),
					name: "Households",
					caseType: "household",
					caseListConfig: caseListOf([nameColumn("households")]),
					forms: [
						{
							uuid: assess,
							name: "Assess household",
							type: "followup",
							fields: [
								f({
									kind: "int",
									uuid: uuid("score"),
									id: "score",
									label: proseText("Score"),
								}),
								text("note", "Note"),
							],
						},
						{
							uuid: members,
							name: "Record members",
							type: "followup",
							fields: [
								f({
									kind: "repeat",
									uuid: uuid("members"),
									id: "members",
									label: proseText("Members"),
									repeat_mode: "user_controlled",
									children: [text("member_name", "Member name")],
								}),
							],
						},
						{
							uuid: close,
							name: "Close household",
							type: "close",
							closeCondition: eq(
								formField(uuid("reason")),
								formField(uuid("confirm")),
							),
							fields: [
								text("reason", "Reason"),
								text("confirm", "Confirm the reason"),
							],
						},
						{
							uuid: log,
							name: "Log a visit",
							type: "survey",
							fields: [
								text("visit_key", "Visit key"),
								text("visit_note", "Visit note"),
							],
						},
					],
				},
				{
					uuid: uuid("group-visits"),
					name: "Group visits",
					caseType: "household",
					caseListConfig: caseListOf([nameColumn("group-visits")], {
						selection: { kind: "multiple", maximum: 10 },
					}),
					forms: [
						{
							uuid: mark,
							name: "Mark visited",
							type: "followup",
							fields: [text("seen", "Seen on")],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[assess].caseOperations = assessOperations;
			built.forms[members].caseOperations = memberOperations;
			built.forms[mark].caseOperations = markOperations;
			built.forms[log].caseOperations = logOperations;
		},
	);
}

export function saveToCaseShapes() {
	return targetedDocument({
		id: ID,
		rows: [
			"every Save to Case shape Nova's emitter writes, for the form builder's save",
		],
		doc: saveToCaseShapesApp(),
		expected: {
			intent: [
				answerHeld("note-held", uuid("assess"), "/data/note", "seen", "A", {
					command: "m0-f0",
					caseId: "targeted-household",
				}),
			],
		},
	});
}
