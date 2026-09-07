import { describe, expect, it } from "vitest";
import {
	mediaIds,
	mediaRecords,
	mediaWireFixture,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { runValidation } from "../../../runner";

/** Shared domain admission and media manifest gates; no persistence claims. */
describe("media reference admission across carriers", () => {
	for (const state of ["missing", "pending", "wrong kind"] as const)
		it(`reports every ${state} reference at its actual authoring location`, () => {
			const { doc, assets } = mediaWireFixture();
			const records = mediaRecords(assets);
			const moduleUuid = doc.moduleOrder[0],
				formUuid = doc.formOrder[moduleUuid][0];
			const expected = [
				["app", "logo", "", "", "icon", "image"],
				["module", "icon", "", "", "icon", "image"],
				["module", "audioLabel", "", "", "audio", "audio"],
				["form", "icon", "", "", "alias", "image"],
				["form", "audioLabel", "", "", "audio", "audio"],
				["field", "label_media", "answer", "", "label", "image"],
				["field", "label_media", "answer", "", "audio", "audio"],
				["field", "label_media", "answer", "", "video", "video"],
				["field", "hint_media", "answer", "", "option", "image"],
				["field", "help_media", "answer", "", "audio", "audio"],
				["field", "validate_msg_media", "answer", "", "icon", "image"],
				["field", "options", "choice", "", "option", "image"],
				["field", "options", "choice", "", "audio", "audio"],
				["field", "options", "choice", "", "video", "video"],
				["module", "", "", "0", "label", "image"],
				["module", "", "", "1", "option", "image"],
				["module", "", "", "2", "icon", "image"],
			] as const;
			expect(
				runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
					mediaAssets: records,
				}),
			).toEqual([]);
			for (const [id, record] of records) {
				if (state === "missing") records.delete(id);
				else if (state === "pending")
					records.set(id, { ...record, status: "pending" });
				else {
					// Model a stale resolved record at the read boundary; both replacement
					// records come from real typed assets, retaining only the referenced ID.
					const replacement = assets.get(
						record.kind === "image" ? mediaIds.audio : mediaIds.label,
					);
					if (!replacement) throw new Error("Missing replacement asset");
					const resolved = mediaRecords(
						new Map([[replacement.assetId, replacement]]),
					).get(replacement.assetId);
					if (!resolved) throw new Error("Missing replacement record");
					records.set(id, { ...resolved, id: record.id });
				}
			}
			const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
				mediaAssets: records,
			});
			const code =
				state === "missing"
					? "MEDIA_ASSET_NOT_FOUND"
					: state === "pending"
						? "MEDIA_ASSET_NOT_READY"
						: "MEDIA_KIND_MISMATCH";
			expect(findings.map((finding) => finding.code)).toEqual(
				Array(17).fill(code),
			);
			const column = doc.modules[moduleUuid].caseListConfig?.columns[1];
			if (!column) throw new Error("Missing image-map column");
			for (const finding of findings) {
				if (finding.scope !== "app")
					expect(finding.location.moduleUuid).toBe(moduleUuid);
				if (finding.scope === "form" || finding.scope === "field")
					expect(finding.location.formUuid).toBe(formUuid);
				if (finding.details?.rowIndex !== undefined)
					expect(finding.details.columnUuid).toBe(column.uuid);
				if (state === "pending")
					expect(finding.details?.status).toBe("pending");
			}
			const actual = findings.map((finding) => [
				finding.scope,
				finding.location.field ?? "",
				finding.location.fieldId ?? "",
				finding.details?.rowIndex ?? "",
				finding.details?.assetId,
				...(state === "wrong kind" ? [finding.details?.expectedKind] : []),
			]);
			const wanted = expected.map(([scope, field, fieldId, row, key, kind]) => [
				scope,
				field,
				fieldId,
				row,
				mediaIds[key],
				...(state === "wrong kind" ? [kind] : []),
			]);
			expect(actual.map((value) => JSON.stringify(value)).sort()).toEqual(
				wanted.map((value) => JSON.stringify(value)).sort(),
			);
		});
	it("skips external media admission only when no manifest was supplied", () => {
		const { doc } = mediaWireFixture();
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
				mediaAssets: new Map(),
			}),
		).toHaveLength(17);
	});
});
