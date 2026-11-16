/**
 * What the bring-in hook does when a create's request ends: the tab's key
 * first, then the model and the landing.
 *
 * The key (`nova:bring-in-create`) is there so a reload of the creating
 * screen sends the create again, and a reload never reaches this code: the
 * page that sent the request is gone. So the key is settled here whether or
 * not the flow is still mounted. Every final answer removes it, and once the
 * flow has unmounted every end does: that flow will not send the create
 * again, and the next press of Read this app reads the app and creates
 * nothing. Only a lost request whose creating screen still stands keeps the
 * key, since that screen sends the create again itself. A lost create the
 * person left by going Back, with the flow still mounted, has no screen to
 * send it again, so its key goes too.
 *
 * "Removes" always means `forgetCreate`, which removes the key only where
 * this flow still holds it (`bringInCreateKey.ts`): a flow mounted again
 * over the same create has taken the key over, and the first flow's end
 * leaves it to that one.
 *
 * The model and the landing need the flow: after it has unmounted they are
 * dropped.
 */

import type { BringInStreamEnd } from "@/components/bring-in/bringInClient";
import type { BringInEvent } from "@/components/bring-in/bringInModel";
import type { AdoptedAppReceipt, CreateAnswer } from "@/lib/deployment";

export interface CreateEndPorts {
	/** Whether the flow that sent the create is still mounted. */
	readonly mounted: boolean;
	/**
	 * Whether the create's own creating screen still stands: the model holds it
	 * as the create on screen (`pendingCreate`), so a lost request is sent
	 * again from there.
	 */
	readonly onScreen: boolean;
	/** When the end arrived. */
	readonly now: number;
	/** Removes the tab's key where this flow still holds it. */
	readonly forgetCreate: () => void;
	/** Lands a created app's receipt. */
	readonly land: (receipt: AdoptedAppReceipt) => void;
	readonly dispatch: (event: BringInEvent) => void;
}

export function endCreate(
	end: BringInStreamEnd<CreateAnswer>,
	ports: CreateEndPorts,
): void {
	if (!ports.mounted) {
		ports.forgetCreate();
		return;
	}
	switch (end.kind) {
		case "done":
			if (end.answer.kind === "created") {
				ports.land(end.answer.receipt);
				ports.forgetCreate();
				return;
			}
			ports.forgetCreate();
			ports.dispatch({
				type: "create-done",
				answer: end.answer,
				at: ports.now,
			});
			return;
		case "failed":
			ports.forgetCreate();
			ports.dispatch({ type: "failed", call: "create" });
			return;
		case "refused":
			ports.forgetCreate();
			ports.dispatch({ type: "refused", call: "create", refusal: end.refusal });
			return;
		case "signed-out":
			ports.forgetCreate();
			ports.dispatch({ type: "signed-out" });
			return;
		case "lost":
			/* The key stays only where the create is still the one on screen. */
			if (!ports.onScreen) ports.forgetCreate();
			ports.dispatch({ type: "lost", call: "create" });
			return;
	}
}
