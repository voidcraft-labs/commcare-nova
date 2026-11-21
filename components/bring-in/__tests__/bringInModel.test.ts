/**
 * The bring-in page as data: every rule of the reducer, the screen each model
 * shows, and the one request it makes next. The plausible failures are the
 * ones a person meets as a broken flow: a read sent before the tab's key is
 * looked at, a lost request retried in a storm or not at all, the review's
 * choices back on screen under a create in flight, an answer kind with no
 * screen, a person's answers resent against a review that changed, and a
 * stale line painting over a newer screen.
 */

import { describe, expect, it } from "vitest";
import type {
	AdoptedAppReceipt,
	CreateAnswer,
	HqAppPicker,
	ReadingAnswer,
} from "@/lib/deployment";
import { accountOfOne } from "@/lib/deployment/reading/answers";
import type { ReviewTable } from "@/lib/deployment/reading/types";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import type { BringInLocation } from "@/lib/routing/bringInLocation";
import {
	BRING_IN_RESUME_WINDOW_MS,
	type BringInEvent,
	type BringInModel,
	type BringInScreen,
	carryAnswers,
	initialAnswers,
	initialBringInModel,
	nextAct,
	type ReviewAnswers,
	reduceBringIn,
	resumableCreate,
	screenOf,
} from "../bringInModel";
import {
	choice,
	choiceTable,
	DIGEST_1,
	DIGEST_2,
	DIGEST_3,
	inputFor,
	KEY,
	OTHER_KEY,
	review,
	reviewAnswer,
} from "./bringInFixtures";

const APP: BringInLocation = { kind: "app", key: KEY };
const OTHER_APP: BringInLocation = { kind: "app", key: OTHER_KEY };
const CHOOSE: BringInLocation = { kind: "choose" };
const NONE: BringInLocation = { kind: "none" };

const NO_ACT = { kind: "none" } as const;
const READ = { kind: "read", key: KEY, afterMs: 0 } as const;

function run(model: BringInModel, ...events: BringInEvent[]): BringInModel {
	return events.reduce(reduceBringIn, model);
}

/** A model at the app's address whose tab held no create to send again. */
function atApp(): BringInModel {
	return run(initialBringInModel(APP, "project-1"), {
		type: "resume",
		input: null,
	});
}

/** A model reading the app, the read's request in flight. */
function reading(): BringInModel {
	return run(atApp(), { type: "call", call: "read", at: 1 });
}

/** The create action for the input `inputFor` gives, sent at once. */
function createAct(afterMs = 0) {
	return { kind: "create", input: inputFor(), afterMs } as const;
}

const STOP = circumstanceFinding("app-gone", { kind: "app" }, {});
const ALREADY_IN_NOVA = circumstanceFinding(
	"already-in-nova",
	{ kind: "app" },
	{ claim: { kind: "open", appId: "app-9", appName: "Household visits" } },
);
const TOO_LARGE = circumstanceFinding("too-large", { kind: "app" }, {});
const HELD = circumstanceFinding("rate-limited", { kind: "app" }, {});
const ACCOUNT = accountOfOne(TOO_LARGE, "Household visits");

const TWO_WAYS = review({
	runsOn: [
		choice(null, { preselected: true }),
		choice("android", { splitDatetime: false }),
	],
	tables: [choiceTable("districts", { hq: true, project: true })],
});
const REVIEW = reviewAnswer(TWO_WAYS, DIGEST_1);

/** A model showing the review, the person having answered it. */
function onReview(answers?: Partial<ReviewAnswers>): BringInModel {
	const shown = run(
		atApp(),
		{ type: "call", call: "read", at: 1000 },
		{ type: "read-done", answer: REVIEW, at: 2000 },
	);
	if (answers === undefined) return shown;
	return run(shown, {
		type: "answers",
		answers: { ...initialAnswers(REVIEW), ...answers },
	});
}

/** A model whose create is in flight, from the review the person answered. */
function creating(answers?: Partial<ReviewAnswers>): BringInModel {
	return run(
		onReview(answers),
		{ type: "create-asked", input: inputFor() },
		{ type: "call", call: "create", at: 3000 },
	);
}

const RECEIPT = { appId: "app-1" } as unknown as AdoptedAppReceipt;

const CREATED: BringInEvent = {
	type: "create-done",
	answer: { kind: "created", receipt: RECEIPT },
	at: 4000,
};

/** The picker's list of one project space, its one app free or held in Nova. */
function oneApp(domain: string, claimed: boolean): HqAppPicker {
	return {
		kind: "apps",
		server: "production",
		domain,
		apps: [
			{
				remoteAppId: "app-a",
				name: "A",
				claim: claimed ? { kind: "open", appId: "nova-1", appName: "A" } : null,
			},
		],
	};
}

