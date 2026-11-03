/**
 * The after-submit stack (`afterSubmitStack.ts`) against Core's session
 * rules: every pushed frame runs, the last pushed first, each when the one
 * above it finishes (`CommCareSession.java::finishAndPop`); the remaining
 * frames drop when the worker leaves the path the frame above them opened
 * (`cleanStack`, `SessionFrame.java::isSnapshotIncompatible`); and Web Apps
 * keeps nothing beneath the frame it opens (`MenuSession.java::resetSession`).
 * What Home and the other session resets empty is the session store's
 * (`lib/session/__tests__/store.test.ts`).
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type AfterSubmitPathStep,
	type AfterSubmitStackState,
	completeAfterSubmit,
	completeAfterSubmitWithOwnFrame,
	EMPTY_AFTER_SUBMIT_STACK,
	type PendingAfterSubmitFrame,
	pathBeginsWith,
} from "../afterSubmitStack";
import { previewPlatformRules } from "../platform";

const SOURCE_MENU = testUuid("menu-source");
const SOURCE_FORM = testUuid("form-source");
const FIRST_MENU = testUuid("menu-first");
const FIRST_FORM = testUuid("form-first");
const SECOND_MENU = testUuid("menu-second");
const SECOND_FORM = testUuid("form-second");

const menu = (moduleUuid: string): AfterSubmitPathStep => ({
	kind: "menu",
	moduleUuid: moduleUuid as never,
});
const form = (moduleUuid: string, formUuid: string): AfterSubmitPathStep => ({
	kind: "form",
	moduleUuid: moduleUuid as never,
	formUuid: formUuid as never,
});
const cases = (
	moduleUuid: string,
	...caseIds: string[]
): AfterSubmitPathStep => ({
	kind: "case",
	moduleUuid: moduleUuid as never,
	caseIds,
});

const SOURCE_PATH = [menu(SOURCE_MENU), form(SOURCE_MENU, SOURCE_FORM)];
const FIRST_LANDING = [
	menu(FIRST_MENU),
	cases(FIRST_MENU, "c1"),
	form(FIRST_MENU, FIRST_FORM),
];
const SECOND_LANDING = [menu(SECOND_MENU), form(SECOND_MENU, SECOND_FORM)];

/** A submission's frames in push order: the second destination, then the
 *  author's first, which is emitted last and so is on top. */
const twoDestinations: readonly PendingAfterSubmitFrame<string>[] = [
	{ route: "second", landing: SECOND_LANDING },
	{ route: "first", landing: FIRST_LANDING },
];

const stackMode = previewPlatformRules("android").afterSubmitFrames;
const topMode = previewPlatformRules("web-apps").afterSubmitFrames;

