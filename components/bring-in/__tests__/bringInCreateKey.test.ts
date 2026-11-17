/**
 * Whose the tab's create key is, across two flows mounted over one create.
 *
 * The journey: Bring it in for an app (flow 1 writes the key and posts the
 * create), Go to your apps while it runs (flow 1 unmounts, its request still
 * open), Back to the app's address (flow 2 mounts, resumes the key and joins
 * the create), then flow 1's request ends. These tests drive the same
 * functions the hook composes (`rememberCreate`, `resumableCreate`,
 * `adoptCreate`, `endCreate` with `forgetCreate`) over one in-memory key.
 *
 * It would catch: the first flow's end removing the key from under the
 * creating screen the second flow stands on, so a reload there reads the app
 * and shows the stop for the app just made or a second review; a flow that
 * cannot remove its own key after resuming it; and a resume that restarts
 * the window a create is sent again in.
 */

import { describe, expect, it } from "vitest";
import type { BringInStreamEnd } from "@/components/bring-in/bringInClient";
import {
	BRING_IN_RESUME_WINDOW_MS,
	resumableCreate,
} from "@/components/bring-in/bringInModel";
import type { AdoptedAppReceipt, CreateAnswer } from "@/lib/deployment";
import { endCreate } from "../bringInCreateEnd";
import {
	adoptCreate,
	type CreateKeyStore,
	forgetCreate,
	rememberCreate,
} from "../bringInCreateKey";
import { inputFor, KEY } from "./bringInFixtures";

const ASKED_AT = 1_800_000_000_000;
const RECEIPT = { appId: "app-1" } as unknown as AdoptedAppReceipt;

/** Every end a create's request can have. */
const ENDS: readonly BringInStreamEnd<CreateAnswer>[] = [
	{ kind: "done", answer: { kind: "created", receipt: RECEIPT } },
	{ kind: "done", answer: { kind: "read-again" } },
	{ kind: "failed" },
	{ kind: "refused", refusal: "app_unavailable" },
	{ kind: "signed-out" },
	{ kind: "lost" },
];

function memoryKey(): CreateKeyStore & { value: string | null } {
	const key = {
		value: null as string | null,
		read: () => key.value,
		write: (value: string) => {
			key.value = value;
		},
		remove: () => {
			key.value = null;
		},
	};
	return key;
}

/** One flow's end of its create, as `useBringIn.ts::startCreate` hands it over. */
function end(
	key: CreateKeyStore,
	flow: string,
	how: BringInStreamEnd<CreateAnswer>,
	state: { mounted: boolean; onScreen: boolean },
): void {
	endCreate(how, {
		...state,
		now: ASKED_AT + 2000,
		forgetCreate: () => forgetCreate(key, flow),
		land: () => {},
		dispatch: () => {},
	});
}

/** Flow 1 asks; flow 2 mounts over the same address and resumes it. */
function remounted() {
	const key = memoryKey();
	rememberCreate(key, "flow-1", inputFor(), ASKED_AT);
	const resumed = resumableCreate(key.read(), KEY, ASKED_AT + 1000);
	expect(resumed).toEqual(inputFor());
	adoptCreate(key, "flow-2");
	return key;
}

describe("the tab's create key, with a flow mounted again over the same create", () => {
	for (const how of ENDS) {
		const name = how.kind === "done" ? how.answer.kind : how.kind;
		it(`stays for the second flow when the unmounted first flow's request ends ${name}`, () => {
			const key = remounted();
			end(key, "flow-1", how, { mounted: false, onScreen: false });
			/* A reload of the second flow's creating screen sends the create again. */
			expect(resumableCreate(key.read(), KEY, ASKED_AT + 3000)).toEqual(
				inputFor(),
			);
		});
	}

	it("is removed by the second flow's own final answer", () => {
		const key = remounted();
		end(key, "flow-1", { kind: "lost" }, { mounted: false, onScreen: false });
		end(
			key,
			"flow-2",
			{ kind: "done", answer: { kind: "created", receipt: RECEIPT } },
			{ mounted: true, onScreen: true },
		);
		expect(key.value).toBeNull();
	});

	it("is removed by the second flow's end once that flow has unmounted too", () => {
		const key = remounted();
		end(key, "flow-2", { kind: "failed" }, { mounted: false, onScreen: false });
		expect(key.value).toBeNull();
	});

	it("keeps the time the person asked, so going Back and forth never stretches the window", () => {
		const key = remounted();
		const late = ASKED_AT + BRING_IN_RESUME_WINDOW_MS;
		expect(resumableCreate(key.read(), KEY, late)).toBeNull();
	});
});

describe("the tab's create key, with one flow", () => {
	it("is removed by that flow's end, mounted or not", () => {
		for (const mounted of [true, false]) {
			const key = memoryKey();
			rememberCreate(key, "flow-1", inputFor(), ASKED_AT);
			end(key, "flow-1", { kind: "failed" }, { mounted, onScreen: mounted });
			expect(key.value).toBeNull();
		}
	});

	it("is still that flow's after it resumes its own key, so its end removes it", () => {
		const key = memoryKey();
		rememberCreate(key, "flow-1", inputFor(), ASKED_AT);
		adoptCreate(key, "flow-1");
		end(key, "flow-1", { kind: "lost" }, { mounted: true, onScreen: false });
		expect(key.value).toBeNull();
	});

	it("leaves text it cannot read to the next resume, which removes it", () => {
		const key = memoryKey();
		key.write("{not json");
		forgetCreate(key, "flow-1");
		adoptCreate(key, "flow-1");
		expect(key.value).toBe("{not json");
	});
});