describe("the reducer", () => {
	it("location to choose clears everything about the app and the create, and keeps the picker", () => {
		const picked = run(
			initialBringInModel(CHOOSE, "project-1"),
			{ type: "connection", domains: ["a"] },
			{ type: "picker-apps", domain: "a", picker: oneApp("a", false) },
			{ type: "picker-app", remoteAppId: "app-a" },
			{ type: "location", location: APP },
			{ type: "resume", input: null },
			{ type: "call", call: "read", at: 1 },
			{ type: "read-done", answer: REVIEW, at: 2 },
			{ type: "create-asked", input: inputFor() },
		);
		const back = run(picked, { type: "location", location: CHOOSE });
		expect(back.answer).toBeNull();
		expect(back.answeredAt).toBeNull();
		expect(back.pendingCreate).toBeNull();
		expect(back.picker).toBe(picked.picker);
		expect(screenOf(back)).toEqual({ kind: "choose" });
	});

	it("location to another app's key clears the app, the create and the landing, and waits on the tab's key again", () => {
		const landed = run(creating(), CREATED, {
			type: "landed",
			answer: "unverified",
			appId: "app-1",
		});
		const moved = run(landed, { type: "location", location: OTHER_APP });
		expect(moved.landing).toBeNull();
		expect(moved.pendingCreate).toBeNull();
		expect(moved.answer).toBeNull();
		expect(moved.resumeChecked).toBe(false);
		expect(nextAct(moved)).toEqual(NO_ACT);
	});

	it("location to the same app's key changes nothing it holds", () => {
		const shown = onReview();
		const same = run(shown, {
			type: "location",
			location: { kind: "app", key: { ...KEY } },
		});
		expect(same.answer).toBe(shown.answer);
		expect(same.resumeChecked).toBe(true);
	});

	it("location leaving an app ends the read in flight, which the hook aborts, and keeps a create's call", () => {
		const left = run(
			reading(),
			{ type: "location", location: OTHER_APP },
			{ type: "resume", input: null },
		);
		expect(left.call).toBeNull();
		expect(nextAct(left)).toEqual({ ...READ, key: OTHER_KEY });

		const leftCreate = run(creating(), { type: "location", location: CHOOSE });
		expect(leftCreate.call).toBe("create");
		expect(leftCreate.pendingCreate).toBeNull();
		expect(leftCreate.leftCreate).toEqual(inputFor());
	});

	it("resume with an input sets the create as create-asked does; with null, the next act is the read", () => {
		const fresh = initialBringInModel(APP, "project-1");
		const resumed = run(fresh, { type: "resume", input: inputFor() });
		expect(resumed.resumeChecked).toBe(true);
		expect(resumed.pendingCreate).toEqual(inputFor());
		expect(nextAct(resumed)).toEqual(createAct());

		const none = run(fresh, { type: "resume", input: null });
		expect(none.resumeChecked).toBe(true);
		expect(none.pendingCreate).toBeNull();
		expect(nextAct(none)).toEqual(READ);
	});

	it("connection sets the domains, chooses a lone one, and clears a chosen one it no longer holds", () => {
		const choosing = initialBringInModel(CHOOSE, "project-1");
		const lone = run(choosing, { type: "connection", domains: ["demo"] });
		expect(lone.picker.domains).toEqual(["demo"]);
		expect(lone.picker.domain).toBe("demo");
		expect(lone.picker.apps).toEqual({ kind: "loading" });

		const several = run(choosing, { type: "connection", domains: ["a", "b"] });
		expect(several.picker.domain).toBeNull();
		expect(several.picker.apps).toEqual({ kind: "idle" });

		const chosen = run(several, { type: "picker-domain", domain: "b" });
		const kept = run(chosen, { type: "connection", domains: ["b", "c"] });
		expect(kept.picker.domain).toBe("b");
		expect(kept.picker.apps).toBe(chosen.picker.apps);

		const gone = run(chosen, { type: "connection", domains: ["a", "c"] });
		expect(gone.picker.domain).toBeNull();
		expect(gone.picker.apps).toEqual({ kind: "idle" });
		expect(gone.picker.remoteAppId).toBeNull();
	});

	it("picker-project changes the Project and nothing else", () => {
		const listing = run(initialBringInModel(CHOOSE, "project-1"), {
			type: "connection",
			domains: ["demo"],
		});
		const other = run(listing, {
			type: "picker-project",
			projectId: "project-2",
		});
		expect(other.picker).toEqual({ ...listing.picker, projectId: "project-2" });
	});

	it("picker-domain chooses the project space, lists it, and clears the app and the filter", () => {
		const model = run(
			initialBringInModel(CHOOSE, "project-1"),
			{ type: "connection", domains: ["a", "b"] },
			{ type: "picker-filter", filter: "visits" },
			{ type: "picker-domain", domain: "a" },
		);
		expect(model.picker).toMatchObject({
			domain: "a",
			apps: { kind: "loading" },
			remoteAppId: null,
			filter: "",
		});
	});

	it("picker-reload lists again where a domain is chosen, and does nothing where none is", () => {
		const idle = run(initialBringInModel(CHOOSE, "project-1"), {
			type: "connection",
			domains: ["a", "b"],
		});
		expect(run(idle, { type: "picker-reload" })).toBe(idle);
		const failed = run(
			idle,
			{ type: "picker-domain", domain: "a" },
			{ type: "picker-apps", domain: "a", picker: null },
		);
		expect(failed.picker.apps).toEqual({ kind: "failed" });
		const reloaded = run(failed, { type: "picker-reload" });
		expect(reloaded.picker.apps).toEqual({ kind: "loading" });
	});

	it("picker-apps keeps a chosen row only where it can still be chosen", () => {
		const picked = run(
			initialBringInModel(CHOOSE, "project-1"),
			{ type: "connection", domains: ["a"] },
			{ type: "picker-apps", domain: "a", picker: oneApp("a", false) },
			{ type: "picker-app", remoteAppId: "app-a" },
			{ type: "picker-reload" },
		);
		expect(picked.picker.remoteAppId).toBe("app-a");
		const free = run(picked, {
			type: "picker-apps",
			domain: "a",
			picker: oneApp("a", false),
		});
		expect(free.picker.remoteAppId).toBe("app-a");
		const claimed = run(picked, {
			type: "picker-apps",
			domain: "a",
			picker: oneApp("a", true),
		});
		expect(claimed.picker.remoteAppId).toBeNull();
		const chosen = run(claimed, { type: "picker-app", remoteAppId: "app-a" });
		expect(chosen.picker.remoteAppId).toBeNull();
	});

	it("read-asked clears everything about the app, and the next act is the read", () => {
		const stopped = run(reading(), {
			type: "read-done",
			answer: { kind: "stop", finding: STOP },
			at: 2,
		});
		expect(nextAct(stopped)).toEqual(NO_ACT);
		const again = run(stopped, { type: "read-asked" });
		expect(again.answer).toBeNull();
		expect(again.answeredAt).toBeNull();
		expect(screenOf(again)).toEqual({ kind: "reading", lost: false });
		expect(nextAct(again)).toEqual(READ);
	});

	it("create-asked holds the input and clears what the last create said", () => {
		const held = run(creating(), {
			type: "create-done",
			answer: { kind: "held", finding: HELD },
			at: 4000,
		});
		expect(held.held).toEqual(HELD);
		const asked = run(
			held,
			{ type: "choice-needed", tag: "districts" },
			{ type: "create-asked", input: inputFor() },
		);
		expect(asked).toMatchObject({
			pendingCreate: inputFor(),
			held: null,
			lead: null,
			refusal: null,
			failed: null,
			needsChoice: null,
			lost: 0,
			call: null,
		});
		expect(nextAct(asked)).toEqual(createAct());
	});

	it("call sets the call, clears the stage and the count, and starts the wait once", () => {
		const first = run(atApp(), { type: "call", call: "read", at: 1000 });
		expect(first).toMatchObject({
			call: "read",
			stage: null,
			files: null,
			waitingSince: 1000,
		});
		const counting = run(
			first,
			{ type: "stage", stage: "checking-media" },
			{ type: "files", done: 1, total: 4 },
			{ type: "lost", call: "read" },
			{ type: "call", call: "read", at: 9000 },
		);
		expect(counting).toMatchObject({
			stage: null,
			files: null,
			waitingSince: 1000,
		});
	});

	it("stage and files are taken only while a call is in flight", () => {
		const idle = atApp();
		expect(run(idle, { type: "stage", stage: "reading-app" })).toBe(idle);
		expect(run(idle, { type: "files", done: 1, total: 2 })).toBe(idle);
	});

	it("drops the lines of a create the person left, on another app's reading screen", () => {
		const elsewhere = run(
			creating(),
			{ type: "location", location: CHOOSE },
			{ type: "location", location: OTHER_APP },
			{ type: "resume", input: null },
		);
		expect(elsewhere.call).toBe("create");
		expect(screenOf(elsewhere)).toEqual({ kind: "reading", lost: false });
		expect(
			run(
				elsewhere,
				{ type: "stage", stage: "bringing-in-media" },
				{ type: "files", done: 3, total: 40 },
			),
		).toBe(elsewhere);

		// The create on screen takes its own lines.
		const shown = run(
			creating(),
			{ type: "stage", stage: "bringing-in-media" },
			{ type: "files", done: 3, total: 40 },
		);
		expect(shown.stage).toBe("bringing-in-media");
		expect(shown.files).toEqual({ done: 3, total: 40 });
	});

	it("signed-out ends the request and the create, and holds wherever the address goes", () => {
		const out = run(creating(), { type: "signed-out" });
		expect(out).toMatchObject({
			signedOut: true,
			call: null,
			pendingCreate: null,
			stage: null,
			files: null,
			waitingSince: null,
		});
		const moved = run(
			out,
			{ type: "location", location: CHOOSE },
			{ type: "location", location: OTHER_APP },
			{ type: "resume", input: null },
		);
		expect(moved.signedOut).toBe(true);
	});

	it("stage drops the count where the stage counts no files or is a new stage", () => {
		const counting = run(
			creating(),
			{ type: "stage", stage: "checking-media" },
			{ type: "files", done: 3, total: 4 },
		);
		const filesAt = (
			stage: "checking-media" | "bringing-in-media" | "checking",
		) => run(counting, { type: "stage", stage }).files;
		expect(counting.files).toEqual({ done: 3, total: 4 });
		expect(filesAt("checking-media")).toEqual({ done: 3, total: 4 });
		expect(filesAt("bringing-in-media")).toBeNull();
		expect(filesAt("checking")).toBeNull();
	});

	it("read-done sets the answer and ends the call, keeping what a create left to say", () => {
		expect(onReview()).toMatchObject({
			answer: REVIEW,
			answeredAt: 2000,
			call: null,
			stage: null,
			files: null,
			waitingSince: null,
			lost: 0,
			answers: null,
			carried: null,
		});
	});

	it("create-done created keeps the create and its call until the landing", () => {
		const done = run(creating(), CREATED);
		expect(done.call).toBe("create");
		expect(done.pendingCreate).toEqual(inputFor());
		expect(screenOf(done)).toEqual({ kind: "creating", lost: false });
		expect(nextAct(done)).toEqual(NO_ACT);
	});

	it("landed sets the landing and ends the create whatever its answer", () => {
		for (const answer of ["landed", "leaving", "unverified"] as const) {
			const model = run(creating(), CREATED, {
				type: "landed",
				answer,
				appId: "app-1",
			});
			expect(model.landing).toEqual({ answer, appId: "app-1" });
			expect(model.call).toBeNull();
			expect(model.pendingCreate).toBeNull();
		}
	});

	it("failed holds the failed request and keeps the create", () => {
		const failed = run(creating(), { type: "failed", call: "create" });
		expect(failed).toMatchObject({
			failed: "create",
			call: null,
			stage: null,
			files: null,
			lost: 0,
			pendingCreate: inputFor(),
		});
	});

	it("lost counts one more, ends the call and keeps everything else", () => {
		const before = creating();
		const lost = run(before, { type: "lost", call: "create" });
		expect(lost).toEqual({ ...before, lost: 1, call: null });
	});

	it("refused before the stream sets the refusal and ends the call and the create", () => {
		const refused = run(creating(), {
			type: "refused",
			call: "create",
			refusal: "no_project_access",
		});
		expect(refused).toMatchObject({
			refusal: "no_project_access",
			call: null,
			pendingCreate: null,
		});
		expect(screenOf(refused)).toEqual({
			kind: "refused",
			refusal: "no_project_access",
		});
	});

	it("retry clears the lost count and the failure", () => {
		const twice = run(
			creating(),
			{ type: "lost", call: "create" },
			{ type: "call", call: "create", at: 5 },
			{ type: "lost", call: "create" },
		);
		expect(twice.lost).toBe(2);
		expect(run(twice, { type: "retry" })).toMatchObject({
			lost: 0,
			failed: null,
		});
		const failed = run(creating(), { type: "failed", call: "create" });
		expect(run(failed, { type: "retry" })).toMatchObject({
			lost: 0,
			failed: null,
		});
	});

	it("answers are taken for the review on screen, clearing the choice asked for and the answer refusals", () => {
		const asked = run(
			onReview(),
			{ type: "choice-needed", tag: "districts" },
			{ type: "create-asked", input: inputFor() },
			{ type: "call", call: "create", at: 1 },
			{
				type: "create-done",
				answer: { kind: "refused", refusal: "choice_not_offered" },
				at: 2,
			},
			{ type: "choice-needed", tag: "districts" },
		);
		expect(asked.refusal).toBe("choice_not_offered");
		const answered = run(asked, {
			type: "answers",
			answers: {
				...initialAnswers(REVIEW),
				tableChoices: { districts: "use-project" },
			},
		});
		expect(answered.answers?.tableChoices).toEqual({
			districts: "use-project",
		});
		expect(answered.needsChoice).toBeNull();
		expect(answered.refusal).toBeNull();

		const unrelated = run(asked, {
			type: "answers",
			answers: { ...initialAnswers(REVIEW), appName: "Visits" },
		});
		expect(unrelated.needsChoice).toEqual(asked.needsChoice);
		expect(unrelated.refusal).toBeNull();
	});

	it("answers for another digest are dropped", () => {
		const shown = onReview();
		const stale = run(shown, {
			type: "answers",
			answers: { ...initialAnswers(REVIEW), reviewDigest: DIGEST_2 },
		});
		expect(stale).toBe(shown);
	});

	it("drops the last line of a request that is not in flight", () => {
		const shown = onReview();
		const refused = run(shown, {
			type: "refused",
			call: "read",
			refusal: "invalid_input",
		});
		expect(refused).toBe(shown);
		const stale = run(shown, {
			type: "read-done",
			answer: { kind: "stop", finding: STOP },
			at: 9,
		});
		expect(stale).toBe(shown);
		expect(run(shown, { type: "lost", call: "create" })).toBe(shown);
	});

	it("choice-needed sets the tag and raises the nonce", () => {
		const once = run(onReview(), { type: "choice-needed", tag: "districts" });
		const twice = run(once, { type: "choice-needed", tag: "districts" });
		expect(once.needsChoice).toEqual({ tag: "districts", nonce: 1 });
		expect(twice.needsChoice).toEqual({ tag: "districts", nonce: 2 });
	});
});

