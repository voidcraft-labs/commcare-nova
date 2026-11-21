/** The manifest's answer for one stored key of one HQ model. Pure, over the generated surface. */
import { expect, it } from "vitest";
import {
	schemaPropertyDefault,
	servedSchemaPropertyDefault,
} from "../schemaDefaults";

it("answers a declared property with its default", () => {
	expect(schemaPropertyDefault("Application", "auto_gps_capture")).toEqual({
		known: true,
		default: false,
		isMap: false,
	});
	expect(schemaPropertyDefault("Detail", "display")).toEqual({
		known: true,
		default: null,
		isMap: false,
	});
});

it("answers a map property as one whose every key is content", () => {
	expect(schemaPropertyDefault("Application", "add_ons")).toEqual({
		known: true,
		default: {},
		isMap: true,
	});
	expect(schemaPropertyDefault("Module", "name")).toMatchObject({
		known: true,
		isMap: true,
	});
});

it("answers a key the manifest does not list, and a model's undeclared-key rule, as unknown", () => {
	const unknown = { known: false, default: undefined, isMap: false };
	expect(schemaPropertyDefault("Module", "a_key_no_pin_declares")).toEqual(
		unknown,
	);
	expect(schemaPropertyDefault("AdvancedForm", "<undeclared>")).toEqual(
		unknown,
	);
	expect(schemaPropertyDefault("Module", "__proto__")).toEqual(unknown);
});

it("answers a detail pair's default as a read serves it, each detail's display named", () => {
	// HQ writes a pair it was never given with both displays `null`, and every later read wraps it
	// again through `DetailPair.wrap`, which names them.
	const written = schemaPropertyDefault("Module", "ref_details");
	const served = servedSchemaPropertyDefault("Module", "ref_details");
	expect(written.default).toMatchObject({
		short: { display: null },
		long: { display: null },
	});
	expect(served).toMatchObject({
		known: true,
		isMap: false,
		default: {
			doc_type: "DetailPair",
			short: { doc_type: "Detail", display: "short", columns: [] },
			long: { doc_type: "Detail", display: "long", columns: [] },
		},
	});
	expect(
		servedSchemaPropertyDefault("Application", "auto_gps_capture"),
	).toEqual(schemaPropertyDefault("Application", "auto_gps_capture"));
	expect(
		servedSchemaPropertyDefault("Module", "a_key_no_pin_declares"),
	).toEqual({
		known: false,
		default: undefined,
		isMap: false,
	});
});
