import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `mediaKindMatches` — every referenced asset's MIME kind
 * matches the carrier slot's expected kind.
 *
 * Asserts on the full sentence shape (`toBe(<exact string>)`) per
 * carrier so a regression in `describeLocation` or `kindMismatchMessage`
 * fails the test rather than slipping past a substring match.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "../../../runner";
import { makeAssetRecord, makeManifest } from "./fixtures";

const CODE = "MEDIA_KIND_MISMATCH" as const;

describe("mediaKindMatches", () => {
	it("fires when a field's label.image slot points at an audio asset", () => {
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
									label_media: { image: "audio-asset" },
								}),
							],
						},
					],
				},
			],
		});
		const manifest = makeManifest([
			makeAssetRecord("audio-asset", {
				kind: "audio",
				mimeType: "audio/mpeg",
				extension: ".mp3",
			}),
		]);
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { mediaAssets: manifest }).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toBe(
			`At the label media on field "case_name" in form "Reg", the slot expects an image but the attached asset is audio/mpeg. Replace it with an image file, or clear the slot.`,
		);
		expect(hits[0].details?.expectedKind).toBe("image");
		expect(hits[0].details?.actualMimeType).toBe("audio/mpeg");
		expect(hits[0].details?.actualKind).toBe("audio");
	});

	it("fires when a help.audio slot points at an image asset", () => {
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
									help: "Here's how",
									help_media: { audio: "image-asset" },
								}),
							],
						},
					],
				},
			],
		});
		const manifest = makeManifest([
			makeAssetRecord("image-asset", {
				kind: "image",
				mimeType: "image/png",
				extension: ".png",
			}),
		]);
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { mediaAssets: manifest }).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toBe(
			`At the help-text media on field "case_name" in form "Reg", the slot expects an audio but the attached asset is image/png. Replace it with an audio file, or clear the slot.`,
		);
	});

	it("fires when a field's label.video slot points at an image asset", () => {
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
									label_media: { video: "image-asset" },
								}),
							],
						},
					],
				},
			],
		});
		const manifest = makeManifest([
			makeAssetRecord("image-asset", {
				kind: "image",
				mimeType: "image/png",
				extension: ".png",
			}),
		]);
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { mediaAssets: manifest }).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toBe(
			`At the label media on field "case_name" in form "Reg", the slot expects a video but the attached asset is image/png. Replace it with a video file, or clear the slot.`,
		);
	});

	it("fires when a module.icon carrier points at an audio asset", () => {
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		doc.modules[moduleUuid].icon = "audio-asset";
		const manifest = makeManifest([
			makeAssetRecord("audio-asset", {
				kind: "audio",
				mimeType: "audio/mpeg",
				extension: ".mp3",
			}),
		]);
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { mediaAssets: manifest }).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toBe(
			`At the icon on module "Patients", the slot expects an image but the attached asset is audio/mpeg. Replace it with an image file, or clear the slot.`,
		);
	});

	it("fires when a module.audioLabel carrier points at an image asset", () => {
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		doc.modules[moduleUuid].audioLabel = "image-asset";
		const manifest = makeManifest([
			makeAssetRecord("image-asset", {
				kind: "image",
				mimeType: "image/png",
				extension: ".png",
			}),
		]);
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { mediaAssets: manifest }).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toBe(
			`At the audio label on module "Patients", the slot expects an audio but the attached asset is image/png. Replace it with an audio file, or clear the slot.`,
		);
	});

	it("is silent when every reference's kind matches the slot", () => {
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
									label_media: { image: "good-image" },
									help: "Here's how",
									help_media: { audio: "good-audio" },
								}),
							],
						},
					],
				},
			],
		});
		const manifest = makeManifest([
			makeAssetRecord("good-image", {
				kind: "image",
				mimeType: "image/png",
				extension: ".png",
			}),
			makeAssetRecord("good-audio", {
				kind: "audio",
				mimeType: "audio/mpeg",
				extension: ".mp3",
			}),
		]);
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { mediaAssets: manifest }).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(0);
	});
});
