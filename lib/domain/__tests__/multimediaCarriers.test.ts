/**
 * Carrier-shape coverage for the multimedia slots added to field /
 * option / module / form / blueprint schemas. Confirms:
 *
 *   - Docs without any media slots still parse (additive change).
 *   - Each new optional slot round-trips when populated.
 *   - The kind-discriminator narrowing still picks the right per-
 *     kind shape after the extension.
 */

import { describe, expect, it } from "vitest";
import {
	blueprintDocSchema,
	fieldSchema,
	formSchema,
	moduleSchema,
	selectOptionSchema,
} from "@/lib/domain";

const NEUTRAL_MEDIA = {
	image: "media-asset-1",
	audio: "media-asset-2",
};

describe("field schema — media slots", () => {
	it("text field parses with label_media + hint_media", () => {
		const parsed = fieldSchema.parse({
			kind: "text",
			uuid: "field-uuid-1",
			id: "patient_name",
			label: "Patient name",
			label_media: { image: "media-asset-1" },
			hint_media: { audio: "media-asset-2" },
		});
		expect(parsed.kind).toBe("text");
		if (parsed.kind === "text") {
			expect(parsed.label_media).toEqual({ image: "media-asset-1" });
			expect(parsed.hint_media).toEqual({ audio: "media-asset-2" });
		}
	});

	it("text field parses with the new help + required_msg text slots", () => {
		const parsed = fieldSchema.parse({
			kind: "text",
			uuid: "field-uuid-1",
			id: "patient_name",
			label: "Patient name",
			help: "Enter the legal name shown on their ID document.",
			help_media: { image: "media-asset-1" },
			required: "true()",
			required_msg: "We can't proceed without a name.",
			required_msg_media: { audio: "media-asset-3" },
		});
		expect(parsed.kind).toBe("text");
		if (parsed.kind === "text") {
			expect(parsed.help).toBe(
				"Enter the legal name shown on their ID document.",
			);
			expect(parsed.required_msg).toBe("We can't proceed without a name.");
			expect(parsed.required_msg_media?.audio).toBe("media-asset-3");
		}
	});

	it("text field still parses without ANY media slots (additive change)", () => {
		const parsed = fieldSchema.parse({
			kind: "text",
			uuid: "field-uuid-1",
			id: "name",
			label: "Name",
		});
		expect(parsed.kind).toBe("text");
		if (parsed.kind === "text") {
			expect(parsed.label_media).toBeUndefined();
			expect(parsed.hint_media).toBeUndefined();
			expect(parsed.help).toBeUndefined();
			expect(parsed.required_msg).toBeUndefined();
		}
	});

	it("group container parses with optional label_media", () => {
		const parsed = fieldSchema.parse({
			kind: "group",
			uuid: "field-uuid-grp",
			id: "screening",
			label: "Screening section",
			label_media: { image: "media-asset-1" },
		});
		expect(parsed.kind).toBe("group");
	});

	it("validate_msg_media parses alongside existing validate_msg", () => {
		const parsed = fieldSchema.parse({
			kind: "int",
			uuid: "field-uuid-int",
			id: "age",
			label: "Age",
			validate: ". >= 0 and . <= 120",
			validate_msg: "Enter a realistic age (0–120).",
			validate_msg_media: { audio: "media-asset-9" },
		});
		expect(parsed.kind).toBe("int");
		if (parsed.kind === "int") {
			expect(parsed.validate_msg_media?.audio).toBe("media-asset-9");
		}
	});
});

describe("selectOption schema — media slot", () => {
	it("round-trips an option with attached image+audio", () => {
		const parsed = selectOptionSchema.parse({
			value: "fever",
			label: "Fever",
			media: NEUTRAL_MEDIA,
		});
		expect(parsed.media).toEqual(NEUTRAL_MEDIA);
	});

	it("rejects unknown extra keys (strict)", () => {
		expect(() =>
			selectOptionSchema.parse({
				value: "fever",
				label: "Fever",
				icon: "media-asset-1",
			}),
		).toThrow();
	});
});

describe("module schema — icon + audioLabel", () => {
	it("module parses with icon + audioLabel", () => {
		const parsed = moduleSchema.parse({
			uuid: "module-uuid",
			id: "patient_registration",
			name: "Patient registration",
			icon: "media-asset-1",
			audioLabel: "media-asset-2",
		});
		expect(parsed.icon).toBe("media-asset-1");
		expect(parsed.audioLabel).toBe("media-asset-2");
	});

	it("module still parses without icon/audioLabel (additive)", () => {
		const parsed = moduleSchema.parse({
			uuid: "module-uuid",
			id: "patient_registration",
			name: "Patient registration",
		});
		expect(parsed.icon).toBeUndefined();
	});

	it("caseListConfig parses with icon + audioLabel", () => {
		const parsed = moduleSchema.parse({
			uuid: "module-uuid",
			id: "patient_registration",
			name: "Patient registration",
			caseListConfig: {
				columns: [],
				searchInputs: [],
				icon: "media-asset-3",
				audioLabel: "media-asset-4",
			},
		});
		expect(parsed.caseListConfig?.icon).toBe("media-asset-3");
		expect(parsed.caseListConfig?.audioLabel).toBe("media-asset-4");
	});
});

describe("form schema — icon + audioLabel", () => {
	it("form parses with icon + audioLabel", () => {
		const parsed = formSchema.parse({
			uuid: "form-uuid",
			id: "intake",
			name: "Intake",
			type: "registration",
			icon: "media-asset-1",
			audioLabel: "media-asset-2",
		});
		expect(parsed.icon).toBe("media-asset-1");
		expect(parsed.audioLabel).toBe("media-asset-2");
	});
});

describe("blueprint schema — logo", () => {
	it("blueprint parses with the web-apps logo set", () => {
		const parsed = blueprintDocSchema.parse({
			appId: "app-1",
			appName: "Test app",
			connectType: null,
			caseTypes: null,
			modules: {},
			forms: {},
			fields: {},
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
			logo: "media-asset-logo",
		});
		expect(parsed.logo).toBe("media-asset-logo");
	});

	it("blueprint still parses without a logo (additive)", () => {
		const parsed = blueprintDocSchema.parse({
			appId: "app-1",
			appName: "Test app",
			connectType: null,
			caseTypes: null,
			modules: {},
			forms: {},
			fields: {},
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
		});
		expect(parsed.logo).toBeUndefined();
	});
});
