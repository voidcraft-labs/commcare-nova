// The refusal backstop around a running screen decides what a render-time
// read the device refuses shows: the screen's refusal panel, with the
// screen's own next step, never an error that reaches the canvas boundary.
// The form screen sits under it too, so a read FormScreen makes as it renders
// shows the form's panel with Back, as a phone stops on the form. The shell's
// wiring (each screen inside its scope, the form's Back, a retry when the mode
// changes) is witnessed in the browser by preview-refusal-backstop.spec.ts.

import { describe, expect, it } from "vitest";
import { boundaryRefusalPanel } from "@/components/preview/shared/PreviewDataRefusal";
import type { LookupTableId, Uuid } from "@/lib/domain";
import {
	PreviewDataRefusal,
	WORKER_INFORMATION_REFUSAL,
} from "@/lib/preview/engine/dataRefusal";
import { XPathInvalidPathError } from "@/lib/preview/xpath/runtimeValues";

const moduleUuid = "0b8f2c39-0f56-4c43-9d34-0b5b8a6f8c11" as Uuid;
const back = { label: "Back", onClick: () => {} };

describe("the refusal backstop's panel", () => {
	it("shows a form's refusal as the form's, with its Back", () => {
		expect(
			boundaryRefusalPanel(new PreviewDataRefusal(WORKER_INFORMATION_REFUSAL), {
				surface: "form",
				moduleUuid,
				action: back,
				previewing: true,
			}),
		).toEqual({
			surface: "form",
			reason: WORKER_INFORMATION_REFUSAL,
			moduleUuid,
			action: back,
		});
	});

	it("reads Core's refused path on the form screen as the form's refusal", () => {
		const panel = boundaryRefusalPanel(
			new XPathInvalidPathError("commcaresession"),
			{ surface: "form", action: back, previewing: true },
		);
		expect(panel).toEqual({
			surface: "form",
			reason: { kind: "empty-instance", instanceId: "commcaresession" },
			action: back,
		});
	});

	it("names the links when the refusal came after the form was saved", () => {
		expect(
			boundaryRefusalPanel(
				new PreviewDataRefusal(WORKER_INFORMATION_REFUSAL, "links"),
				{ surface: "form", action: back, previewing: true },
			)?.surface,
		).toBe("links");
	});

	it("shows a refused choice list as its Search screen's on any screen", () => {
		const reason = {
			kind: "empty-choice-table",
			tableId: "regions" as LookupTableId,
		} as const;
		for (const surface of ["form", "menu"] as const)
			expect(
				boundaryRefusalPanel(new PreviewDataRefusal(reason), {
					surface,
					previewing: true,
				})?.surface,
			).toBe("search");
	});

	it("keeps a menu's refusal the menu's, with no step the menu did not give", () => {
		expect(
			boundaryRefusalPanel(new PreviewDataRefusal(WORKER_INFORMATION_REFUSAL), {
				surface: "menu",
				previewing: true,
			}),
		).toEqual({ surface: "menu", reason: WORKER_INFORMATION_REFUSAL });
	});

	it("passes every other error on, for the canvas boundary to report", () => {
		expect(
			boundaryRefusalPanel(new Error("a fault"), {
				surface: "form",
				action: back,
				previewing: true,
			}),
		).toBeUndefined();
		expect(
			boundaryRefusalPanel(new XPathInvalidPathError(null), {
				surface: "form",
				previewing: true,
			}),
		).toBeUndefined();
	});

	it("shows no phone's stop on the authoring canvas, which reads no worker's data", () => {
		for (const surface of ["form", "menu"] as const)
			expect(
				boundaryRefusalPanel(
					new PreviewDataRefusal(WORKER_INFORMATION_REFUSAL),
					{ surface, action: back, previewing: false },
				),
			).toBeUndefined();
	});
});