describe("screenOf", () => {
	const ANSWERS = {
		stop: { kind: "stop", finding: STOP },
		account: ACCOUNT,
		review: REVIEW,
	} satisfies {
		readonly [K in ReadingAnswer["kind"]]: Extract<ReadingAnswer, { kind: K }>;
	};
	const EXPECTED = {
		stop: { kind: "stopped", finding: STOP },
		account: { kind: "account", answer: ACCOUNT },
		review: { kind: "review", answer: REVIEW, answers: initialAnswers(REVIEW) },
	} satisfies Record<ReadingAnswer["kind"], BringInScreen>;

	for (const kind of Object.keys(ANSWERS) as ReadingAnswer["kind"][]) {
		it(`draws a read's ${kind}`, () => {
			const model = run(reading(), {
				type: "read-done",
				answer: ANSWERS[kind],
				at: 2,
			});
			expect(screenOf(model)).toEqual(EXPECTED[kind]);
		});
	}

	it("draws none and choose by the location alone", () => {
		expect(screenOf(initialBringInModel(NONE, null))).toEqual({
			kind: "none",
		});
		expect(screenOf(initialBringInModel(CHOOSE, null))).toEqual({
			kind: "choose",
		});
	});

	it("reads while no answer is held, and offers Try again after two lost requests", () => {
		expect(screenOf(reading())).toEqual({ kind: "reading", lost: false });
		const once = run(reading(), { type: "lost", call: "read" });
		expect(screenOf(once)).toEqual({ kind: "reading", lost: false });
		const twice = run(
			once,
			{ type: "call", call: "read", at: 2 },
			{ type: "lost", call: "read" },
		);
		expect(screenOf(twice)).toEqual({ kind: "reading", lost: true });
	});

	it("draws signed-out over the picker and every screen of an app, and never Try again", () => {
		const fromList = run(
			initialBringInModel(CHOOSE, "project-1"),
			{ type: "connection", domains: ["a"] },
			{ type: "signed-out" },
		);
		expect(screenOf(fromList)).toEqual({ kind: "signed-out" });
		for (const model of [reading(), creating(), onReview()]) {
			const out = run(model, { type: "signed-out" });
			expect(screenOf(out)).toEqual({ kind: "signed-out" });
			expect(screenOf(run(out, { type: "retry" }))).toEqual({
				kind: "signed-out",
			});
		}
		expect(
			screenOf(run(fromList, { type: "location", location: NONE })),
		).toEqual({ kind: "none" });
	});

	it("draws a failed read until Try again", () => {
		const failed = run(reading(), { type: "failed", call: "read" });
		expect(screenOf(failed)).toEqual({ kind: "failed", operation: "read" });
		expect(screenOf(run(failed, { type: "retry" }))).toEqual({
			kind: "reading",
			lost: false,
		});
	});
});

