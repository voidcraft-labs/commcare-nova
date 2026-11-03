/**
 * Defect 26: every destination of a form that holds runs, in the order its
 * author wrote them (`targeted-form-link-chain`).
 *
 * Nova emits a form's destinations in reverse, so the author's first that
 * holds is the frame on top: Core pushes every `<create>` whose condition
 * holds and runs the frame pushed last first, the next when it finishes
 * (`session/CommCareSession.java::executeStackOperations`, `finishExecuteAndPop`),
 * and HQ builds one frame per link in link order
 * (`suite_xml/post_process/workflow.py::EndOfFormNavigationWorkflow`). Web Apps
 * opens only the frame on top: Formplayer rebuilds its session from the frame
 * it pops and keeps none beneath it
 * (`formplayer/services/MenuSessionFactory.java::rebuildSessionFromFrame`).
 *
 * "Begin", a survey of the menu "Start", has three every-time destinations
 * in order: the survey "First" and the survey "Second" of menu "A", then menu
 * "B"; "First" has its own every-time destination, the survey "Nested" of
 * menu "A". So Core's session and Android run Begin, First, Nested, Second,
 * then menu B, and Formplayer and the Web Apps client Begin, First, Nested,
 * then the app's first screen. "Begin both" holds a destination to Second as
 * alice and one to menu B on `true()`: as alice both run, Second first; as
 * anyone else menu B alone. Its edit D′ moves Begin's destination to menu B
 * first (`moveFormLink`), so proof 5 runs over a reorder.
 *
 * Fixed values: Begin's note holds the text the worker enters (`./echo.ts`).
 * The order each runtime runs the destinations in is held by
 * `proof/native/core/FormLinkRuntimeTest.java` over the same shapes and by
 * proofs 3 and 4 over this document's walks.
 */

import { buildDoc, type FormSpec, f } from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, NEW_APP_SETTINGS, proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-form-link-chain";
const uuid = (name: string) => targetedUuid(ID, name);

const START = uuid("module-start");
const A = uuid("module-a");
const B = uuid("module-b");
const BEGIN = uuid("form-begin");
const FIRST = uuid("form-first");
const SECOND = uuid("form-second");
const NESTED = uuid("form-nested");
const TO_B = uuid("link-begin-b");

function note(name: string) {
	return f({
		kind: "text",
		uuid: uuid(`note-${name}`),
		id: "note",
		label: proseText("Note"),
	});
}

function survey(
	formUuid: string,
	name: string,
	formLinks?: FormSpec["formLinks"],
) {
	return {
		uuid: formUuid,
		name,
		type: "survey" as const,
		...(formLinks !== undefined && { formLinks }),
		fields: [note(name.toLowerCase().replace(/\s+/g, "-"))],
	};
}

/** The app, with Begin's destinations in `beginOrder`. */
function chainApp(beginOrder: "as-written" | "menu-b-first"): BlueprintDoc {
	const toFirst = {
		uuid: uuid("link-begin-first"),
		target: { type: "form" as const, moduleUuid: A, formUuid: FIRST },
	};
	const toSecond = {
		uuid: uuid("link-begin-second"),
		target: { type: "form" as const, moduleUuid: A, formUuid: SECOND },
	};
	const toB = {
		uuid: TO_B,
		target: { type: "module" as const, moduleUuid: B },
	};
	const begin =
		beginOrder === "as-written"
			? [toFirst, toSecond, toB]
			: [toB, toFirst, toSecond];
	return buildDoc({
		appId: ID,
		appName: "Chained surveys",
		// Declared for Web Apps and Android, as a new app is.
		appSettings: { ...NEW_APP_SETTINGS },
		modules: [
			{
				uuid: START,
				name: "Start",
				forms: [
					survey(BEGIN, "Begin", begin),
					survey(uuid("form-begin-both"), "Begin both", [
						{
							uuid: uuid("link-both-second"),
							condition: "#user/username = 'alice'",
							target: { type: "form", moduleUuid: A, formUuid: SECOND },
						},
						{
							uuid: uuid("link-both-b"),
							condition: "true()",
							target: { type: "module", moduleUuid: B },
						},
					]),
				],
			},
			{
				uuid: A,
				name: "A",
				forms: [
					survey(FIRST, "First", [
						{
							uuid: uuid("link-first-nested"),
							target: { type: "form", moduleUuid: A, formUuid: NESTED },
						},
					]),
					survey(SECOND, "Second"),
					survey(NESTED, "Nested"),
				],
			},
			{
				uuid: B,
				name: "B",
				forms: [survey(uuid("form-done"), "Done")],
			},
		],
	});
}

export function formLinkChain() {
	const editMutations: Mutation[] = [
		{ kind: "moveFormLink", formUuid: BEGIN, uuid: TO_B, after: null },
	];
	return targetedDocument({
		id: ID,
		rows: ["26"],
		doc: chainApp("as-written"),
		edit: chainApp("menu-b-first"),
		editMutations,
		expected: {
			intent: [answerHeld("note-held", BEGIN, "/data/note", "begun")],
		},
	});
}
