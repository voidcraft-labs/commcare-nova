/**
 * The forms CommCare HQ served for the retained apps, read by the whole
 * reader, every stage: an app HQ built itself, a Nova export, a Nova export
 * with an inline search, and the Nova export after each of HQ's own pages
 * saved it. Whatever HQ's own pages and form builder write in a form is
 * claimed: no element or attribute of those sources is `unrecognized` at a
 * form or a question. The reading has no lookup table and a media index that
 * answers every path with a file, so nothing the source holds is handed off
 * for want of project data. Every node of a Nova export named like one of
 * Nova's takes a generated, candidate or case region role, never a field's.
 *
 * Plausible failures: a shadow, a hashtag block, a case mapping or a Connect
 * node HQ's builder writes left unclaimed; an attribute one of HQ's pages
 * adds left to the close; one of Nova's own generated nodes read as a
 * question.
 */

import { describe, expect, it } from "vitest";
import { inventoryIndex } from "../../../surface/inventory";
import {
	readerInput,
	retainedSaveReads,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { createReadContext } from "../../context";
import { STAGES } from "../../index";
import type { ReaderMediaResolution } from "../../types";

const SAVES = retainedSaveReads();

const APPS = [
	"hq-built/app-source",
	"navigation-base/app-source",
	"case-list-inline/app-source",
	...SAVES,
];

/** Every path has a file, of the kind its extension names. */
function everyPathAnAsset(path: string): ReaderMediaResolution {
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const mediaKind =
		extension === "mp3" || extension === "wav"
			? "audio"
			: extension === "mp4" || extension === "3gp"
				? "video"
				: "image";
	return { kind: "asset", assetId: `asset-${path}`, mediaKind };
}

describe.each(APPS)("the forms of %s", (app) => {
	it("leave nothing of a form or a question unclaimed", async () => {
		const input = readerInput(await sourceFromBody(retainedSourceBody(app)), {
			media: everyPathAnAsset,
		});
		const ctx = createReadContext(
			{
				...input,
				recordDialect: () => undefined,
				appStrings: () => ({ languages: {}, units: {} }),
			},
			{ claims: "counts" },
			inventoryIndex(),
		);
		for (const stage of STAGES) stage(ctx);
		const forms = ctx.draft.modules.flatMap((module) => module.forms);
		expect(forms.length).toBeGreaterThan(0);
		for (const form of forms) {
			const xform = form.xform;
			if (xform === null) continue;
			for (const [path, node] of xform.nodes) {
				if (!node.name.startsWith("nova_")) continue;
				expect([path, xform.roles.get(node)?.kind]).not.toEqual([
					path,
					"field",
				]);
			}
		}
		const atForms = ctx
			.close()
			.findings.filter(
				(finding) =>
					finding.place.kind === "form" || finding.place.kind === "question",
			);
		expect(
			atForms
				.filter(
					(finding) =>
						finding.code === "unrecognized" ||
						finding.code === "shadow-disagrees",
				)
				.map((finding) => [
					finding.code,
					finding.place.kind === "question" ? finding.place.path : "form",
					finding.detail.name,
				]),
		).toEqual([]);
	});
});
