/**
 * How project data settles what the reader handed it: a media path with no
 * file, and a read of a table the reader's catalog lacks.
 *
 * It would catch a hand-off settled twice or never, which acceptance's check
 * 1 would word as Nova's mistake.
 */

import { describe, expect, it } from "vitest";
import type { HandOffRecord } from "@/lib/commcare/reader/accounting";
import {
	circumstanceFinding,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import { manifestFinding } from "../findings";
import type { HqMediaPlan, HqMediaReference } from "../media";
import { handOffSettlements } from "../settlements";

const RUNTIME_DRAWS =
	"expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws";
const NOTHING_DRAWS =
	"expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map";

const QUESTION: HqPlace = {
	kind: "question",
	menu: 0,
	form: 0,
	menuName: "Patients",
	formName: "Visit",
	path: "photo",
};
const MENU: HqPlace = { kind: "menu", menu: 0, name: "Patients" };

function reference(path: string, place: HqPlace): HqMediaReference {
	return { path, kind: "image", slot: "form", place };
}

function plan(
	references: readonly HqMediaReference[],
	claims: readonly {
		readonly reference: HqMediaReference;
		readonly entry: string;
	}[] = [],
): HqMediaPlan {
	return {
		files: [],
		findings: [],
		inert: claims.map((claim) => claim.reference),
		claims: claims.map((claim) => ({ ...claim, brokenPicture: false })),
		references,
		runsOn: ["android"],
		contentValid: null,
	};
}

function handOff(
	subject: string,
	to: HandOffRecord["to"] = "media-reference",
	at = subject,
): HandOffRecord {
	return {
		artifact: to === "media-reference" ? "form:0.0" : "app.json",
		where: `/where/${at}`,
		key: `key-${at}`,
		to,
		subject,
	};
}

const NO_FINDINGS: readonly Finding[] = [];

describe("handOffSettlements", () => {
	it("settles a path a claim holds as an inert claim", () => {
		const icon = reference("jr://file/commcare/icon.png", MENU);
		expect(
			handOffSettlements(
				[handOff(icon.path)],
				plan([icon], [{ reference: icon, entry: NOTHING_DRAWS }]),
				NO_FINDINGS,
			),
		).toEqual([
			{
				artifact: "form:0.0",
				where: `/where/${icon.path}`,
				key: `key-${icon.path}`,
				by: "inert-claim",
			},
		]);
	});

	it("settles a path a finding names at the media place, or by name at the reference's own place", () => {
		const photo = reference("jr://file/commcare/photo.jpg", QUESTION);
		const atMedia = circumstanceFinding(
			"media-file-unreadable",
			{ kind: "media", path: photo.path },
			{ name: photo.path },
		);
		const atReference = manifestFinding(RUNTIME_DRAWS, QUESTION, photo.path);
		for (const finding of [atMedia, atReference]) {
			expect(
				handOffSettlements([handOff(photo.path)], plan([photo]), [finding]),
			).toEqual([
				{
					artifact: "form:0.0",
					where: `/where/${photo.path}`,
					key: `key-${photo.path}`,
					by: "finding",
				},
			]);
		}
	});

	it("does not settle a path by a finding at the reference's place that names another path, or at another place", () => {
		const photo = reference("jr://file/commcare/photo.jpg", QUESTION);
		const elsewhere = manifestFinding(RUNTIME_DRAWS, MENU, photo.path);
		const another = manifestFinding(
			RUNTIME_DRAWS,
			QUESTION,
			"jr://file/commcare/other.jpg",
		);
		expect(
			handOffSettlements([handOff(photo.path)], plan([photo]), [
				elsewhere,
				another,
			]),
		).toEqual([]);
	});

	it("settles a table's tag a finding names at the table", () => {
		const finding = circumstanceFinding(
			"table-rows-unreadable",
			{ kind: "lookup-table", tag: "clinics" },
			{ name: "clinics" },
		);
		expect(
			handOffSettlements([handOff("clinics", "lookup-table-read")], plan([]), [
				finding,
			]),
		).toEqual([
			{
				artifact: "app.json",
				where: "/where/clinics",
				key: "key-clinics",
				by: "finding",
			},
		]);
	});

	it("gives a path a claim holds and a finding names one settlement, by the finding", () => {
		const photo = reference("jr://file/commcare/photo.jpg", QUESTION);
		expect(
			handOffSettlements(
				[handOff(photo.path)],
				plan([photo], [{ reference: photo, entry: NOTHING_DRAWS }]),
				[manifestFinding(RUNTIME_DRAWS, QUESTION, photo.path)],
			).map((settlement) => settlement.by),
		).toEqual(["finding"]);
	});

	it("gives a hand-off nothing judged no settlement, and keeps each one's own artifact, where and key", () => {
		const photo = reference("jr://file/commcare/photo.jpg", QUESTION);
		const icon = reference("jr://file/commcare/icon.png", MENU);
		const offs = [
			handOff(photo.path, "media-reference", "first"),
			handOff("unjudged.png"),
			handOff("clinics", "lookup-table-read"),
			handOff(photo.path, "media-reference", "second"),
			handOff(icon.path),
		];
		const settled = handOffSettlements(
			offs,
			plan([photo, icon], [{ reference: icon, entry: NOTHING_DRAWS }]),
			[manifestFinding(RUNTIME_DRAWS, QUESTION, photo.path)],
		);
		expect(settled).toEqual([
			{
				artifact: "form:0.0",
				where: "/where/first",
				key: "key-first",
				by: "finding",
			},
			{
				artifact: "form:0.0",
				where: "/where/second",
				key: "key-second",
				by: "finding",
			},
			{
				artifact: "form:0.0",
				where: `/where/${icon.path}`,
				key: `key-${icon.path}`,
				by: "inert-claim",
			},
		]);
	});
});
