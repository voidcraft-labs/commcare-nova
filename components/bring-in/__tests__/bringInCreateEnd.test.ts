/**
 * What the end of a create's request does to the tab's key, the model and
 * the landing, mounted and not.
 *
 * It would catch: a create that ended without creating after the person left
 * the flow, leaving its key, so the next Read this app sends that create
 * again unasked; a key kept after a final answer on screen; a lost request's
 * key removed while its screen still sends it again, or kept after the person
 * went Back from it; and an answer drawn or landed after the flow has gone.
 */

import { describe, expect, it } from "vitest";
import type { BringInStreamEnd } from "@/components/bring-in/bringInClient";
import type { BringInEvent } from "@/components/bring-in/bringInModel";
import type { AdoptedAppReceipt, CreateAnswer } from "@/lib/deployment";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import { endCreate } from "../bringInCreateEnd";

const RECEIPT = { appId: "app-1" } as unknown as AdoptedAppReceipt;
const HELD = circumstanceFinding("rate-limited", { kind: "app" }, {});

/** Every end a create's request can have, by name. */
const ENDS = {
	created: { kind: "done", answer: { kind: "created", receipt: RECEIPT } },
	held: { kind: "done", answer: { kind: "held", finding: HELD } },
	"read-again": { kind: "done", answer: { kind: "read-again" } },
	refusedAnswer: {
		kind: "done",
		answer: { kind: "refused", refusal: "name_missing" },
	},
	failed: { kind: "failed" },
	refused: { kind: "refused", refusal: "app_unavailable" },
	"signed-out": { kind: "signed-out" },
	lost: { kind: "lost" },
} as const satisfies Record<string, BringInStreamEnd<CreateAnswer>>;

function ending(
	end: BringInStreamEnd<CreateAnswer>,
	mounted: boolean,
	onScreen = mounted,
) {
	const seen = {
		forgot: 0,
		landed: [] as AdoptedAppReceipt[],
		events: [] as BringInEvent[],
	};
	endCreate(end, {
		mounted,
		onScreen,
		now: 5000,
		forgetCreate: () => {
			seen.forgot += 1;
		},
		land: (receipt) => {
			seen.landed.push(receipt);
		},
		dispatch: (event) => {
			seen.events.push(event);
		},
	});
	return seen;
}

describe("endCreate, once the flow has unmounted", () => {
	for (const [name, end] of Object.entries(ENDS)) {
		it(`removes the key on ${name}, and draws and lands nothing`, () => {
			expect(ending(end, false)).toEqual({ forgot: 1, landed: [], events: [] });
		});
	}
});

describe("endCreate, mounted", () => {
	it("lands a created app, then removes the key", () => {
		expect(ending(ENDS.created, true)).toEqual({
			forgot: 1,
			landed: [RECEIPT],
			events: [],
		});
	});

	it("removes the key on every answer that did not create, and hands it to the model", () => {
		for (const end of [ENDS.held, ENDS["read-again"], ENDS.refusedAnswer]) {
			expect(ending(end, true)).toEqual({
				forgot: 1,
				landed: [],
				events: [{ type: "create-done", answer: end.answer, at: 5000 }],
			});
		}
	});

	it("removes the key on a failed line, a refusal and an ended session", () => {
		expect(ending(ENDS.failed, true).events).toEqual([
			{ type: "failed", call: "create" },
		]);
		expect(ending(ENDS.refused, true).events).toEqual([
			{ type: "refused", call: "create", refusal: "app_unavailable" },
		]);
		expect(ending(ENDS["signed-out"], true).events).toEqual([
			{ type: "signed-out" },
		]);
		for (const end of [ENDS.failed, ENDS.refused, ENDS["signed-out"]]) {
			expect(ending(end, true).forgot).toBe(1);
		}
	});

	it("keeps the key for a lost request, whose screen sends the create again", () => {
		expect(ending(ENDS.lost, true)).toEqual({
			forgot: 0,
			landed: [],
			events: [{ type: "lost", call: "create" }],
		});
	});

	it("removes the key for a lost request the person went Back from, which no screen sends again", () => {
		expect(ending(ENDS.lost, true, false)).toEqual({
			forgot: 1,
			landed: [],
			events: [{ type: "lost", call: "create" }],
		});
	});
});