describe("nextAct", () => {
	it("acts on nothing at no location, and lists a project space only while it is loading", () => {
		expect(nextAct(initialBringInModel(NONE, "project-1"))).toEqual(NO_ACT);
		const choosing = initialBringInModel(CHOOSE, "project-1");
		expect(nextAct(choosing)).toEqual(NO_ACT);
		const loading = run(
			choosing,
			{ type: "connection", domains: ["a", "b"] },
			{ type: "picker-domain", domain: "b" },
		);
		expect(nextAct(loading)).toEqual({ kind: "list-apps", domain: "b" });
		const loaded = run(loading, {
			type: "picker-apps",
			domain: "b",
			picker: { kind: "not-connected" },
		});
		expect(nextAct(loaded)).toEqual(NO_ACT);
	});

	it("sends nothing at an app's address until the tab's key is looked at, then reads", () => {
		const fresh = initialBringInModel(APP, "project-1");
		expect(fresh.resumeChecked).toBe(false);
		expect(nextAct(fresh)).toEqual(NO_ACT);
		const checked = run(fresh, { type: "resume", input: null });
		expect(nextAct(checked)).toEqual(READ);
	});

	it("sends nothing while a call is in flight", () => {
		expect(nextAct(reading())).toEqual(NO_ACT);
		expect(nextAct(creating())).toEqual(NO_ACT);
	});

	it("reads once more three seconds after one lost request, and not again after two", () => {
		const once = run(reading(), { type: "lost", call: "read" });
		expect(nextAct(once)).toEqual({ ...READ, afterMs: 3000 });
		const twice = run(
			once,
			{ type: "call", call: "read", at: 2 },
			{ type: "lost", call: "read" },
		);
		expect(nextAct(twice)).toEqual(NO_ACT);
		expect(nextAct(run(twice, { type: "retry" }))).toEqual(READ);
	});

	it("never sends a failed request again by itself", () => {
		const failed = run(reading(), { type: "failed", call: "read" });
		expect(nextAct(failed)).toEqual(NO_ACT);
		expect(nextAct(run(failed, { type: "retry" }))).toEqual(READ);
	});

	it("sends nothing once a request answered that the session ended", () => {
		const fromList = run(
			initialBringInModel(CHOOSE, "project-1"),
			{ type: "connection", domains: ["a"] },
			{ type: "signed-out" },
		);
		expect(fromList.picker.apps).toEqual({ kind: "loading" });
		expect(nextAct(fromList)).toEqual(NO_ACT);
		const read = run(reading(), { type: "signed-out" });
		expect(nextAct(read)).toEqual(NO_ACT);
		expect(nextAct(run(read, { type: "retry" }))).toEqual(NO_ACT);
		expect(nextAct(run(creating(), { type: "signed-out" }))).toEqual(NO_ACT);
	});

	it("sends nothing over a refusal that leaves nothing to show", () => {
		for (const refusal of ["no_project_access", "invalid_input"] as const) {
			const refused = run(reading(), {
				type: "refused",
				call: "read",
				refusal,
			});
			expect(screenOf(refused)).toEqual({ kind: "refused", refusal });
			expect(nextAct(refused)).toEqual(NO_ACT);
		}
	});
});