describe("completeAfterSubmit", () => {
	it("reads Android as a stack and Web Apps as its top frame", () => {
		expect(stackMode).toBe("stack");
		expect(topMode).toBe("top");
	});

	it("runs the frame pushed last first, and the rest after it finishes, on Android", () => {
		const pushed = completeAfterSubmit(
			EMPTY_AFTER_SUBMIT_STACK,
			SOURCE_PATH,
			twoDestinations,
			stackMode,
		);
		expect(pushed.next).toBe("first");
		expect(pushed.state).toEqual({
			pending: [twoDestinations[0]],
			snapshot: FIRST_LANDING,
		});
		// The first destination's form, which pushes nothing, finishes.
		const finished = completeAfterSubmit(
			pushed.state,
			[...FIRST_LANDING],
			[],
			stackMode,
		);
		expect(finished.next).toBe("second");
		expect(finished.state).toBe(EMPTY_AFTER_SUBMIT_STACK);
		// Nothing is left: the app home.
		expect(
			completeAfterSubmit(finished.state, SECOND_LANDING, [], stackMode).next,
		).toBeUndefined();
	});

	it("opens the frame on top alone on Web Apps, and never the next one", () => {
		const pushed = completeAfterSubmit(
			EMPTY_AFTER_SUBMIT_STACK,
			SOURCE_PATH,
			twoDestinations,
			topMode,
		);
		expect(pushed.next).toBe("first");
		expect(pushed.state).toBe(EMPTY_AFTER_SUBMIT_STACK);
		expect(
			completeAfterSubmit(pushed.state, FIRST_LANDING, [], topMode).next,
		).toBeUndefined();
	});

	it("runs the frames a destination's own form pushes before the ones still pending", () => {
		const pushed = completeAfterSubmit(
			EMPTY_AFTER_SUBMIT_STACK,
			SOURCE_PATH,
			twoDestinations,
			stackMode,
		);
		const nested = completeAfterSubmit(
			pushed.state,
			FIRST_LANDING,
			[{ route: "nested", landing: [menu(SOURCE_MENU)] }],
			stackMode,
		);
		expect(nested.next).toBe("nested");
		expect(nested.state.pending.map((frame) => frame.route)).toEqual([
			"second",
		]);
		expect(nested.state.snapshot).toEqual([menu(SOURCE_MENU)]);
	});

	it("drops what is pending when the worker leaves the path the frame opened", () => {
		const pushed = completeAfterSubmit(
			EMPTY_AFTER_SUBMIT_STACK,
			SOURCE_PATH,
			twoDestinations,
			stackMode,
		);
		// The worker went elsewhere and submitted another form.
		const elsewhere = completeAfterSubmit(
			pushed.state,
			[menu(SECOND_MENU), form(SECOND_MENU, SECOND_FORM)],
			[],
			stackMode,
		);
		expect(elsewhere.next).toBeUndefined();
		expect(elsewhere.state).toBe(EMPTY_AFTER_SUBMIT_STACK);
		// The same form on another case is another path too.
		const otherCase = completeAfterSubmit(
			pushed.state,
			[menu(FIRST_MENU), cases(FIRST_MENU, "c2"), form(FIRST_MENU, FIRST_FORM)],
			[],
			stackMode,
		);
		expect(otherCase.next).toBeUndefined();
	});

	it("keeps what is pending while the worker's path goes on from the landing", () => {
		const moduleLanding = [menu(FIRST_MENU)];
		const state: AfterSubmitStackState<string> = {
			pending: [{ route: "later", landing: SECOND_LANDING }],
			snapshot: moduleLanding,
		};
		const deeper = completeAfterSubmit(
			state,
			[menu(FIRST_MENU), cases(FIRST_MENU, "c9"), form(FIRST_MENU, FIRST_FORM)],
			[],
			stackMode,
		);
		expect(deeper.next).toBe("later");
	});

	it("never drops what is pending beneath an empty landing", () => {
		// HQ's `root` frame installs no step, and every path begins with it.
		const state: AfterSubmitStackState<string> = {
			pending: [{ route: "later", landing: SECOND_LANDING }],
			snapshot: [],
		};
		expect(completeAfterSubmit(state, SOURCE_PATH, [], stackMode).next).toBe(
			"later",
		);
	});
});

describe("completeAfterSubmitWithOwnFrame", () => {
	it("pushes a frame its caller routes and leaves it the snapshot over what stays pending", () => {
		const pushed = completeAfterSubmit(
			EMPTY_AFTER_SUBMIT_STACK,
			SOURCE_PATH,
			twoDestinations,
			stackMode,
		);
		const returned = completeAfterSubmitWithOwnFrame(
			pushed.state,
			FIRST_LANDING,
			[menu(FIRST_MENU)],
			stackMode,
		);
		expect(returned).toEqual({
			pending: [twoDestinations[0]],
			snapshot: [menu(FIRST_MENU)],
		});
		expect(
			completeAfterSubmitWithOwnFrame(
				pushed.state,
				SECOND_LANDING,
				[menu(FIRST_MENU)],
				stackMode,
			),
		).toBe(EMPTY_AFTER_SUBMIT_STACK);
	});
});

describe("pathBeginsWith", () => {
	it("compares step by step, case ids as ordered lists", () => {
		const path = [
			menu(FIRST_MENU),
			cases(FIRST_MENU, "a", "b"),
			form(FIRST_MENU, FIRST_FORM),
		];
		expect(pathBeginsWith(path, [])).toBe(true);
		expect(pathBeginsWith(path, path)).toBe(true);
		expect(pathBeginsWith(path, path.slice(0, 2))).toBe(true);
		expect(
			pathBeginsWith(path, [menu(FIRST_MENU), cases(FIRST_MENU, "b", "a")]),
		).toBe(false);
		expect(pathBeginsWith(path.slice(0, 1), path)).toBe(false);
		expect(pathBeginsWith(path, [form(FIRST_MENU, FIRST_FORM)])).toBe(false);
	});
});
