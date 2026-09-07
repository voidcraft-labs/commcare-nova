import { describe, expect, it } from "vitest";
import {
	acceptedValuesFromDraft,
	decideDraftCommit,
	firstDraftRefusal,
	PEER_CHANGE_MESSAGE,
} from "../draftCommitModel";

const normalize = (value: string) => value.trim();
const base = {
	draft: " Area ",
	baseValue: "Region",
	currentValue: "Region",
	disabled: false,
	normalize,
};
describe("actual setup draft commit decision", () => {
	it("keeps a peer change authoritative even when the draft becomes locally valid", () => {
		expect(decideDraftCommit({ ...base, currentValue: "District" })).toEqual({
			kind: "refused",
			message: PEER_CHANGE_MESSAGE,
		});
		expect(
			decideDraftCommit({
				...base,
				baseValue: "District",
				currentValue: "District",
			}),
		).toEqual({ kind: "commit", value: "Area" });
	});
	it("normalizes before local validation and submits only complete values", () => {
		const validate = (value: string) =>
			value === "" ? "A name is needed" : undefined;
		expect(decideDraftCommit({ ...base, draft: "  ", validate })).toEqual({
			kind: "refused",
			message: "A name is needed",
		});
		expect(decideDraftCommit({ ...base, validate })).toEqual({
			kind: "commit",
			value: "Area",
		});
	});
	it("does not write a normalized no-op or a disabled edit", () => {
		expect(decideDraftCommit({ ...base, draft: " Region " })).toEqual({
			kind: "unchanged",
			value: "Region",
		});
		expect(decideDraftCommit({ ...base, disabled: true })).toEqual({
			kind: "ignored",
		});
		expect(
			decideDraftCommit({ ...base, draft: "Region", skipPristine: true }),
		).toEqual({ kind: "ignored" });
	});
	it("normalizes accepted values without changing order or silently deduplicating authored tokens", () => {
		expect(acceptedValuesFromDraft(" north\n\n south \nnorth\r\n")).toEqual([
			"north",
			"south",
			"north",
		]);
		expect(acceptedValuesFromDraft(" \n ")).toEqual([]);
		expect(
			decideDraftCommit({
				...base,
				draft: " north \n south \n",
				baseValue: "north\nsouth",
				currentValue: "north\nsouth",
				normalize: (value) => acceptedValuesFromDraft(value).join("\n"),
			}),
		).toEqual({ kind: "unchanged", value: "north\nsouth" });
	});
	it("projects the first actual refusal and has a message for an empty refusal list", () => {
		expect(firstDraftRefusal({ ok: true })).toBeUndefined();
		expect(firstDraftRefusal({ ok: false, messages: ["One", "Two"] })).toBe(
			"One",
		);
		expect(firstDraftRefusal({ ok: false, messages: [] })).toBe(
			"That change could not be applied.",
		);
	});
});