describe("a create, as a sequence of events", () => {
	it("stays on the creating screen from the press to its end, and never shows the review", () => {
		const input = inputFor(KEY, { appName: "Visits" });
		const create = (afterMs: number) => ({ kind: "create", input, afterMs });
		const screens: BringInScreen[] = [];
		const step = (model: BringInModel, ...events: BringInEvent[]) => {
			const next = run(model, ...events);
			screens.push(screenOf(next));
			return next;
		};

		let model = step(onReview({ appName: "Visits" }), {
			type: "create-asked",
			input,
		});
		expect(screenOf(model)).toEqual({ kind: "creating", lost: false });
		expect(nextAct(model)).toEqual(create(0));

		model = step(
			model,
			{ type: "call", call: "create", at: 10 },
			{ type: "stage", stage: "bringing-in-media" },
			{ type: "files", done: 2, total: 9 },
		);
		expect(screenOf(model)).toEqual({ kind: "creating", lost: false });
		expect(model.stage).toBe("bringing-in-media");
		expect(model.files).toEqual({ done: 2, total: 9 });

		model = step(model, { type: "lost", call: "create" });
		expect(screenOf(model)).toEqual({ kind: "creating", lost: false });
		expect(nextAct(model)).toEqual(create(3000));

		model = step(
			model,
			{ type: "call", call: "create", at: 20 },
			{ type: "lost", call: "create" },
		);
		expect(screenOf(model)).toEqual({ kind: "creating", lost: true });
		expect(nextAct(model)).toEqual(NO_ACT);

		model = step(model, { type: "retry" });
		expect(nextAct(model)).toEqual(create(0));

		model = step(
			model,
			{ type: "call", call: "create", at: 30 },
			{ type: "failed", call: "create" },
		);
		expect(screenOf(model)).toEqual({ kind: "failed", operation: "create" });
		expect(nextAct(model)).toEqual(NO_ACT);

		model = step(model, { type: "retry" });
		expect(nextAct(model)).toEqual(create(0));

		expect(screens.some((screen) => screen.kind === "review")).toBe(false);
	});

	it("drops the answers of a create the person left, but for the one that created", () => {
		const left = run(creating(), { type: "location", location: CHOOSE });
		const held = run(left, {
			type: "create-done",
			answer: { kind: "held", finding: HELD },
			at: 5,
		});
		expect(held).toEqual({ ...left, call: null, leftCreate: null });
		const failed = run(left, { type: "failed", call: "create" });
		expect(failed).toEqual({ ...left, call: null, leftCreate: null });
		const created = run(left, CREATED);
		expect(created).toBe(left);
	});

	it("holds the read of another app until a create the person left ends, and that app's reading screen names the create's app", () => {
		const elsewhere = run(
			creating(),
			{ type: "location", location: CHOOSE },
			{ type: "location", location: OTHER_APP },
			{ type: "resume", input: null },
		);
		expect(elsewhere.leftCreate).toEqual(inputFor());
		expect(screenOf(elsewhere)).toEqual({ kind: "reading", lost: false });
		expect(nextAct(elsewhere)).toEqual(NO_ACT);

		// Any end but created ends the wait, and the other app is read.
		for (const end of [
			{
				type: "create-done",
				answer: { kind: "held", finding: HELD },
				at: 5,
			},
			{ type: "failed", call: "create" },
			{ type: "lost", call: "create" },
			{ type: "refused", call: "create", refusal: "name_missing" },
		] satisfies BringInEvent[]) {
			const ended = run(elsewhere, end);
			expect(ended.leftCreate, end.type).toBeNull();
			expect(ended.lost, end.type).toBe(0);
			expect(nextAct(ended), end.type).toEqual({ ...READ, key: OTHER_KEY });
		}

		// A create that created lands, and nothing is read.
		const landed = run(elsewhere, CREATED, {
			type: "landed",
			answer: "landed",
			appId: "app-1",
		});
		expect(landed.leftCreate).toBeNull();
		expect(nextAct(landed)).toEqual(NO_ACT);

		// A session that ended ends the wait too.
		expect(run(elsewhere, { type: "signed-out" }).leftCreate).toBeNull();
	});

	it("going back to the app of a create still running shows its creating screen and takes its end", () => {
		const back = run(
			creating(),
			{ type: "location", location: CHOOSE },
			{ type: "location", location: OTHER_APP },
			{ type: "resume", input: null },
			{ type: "location", location: APP },
			{ type: "resume", input: null },
		);
		expect(back.pendingCreate).toEqual(inputFor());
		expect(back.leftCreate).toBeNull();
		expect(back.call).toBe("create");
		expect(screenOf(back)).toEqual({ kind: "creating", lost: false });
		expect(nextAct(back)).toEqual(NO_ACT);
		expect(run(back, { type: "stage", stage: "bringing-in-media" }).stage).toBe(
			"bringing-in-media",
		);
		const held = run(back, {
			type: "create-done",
			answer: { kind: "held", finding: HELD },
			at: 5,
		});
		expect(held.held).toEqual(HELD);
		expect(held.call).toBeNull();
	});
});

