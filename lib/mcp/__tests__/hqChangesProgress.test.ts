/**
 * The progress an MCP client reads while a review or a bring-in of changes
 * made in CommCare HQ moves: one notification a stage, tagged apart from a
 * bring-in of an app's stages of the same name and worded as the panel names
 * the stage, and file counts no faster than one a second with the last one
 * always sent.
 *
 * It would catch: a client that can't tell "reading the app" of a review
 * from that of a bring-in of an app; a flood of counts on an app with many
 * files; a count that ends short of its total.
 */

import { describe, expect, it } from "vitest";
import { HQ_CHANGES_STAGE_LABELS } from "@/lib/publish/hqChangesCopy";
import { HQ_CHANGES_STAGES } from "@/lib/publish/hqChangesKinds";
import {
	hqChangesProgressSink,
	type ProgressEmitter,
	type ProgressStage,
} from "../progress";

interface Sent {
	readonly stage: ProgressStage;
	readonly message: string;
	readonly extra?: Record<string, unknown>;
}

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

function testClock(): { now: () => number; advance: (ms: number) => void } {
	let at = 0;
	return {
		now: () => at,
		advance: (ms) => {
			at += ms;
		},
	};
}

describe("hqChangesProgressSink", () => {
	it("sends one notification per stage, under its hq_changes_ tag, with the panel's label", () => {
		const { emitter, sent } = recordingEmitter();
		const sink = hqChangesProgressSink(emitter, testClock().now);
		for (const stage of HQ_CHANGES_STAGES) sink({ type: "stage", stage });
		expect(sent).toEqual([
			{
				stage: "hq_changes_reading_app",
				message: HQ_CHANGES_STAGE_LABELS["reading-app"],
			},
			{
				stage: "hq_changes_reading_project_data",
				message: HQ_CHANGES_STAGE_LABELS["reading-project-data"],
			},
			{
				stage: "hq_changes_checking",
				message: HQ_CHANGES_STAGE_LABELS.checking,
			},
			{
				stage: "hq_changes_checking_media",
				message: HQ_CHANGES_STAGE_LABELS["checking-media"](null),
			},
			{
				stage: "hq_changes_adding_media",
				message: HQ_CHANGES_STAGE_LABELS["adding-media"],
			},
			{
				stage: "hq_changes_bringing_in",
				message: HQ_CHANGES_STAGE_LABELS["bringing-in"],
			},
		]);
	});

	it("sends a file count at most once a second, under the stage last named, and always the last", () => {
		const { emitter, sent } = recordingEmitter();
		const clock = testClock();
		const sink = hqChangesProgressSink(emitter, clock.now);
		/* A count before any stage has no tag to go under. */
		sink({ type: "files", done: 0, total: 4 });
		sink({ type: "stage", stage: "checking-media" });
		sink({ type: "files", done: 1, total: 4 });
		clock.advance(400);
		sink({ type: "files", done: 2, total: 4 });
		clock.advance(600);
		sink({ type: "files", done: 3, total: 4 });
		clock.advance(5);
		sink({ type: "files", done: 4, total: 4 });
		const label = HQ_CHANGES_STAGE_LABELS["checking-media"](null);
		expect(sent).toEqual([
			{ stage: "hq_changes_checking_media", message: label },
			...[1, 3, 4].map((done) => ({
				stage: "hq_changes_checking_media",
				message: label,
				extra: { done, total: 4 },
			})),
		]);
	});
});
