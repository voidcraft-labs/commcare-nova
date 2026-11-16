import { describe, expect, it } from "vitest";
import type { ReadingStage } from "@/lib/deployment";
import { READING_STAGES } from "@/lib/deployment/reading/types";
import { READING_STAGE_LABELS } from "@/lib/publish/hqReadingCopy";
import {
	type ProgressEmitter,
	type ProgressStage,
	readingProgressSink,
} from "../progress";

interface Sent {
	readonly stage: ProgressStage;
	readonly message: string;
	readonly extra?: Record<string, unknown>;
}

/** An emitter that keeps what it was asked to send, in order. */
function recordingEmitter(): { emitter: ProgressEmitter; sent: Sent[] } {
	const sent: Sent[] = [];
	return {
		sent,
		emitter: {
			notify(stage, message, extra) {
				sent.push(
					extra === undefined ? { stage, message } : { stage, message, extra },
				);
			},
		},
	};
}

/** A clock the test moves by hand. */
function testClock(): { now: () => number; advance: (ms: number) => void } {
	let at = 0;
	return {
		now: () => at,
		advance: (ms) => {
			at += ms;
		},
	};
}

const LABEL_WITH_NO_COUNT: Record<ReadingStage, string> = {
	connecting: READING_STAGE_LABELS.connecting,
	"reading-app": READING_STAGE_LABELS["reading-app"],
	"reading-project-data": READING_STAGE_LABELS["reading-project-data"],
	checking: READING_STAGE_LABELS.checking,
	"checking-media": READING_STAGE_LABELS["checking-media"](null),
	"bringing-in-media": READING_STAGE_LABELS["bringing-in-media"](null),
	creating: READING_STAGE_LABELS.creating,
};

describe("readingProgressSink", () => {
	it("sends one notification per stage, under its hq_ tag, with the stage's label", () => {
		const { emitter, sent } = recordingEmitter();
		const clock = testClock();
		const sink = readingProgressSink(emitter, clock.now);
		for (const stage of READING_STAGES) sink({ type: "stage", stage });
		expect(sent).toEqual([
			{ stage: "hq_connecting", message: "Connecting to CommCare HQ" },
			{ stage: "hq_reading_app", message: "Reading the app" },
			{
				stage: "hq_reading_project_data",
				message: "Reading its lookup tables and places",
			},
			{ stage: "hq_checking", message: "Checking what Nova read" },
			{ stage: "hq_checking_media", message: "Checking pictures and sounds" },
			{
				stage: "hq_bringing_in_media",
				message: "Bringing in pictures and sounds",
			},
			{ stage: "hq_creating", message: "Creating your app" },
		]);
		/* The table above is the copy as written; this holds it to the copy module. */
		expect(sent.map((one) => one.message)).toEqual(
			READING_STAGES.map((stage) => LABEL_WITH_NO_COUNT[stage]),
		);
		/* Every tag is `hq_` and the stage with its hyphens as underscores. */
		expect(sent.map((one) => one.stage)).toEqual(
			READING_STAGES.map((stage) => `hq_${stage.replaceAll("-", "_")}`),
		);
	});

	it("sends a file count at most once a second, under the stage last named", () => {
		const { emitter, sent } = recordingEmitter();
		const clock = testClock();
		const sink = readingProgressSink(emitter, clock.now);
		sink({ type: "stage", stage: "checking-media" });
		sink({ type: "files", done: 1, total: 10 });
		clock.advance(400);
		sink({ type: "files", done: 2, total: 10 });
		clock.advance(599);
		sink({ type: "files", done: 3, total: 10 });
		clock.advance(1);
		sink({ type: "files", done: 4, total: 10 });
		clock.advance(10);
		sink({ type: "files", done: 5, total: 10 });
		expect(sent).toEqual([
			{ stage: "hq_checking_media", message: "Checking pictures and sounds" },
			{
				stage: "hq_checking_media",
				message: "Checking pictures and sounds",
				extra: { done: 1, total: 10 },
			},
			{
				stage: "hq_checking_media",
				message: "Checking pictures and sounds",
				extra: { done: 4, total: 10 },
			},
		]);
	});

	it("always sends the count whose done is total, however soon it comes", () => {
		const { emitter, sent } = recordingEmitter();
		const clock = testClock();
		const sink = readingProgressSink(emitter, clock.now);
		sink({ type: "stage", stage: "bringing-in-media" });
		sink({ type: "files", done: 1, total: 3 });
		clock.advance(5);
		sink({ type: "files", done: 2, total: 3 });
		clock.advance(5);
		sink({ type: "files", done: 3, total: 3 });
		sink({ type: "stage", stage: "creating" });
		expect(sent).toEqual([
			{
				stage: "hq_bringing_in_media",
				message: "Bringing in pictures and sounds",
			},
			{
				stage: "hq_bringing_in_media",
				message: "Bringing in pictures and sounds",
				extra: { done: 1, total: 3 },
			},
			{
				stage: "hq_bringing_in_media",
				message: "Bringing in pictures and sounds",
				extra: { done: 3, total: 3 },
			},
			{ stage: "hq_creating", message: "Creating your app" },
		]);
	});

	it("sends nothing for the done and failed lines", () => {
		const { emitter, sent } = recordingEmitter();
		const sink = readingProgressSink(emitter, testClock().now);
		sink({ type: "done", answer: { kind: "read-again" } });
		sink({ type: "failed" });
		expect(sent).toEqual([]);
	});
});