describe("every answer of a create", () => {
	const changedReview = reviewAnswer(
		review({
			runsOn: [choice(null, { preselected: true }), choice("android")],
			tables: [choiceTable("districts", { hq: true, project: true })],
		}),
		DIGEST_2,
	);

	function answered(answer: CreateAnswer, from = creating()): BringInModel {
		return run(from, { type: "create-done", answer, at: 4000 });
	}

	it("changed with a review: the lead is changed-review and the answers are the ones carried", () => {
		const from = creating({ appName: "Visits", runsOnlyOn: "android" });
		const model = answered({ kind: "changed", now: changedReview }, from);
		expect(model.lead).toEqual({ kind: "changed-review", dropped: false });
		expect(model.answers).toEqual({
			reviewDigest: DIGEST_2,
			appName: "Visits",
			runsOnlyOn: "android",
			splitDatetime: false,
			tableChoices: {},
		});
		expect(model.pendingCreate).toBeNull();
		expect(model.call).toBeNull();
		expect(screenOf(model)).toMatchObject({
			kind: "review",
			answer: changedReview,
		});
	});

	it("changed with a review that no longer offers an answer: the lead says a choice was dropped", () => {
		const from = creating({ tableChoices: { districts: "use-project" } });
		const narrowed = reviewAnswer(
			review({
				runsOn: [choice(null, { preselected: true })],
				tables: [choiceTable("districts", { hq: true, project: false })],
			}),
			DIGEST_2,
		);
		const model = answered({ kind: "changed", now: narrowed }, from);
		expect(model.lead).toEqual({ kind: "changed-review", dropped: true });
		expect(model.answers?.tableChoices).toEqual({});
	});

	it("changed with an account: the account under its lead", () => {
		const model = answered({ kind: "changed", now: ACCOUNT });
		expect(model.lead).toEqual({ kind: "changed-account", dropped: false });
		expect(screenOf(model)).toEqual({ kind: "account", answer: ACCOUNT });
		expect(model.answers).toBeNull();
	});

	it("changed with a stop: the stop, under changed-stop, or changed-already-in-nova for that code", () => {
		const stop = answered({
			kind: "changed",
			now: { kind: "stop", finding: STOP },
		});
		expect(stop.lead).toEqual({ kind: "changed-stop", dropped: false });
		expect(screenOf(stop)).toEqual({ kind: "stopped", finding: STOP });
		const claimed = answered({
			kind: "changed",
			now: { kind: "stop", finding: ALREADY_IN_NOVA },
		});
		expect(claimed.lead).toEqual({
			kind: "changed-already-in-nova",
			dropped: false,
		});
	});

	it("read-again carries the answers to the next read, which keeps the lead", () => {
		const from = creating({
			appName: "Visits",
			tableChoices: { districts: "use-project" },
		});
		const model = answered({ kind: "read-again" }, from);
		expect(model.carried).toEqual({ answers: from.answers, review: TWO_WAYS });
		expect(model.answer).toBeNull();
		expect(model.answers).toBeNull();
		expect(model.lead).toEqual({ kind: "read-again", dropped: false });
		expect(screenOf(model)).toEqual({ kind: "reading", lost: false });
		expect(nextAct(model)).toEqual(READ);

		const back = run(
			model,
			{ type: "call", call: "read", at: 5000 },
			{ type: "read-done", answer: changedReview, at: 6000 },
		);
		expect(back.lead).toEqual({ kind: "read-again", dropped: false });
		expect(back.carried).toBeNull();
		expect(back.answers).toEqual({
			reviewDigest: DIGEST_2,
			appName: "Visits",
			runsOnlyOn: null,
			splitDatetime: false,
			tableChoices: { districts: "use-project" },
		});
	});

	it("check-failed: the account of the one finding, under its lead", () => {
		const finding = circumstanceFinding(
			"read-back-differs",
			{ kind: "app" },
			{ name: "form-ids" },
		);
		const model = answered({ kind: "check-failed", finding });
		expect(model.lead).toEqual({ kind: "check-failed", dropped: false });
		expect(screenOf(model)).toEqual({
			kind: "account",
			answer: accountOfOne(finding, "Household visits"),
		});
		expect(model.answers).toBeNull();
		expect(model.pendingCreate).toBeNull();
	});

	it("held: the review with the answers kept and the finding held", () => {
		const from = creating({ appName: "Visits" });
		const model = answered({ kind: "held", finding: HELD }, from);
		expect(model.held).toEqual(HELD);
		expect(model.lead).toEqual({ kind: "held", dropped: false });
		expect(model.answers).toBe(from.answers);
		expect(screenOf(model)).toMatchObject({
			kind: "review",
			answers: from.answers,
		});
	});

	const ON_REVIEW = [
		"name_missing",
		"choice_not_offered",
		"choice_missing",
		"project_changed",
	] as const;
	for (const refusal of ON_REVIEW) {
		it(`refused ${refusal}: drawn on the review, with the answers kept`, () => {
			const from = creating({ appName: "Visits" });
			const model = answered({ kind: "refused", refusal }, from);
			expect(model.refusal).toBe(refusal);
			expect(model.answers).toBe(from.answers);
			expect(screenOf(model)).toMatchObject({ kind: "review" });
		});
	}

	for (const refusal of ["no_project_access", "app_unavailable"] as const) {
		it(`refused ${refusal}: the refused screen, and nothing sent`, () => {
			const model = answered({ kind: "refused", refusal });
			expect(screenOf(model)).toEqual({ kind: "refused", refusal });
			expect(nextAct(model)).toEqual(NO_ACT);
		});
	}

	it("a held answer to a create sent again after a reload reads the app, and stands above its review", () => {
		const resumed = run(
			initialBringInModel(APP, "project-1"),
			{ type: "resume", input: inputFor() },
			{ type: "call", call: "create", at: 1 },
			{ type: "create-done", answer: { kind: "held", finding: HELD }, at: 2 },
		);
		expect(nextAct(resumed)).toEqual(READ);
		const read = run(
			resumed,
			{ type: "call", call: "read", at: 3 },
			{ type: "read-done", answer: REVIEW, at: 4 },
		);
		expect(read.held).toEqual(HELD);
		expect(read.lead).toEqual({ kind: "held", dropped: false });
		expect(screenOf(read)).toMatchObject({ kind: "review" });
	});
});

