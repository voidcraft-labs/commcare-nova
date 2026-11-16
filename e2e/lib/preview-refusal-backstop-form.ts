// The form screen of `preview-refusal-backstop.spec.ts`'s peer, in place of
// FormScreen: while Preview runs the app it throws, as it renders, the
// refusal the page's `?refusal=` names (read by the client before the
// builder URL replaces it), which no screen holds as its own
// state. Its only subject is what the shell around it does with that throw.
// On the authoring canvas it reads nothing and renders a plain marker.

import { createElement } from "react";
import {
	PreviewDataRefusal,
	WORKER_INFORMATION_REFUSAL,
} from "@/lib/preview/engine/dataRefusal";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { XPathInvalidPathError } from "@/lib/preview/xpath/runtimeValues";
import { useEditMode } from "@/lib/session/hooks";
import type {} from "./preview-refusal-backstop-client";

function renderTimeRefusal(): Error {
	const { refusal } = window.refusalBackstop;
	switch (refusal) {
		case "form":
			return new PreviewDataRefusal(WORKER_INFORMATION_REFUSAL);
		case "links":
			return new PreviewDataRefusal(WORKER_INFORMATION_REFUSAL, "links");
		case "core-path":
			/* Core's own refusal of a path below the empty session. */
			return new XPathInvalidPathError("commcaresession");
		default:
			throw new Error(`No render-time refusal named ${String(refusal)}.`);
	}
}

export function FormScreen({
	screen,
}: {
	readonly screen: Extract<PreviewScreen, { type: "form" }>;
}) {
	const mode = useEditMode();
	if (mode === "preview") throw renderTimeRefusal();
	/* `createElement`, not JSX: esbuild compiles an aliased module outside the
	 * project's JSX setting, so JSX here would need a `React` in scope. */
	return createElement(
		"p",
		{ "data-authoring-form": screen.formUuid },
		"Authoring the form",
	);
}
