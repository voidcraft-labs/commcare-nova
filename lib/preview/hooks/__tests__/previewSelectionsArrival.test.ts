// @vitest-environment happy-dom
/**
 * Back and Forward return a history entry's recorded selections before any
 * builder screen shows that entry (`usePreviewSelectionsArrival`,
 * `useClientPath.ts::subscribeBuilderHistoryPop`), whatever else listens to
 * the popstate.
 *
 * In the served app Next's App Router adds its popstate listener at
 * hydration, before any builder screen subscribes, and the window runs its
 * listeners in the order they were added. react-dom renders the transition
 * that listener starts in the microtask right after it returns, while the
 * popstate is still the window's current event
 * (`shouldAttemptEagerTransition`), so that render reaches the builder's
 * screens before the builder's own listener. The earlier listener here does
 * what that render does: it reads the builder's view of the entry, and the
 * record effect records the session's selections on it. happy-dom keeps no
 * `window.event`, so the listener holds the popstate there as a browser does
 * while it runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	getBuilderPathSegmentsSnapshot,
	pushBuilderHistory,
	readCurrentPreviewSelections,
	subscribeBuilderHistoryPop,
	subscribeBuilderPathChange,
} from "@/lib/routing/useClientPath";
import { createBuilderSessionStore } from "@/lib/session/store";
import {
	recordSessionSelections,
	returnPreviewSelectionsOnArrival,
} from "../usePreviewSelectionsArrival";

const APP = "/build/app-a";
const PATIENTS = testUuid("patients");
const CHECK = testUuid("check-due-date");
const BEA = { caseId: "bea", caseName: "Bea Lund" };

let currentEvent: Event | undefined;
beforeEach(() => {
	Object.defineProperty(window, "event", {
		configurable: true,
		get: () => currentEvent,
	});
});
afterEach(() => {
	Reflect.deleteProperty(window, "event");
});

describe("Back and Forward onto a form chosen from a list's form menu", () => {
	it("show the form with its case though another popstate listener renders first", () => {
		const session = createBuilderSessionStore({
			projectId: "project",
			role: "editor",
			canEdit: true,
		});
		session.getState().setPreviewing(true);
		const doc = {
			getState: () => ({
				modules: { [PATIENTS]: {} },
				forms: { [CHECK]: {} },
			}),
		};
		/* What the render the framework's listener starts shows of the entry,
		 * before the record effect writes. */
		const shown: { path: string; cases: unknown }[] = [];
		const frameworkRender = (event: Event) => {
			currentEvent = event;
			try {
				shown.push({
					path: getBuilderPathSegmentsSnapshot().join("/"),
					cases: readCurrentPreviewSelections(
						session.getState().previewSessionId,
					)?.target?.cases,
				});
				recordSessionSelections(session);
			} finally {
				currentEvent = undefined;
			}
		};
		window.addEventListener("popstate", frameworkRender);
		const stopPath = subscribeBuilderPathChange(() => {});
		const stopPop = subscribeBuilderHistoryPop(() =>
			returnPreviewSelectionsOnArrival(session, doc, "address"),
		);
		try {
			/* Choosing Bea on the list holds its form menu on an entry of its
			 * own; choosing the form there opens it after the menu. */
			pushBuilderHistory(`${APP}/${PATIENTS}/results`, false, {
				menu: { moduleUuid: PATIENTS, cases: [BEA] },
				session: session.getState().previewSessionId,
			});
			recordSessionSelections(session);
			session.getState().setPreviewCaseTarget({
				formUuid: CHECK,
				cases: [BEA],
				formChosenAfterCase: {
					caseListModuleUuid: PATIENTS,
					fromCaseListMenu: true,
				},
			});
			pushBuilderHistory(`${APP}/${CHECK}`);
			recordSessionSelections(session);

			/* Back onto the menu: the render that reaches the builder first
			 * still shows the form the session belongs to, and the form's
			 * target is the form's alone. */
			window.history.back();
			expect(shown).toEqual([{ path: CHECK, cases: [BEA] }]);
			expect(getBuilderPathSegmentsSnapshot()).toEqual([PATIENTS, "results"]);
			expect(session.getState().previewCaseTarget).toBeUndefined();

			/* Forward onto the form: the menu still shows until the form's
			 * record returns Bea, and the record then written holds her. */
			window.history.forward();
			expect(shown[1]).toEqual({
				path: `${PATIENTS}/results`,
				cases: undefined,
			});
			expect(getBuilderPathSegmentsSnapshot()).toEqual([CHECK]);
			expect(session.getState().previewCaseTarget?.cases).toEqual([BEA]);
			expect(
				readCurrentPreviewSelections(session.getState().previewSessionId)
					?.target?.cases,
			).toEqual([BEA]);
		} finally {
			stopPop();
			stopPath();
			window.removeEventListener("popstate", frameworkRender);
		}
	});
});