describe("carryAnswers", () => {
	const before = review({
		appName: "Visits in HQ",
		runsOn: [
			choice(null, { preselected: true }),
			choice("android", { splitDatetime: true }),
		],
		tables: [
			choiceTable("districts", { hq: true, project: true }),
			choiceTable("crops", { hq: true, project: true }),
		],
	});
	const previous: ReviewAnswers = {
		reviewDigest: DIGEST_1,
		appName: "My visits",
		runsOnlyOn: "android",
		splitDatetime: true,
		tableChoices: { districts: "use-project", crops: "use-commcare-hq" },
	};

	it("keeps what is still offered and the name the person typed, under the new digest", () => {
		const now = review({ ...before, appName: "Visits renamed in HQ" });
		expect(carryAnswers(previous, before, now, DIGEST_3)).toEqual({
			answers: { ...previous, reviewDigest: DIGEST_3 },
			dropped: false,
		});
	});

	it("takes the new review's name where the person had not changed it", () => {
		const untouched = { ...previous, appName: "Visits in HQ" };
		const now = review({ ...before, appName: "Visits renamed in HQ" });
		const carried = carryAnswers(untouched, before, now, DIGEST_3);
		expect(carried.answers.appName).toBe("Visits renamed in HQ");
	});

	it("takes the preselected entry, and leaves a tag unanswered, where each is no longer offered", () => {
		const now = review({
			...before,
			runsOn: [choice(null, { preselected: true }), choice("android")],
			tables: [
				choiceTable("districts", { hq: true, project: false }),
				choiceTable("crops", { hq: true, project: true }),
			],
		});
		const carried = carryAnswers(previous, before, now, DIGEST_3);
		expect(carried.dropped).toBe(true);
		expect(carried.answers).toEqual({
			reviewDigest: DIGEST_3,
			appName: "My visits",
			runsOnlyOn: null,
			splitDatetime: false,
			tableChoices: { crops: "use-commcare-hq" },
		});
	});

	it("asks a table again whose review entry changed though its answer is still offered, and keeps one whose entry is the same", () => {
		const districts = choiceTable("districts", { hq: true, project: true });
		const grown: ReviewTable = {
			...districts,
			choice: districts.choice && {
				...districts.choice,
				apps: [{ appId: "stock-app", appName: "Stock counts", deleted: false }],
			},
		};
		const now = review({
			...before,
			tables: [grown, choiceTable("crops", { hq: true, project: true })],
		});
		const carried = carryAnswers(previous, before, now, DIGEST_3);
		expect(carried.dropped).toBe(true);
		expect(carried.answers.tableChoices).toEqual({ crops: "use-commcare-hq" });
	});

	it("drops a table answer whose table no longer asks a choice", () => {
		const now = review({
			...before,
			tables: [choiceTable("crops", { hq: true, project: true })],
		});
		const carried = carryAnswers(previous, before, now, DIGEST_3);
		expect(carried.dropped).toBe(true);
		expect(carried.answers.tableChoices).toEqual({ crops: "use-commcare-hq" });
	});
});

describe("resumableCreate", () => {
	const NOW = 1_800_000_000_000;
	const WINDOW = BRING_IN_RESUME_WINDOW_MS;
	const stored = (input: unknown, age: number) =>
		JSON.stringify({ at: NOW - age, input });
	const resume = (raw: string | null) => resumableCreate(raw, KEY, NOW);

	it("answers the input of the address's own key written inside the window", () => {
		expect(resume(stored(inputFor(), 1000))).toEqual(inputFor());
		expect(resume(stored(inputFor(), WINDOW - 1))).toEqual(inputFor());
	});

	it("answers null for another app's key", () => {
		expect(resume(stored(inputFor(OTHER_KEY), 1000))).toBeNull();
		const otherProject = inputFor({ ...KEY, projectId: "project-2" });
		expect(resume(stored(otherProject, 1000))).toBeNull();
	});

	it("answers null for a create written a window ago or more", () => {
		expect(resume(stored(inputFor(), WINDOW))).toBeNull();
		expect(resume(stored(inputFor(), 2 * WINDOW))).toBeNull();
	});

	it("answers null for text that fails the create's schema, and for no text", () => {
		const badId = { ...inputFor(), readingId: "not-an-id" };
		expect(resume(stored(badId, 1000))).toBeNull();
		expect(resume(stored({ ...inputFor(), extra: 1 }, 1000))).toBeNull();
		expect(resume("{not json")).toBeNull();
		expect(resume(JSON.stringify({ input: inputFor() }))).toBeNull();
		expect(resume(null)).toBeNull();
	});
});

describe("the three ends of a landing", () => {
	function landing(answer: "landed" | "leaving" | "unverified"): BringInModel {
		return run(creating(), CREATED, { type: "landed", answer, appId: "app-1" });
	}

	it("unverified shows the app could not be opened, and sends nothing more", () => {
		const model = landing("unverified");
		expect(screenOf(model)).toEqual({ kind: "unopened", appId: "app-1" });
		expect(nextAct(model)).toEqual(NO_ACT);
	});

	it("leaving and landed keep the creating screen, and send nothing more", () => {
		for (const answer of ["leaving", "landed"] as const) {
			const model = landing(answer);
			expect(screenOf(model)).toEqual({ kind: "creating", lost: false });
			expect(nextAct(model)).toEqual(NO_ACT);
		}
	});
});

describe("the picker", () => {
	const LIST: HqAppPicker = {
		kind: "apps",
		server: "production",
		domain: "b",
		apps: [],
	};

	it("lists a lone project space at once", () => {
		const model = run(initialBringInModel(CHOOSE, "project-1"), {
			type: "connection",
			domains: ["demo"],
		});
		expect(nextAct(model)).toEqual({ kind: "list-apps", domain: "demo" });
	});

	it("returns a loaded list to loading on reload, and keeps the list over a Project change", () => {
		const loaded = run(
			initialBringInModel(CHOOSE, "project-1"),
			{ type: "connection", domains: ["a", "b"] },
			{ type: "picker-domain", domain: "b" },
			{ type: "picker-apps", domain: "b", picker: LIST },
		);
		expect(loaded.picker.apps).toEqual({ kind: "loaded", picker: LIST });
		const moved = run(loaded, {
			type: "picker-project",
			projectId: "project-2",
		});
		expect(moved.picker.apps).toBe(loaded.picker.apps);
		const reloaded = run(loaded, { type: "picker-reload" });
		expect(reloaded.picker.apps).toEqual({ kind: "loading" });
	});

	it("drops a list for a project space no longer chosen", () => {
		const loading = run(
			initialBringInModel(CHOOSE, "project-1"),
			{ type: "connection", domains: ["a", "b"] },
			{ type: "picker-domain", domain: "a" },
			{ type: "picker-domain", domain: "b" },
		);
		const stale = run(loading, {
			type: "picker-apps",
			domain: "a",
			picker: { ...LIST, domain: "a" },
		});
		expect(stale).toBe(loading);
	});

	it("clears a chosen project space the connection no longer reaches", () => {
		const model = run(
			initialBringInModel(CHOOSE, "project-1"),
			{ type: "connection", domains: ["a", "b"] },
			{ type: "picker-domain", domain: "a" },
			{ type: "connection", domains: ["b", "c"] },
		);
		expect(model.picker.domain).toBeNull();
		expect(nextAct(model)).toEqual(NO_ACT);
	});

	it("chooses nothing without a Project", () => {
		const model = run(initialBringInModel(CHOOSE, null), {
			type: "connection",
			domains: ["demo"],
		});
		expect(model.picker.domain).toBeNull();
		expect(nextAct(model)).toEqual(NO_ACT);
	});

	it("lists again a project space whose list found no key once a connection reaches it", () => {
		const unkeyed = run(
			initialBringInModel(CHOOSE, "project-1"),
			{ type: "connection", domains: ["a", "b"] },
			{ type: "picker-domain", domain: "a" },
			{ type: "picker-apps", domain: "a", picker: { kind: "not-connected" } },
		);
		expect(nextAct(unkeyed)).toEqual(NO_ACT);
		const checked = run(unkeyed, { type: "connection", domains: ["a", "b"] });
		expect(checked.picker.domain).toBe("a");
		expect(checked.picker.apps).toEqual({ kind: "loading" });
		expect(nextAct(checked)).toEqual({ kind: "list-apps", domain: "a" });

		// A list that found the key stays as it is over the same check.
		const keyed = run(
			unkeyed,
			{ type: "picker-reload" },
			{ type: "picker-apps", domain: "a", picker: { ...LIST, domain: "a" } },
		);
		const again = run(keyed, { type: "connection", domains: ["a", "b"] });
		expect(again.picker.apps).toBe(keyed.picker.apps);
	});
});

describe("accountOfOne", () => {
	it("counts its one finding under that finding's standing", () => {
		const fix = circumstanceFinding(
			"menu-unreadable-in-hq",
			{ kind: "app" },
			{},
		);
		expect(accountOfOne(fix, null).counts).toEqual({
			notYet: 0,
			never: 0,
			fixInHq: 1,
		});
		expect(accountOfOne(TOO_LARGE, null).counts).toEqual({
			notYet: 1,
			never: 0,
			fixInHq: 0,
		});
		expect(accountOfOne(TOO_LARGE, null)).toMatchObject({
			more: 0,
			mediaChecked: true,
		});
	});
});
