/** Every tool's input schema is read here the way a client receives it from
 * tools/list, then handed to consumers that do not share Nova's engine: a
 * JSON Schema validator for the dialect each schema declares, and the Rust
 * regex engine. Clients forward these schemas to model providers, which
 * refuse a pattern JavaScript forgives, and a refused schema stops the client
 * before its first tool call. JavaScript's own strict `v` mode is no stand-in:
 * it refuses patterns those providers accept. */
import type { Client } from "@modelcontextprotocol/client";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { RRegex } from "rregex";
import { beforeAll, expect, it } from "vitest";
import { registerNovaTools } from "../server";
import { withMcpClient } from "./client";

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Keywords whose value maps author-chosen names to schemas. The names are
 * data: a property called `pattern` is not a regex. */
const NAMED_SUBSCHEMAS = [
	"properties",
	"patternProperties",
	"definitions",
	"$defs",
	"dependentSchemas",
];
const SUBSCHEMAS = [
	"items",
	"prefixItems",
	"additionalItems",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
	"contains",
	"propertyNames",
	"not",
	"if",
	"then",
	"else",
	"allOf",
	"anyOf",
	"oneOf",
];

/** Visit schema positions only, so literal data under enum/const/default is
 * never mistaken for a keyword. */
function visitSchemas(
	schema: Json,
	pointer: string,
	visit: (schema: Json, pointer: string) => void,
): void {
	visit(schema, pointer);
	for (const key of NAMED_SUBSCHEMAS) {
		const entries = schema[key];
		if (!object(entries)) continue;
		for (const [name, value] of Object.entries(entries))
			if (object(value))
				visitSchemas(value, `${pointer}/${key}/${name}`, visit);
	}
	for (const key of SUBSCHEMAS) {
		const value = schema[key];
		if (object(value)) visitSchemas(value, `${pointer}/${key}`, visit);
		else if (Array.isArray(value))
			value.forEach((item, index) => {
				if (object(item))
					visitSchemas(item, `${pointer}/${key}/${index}`, visit);
			});
	}
}

const reason = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

let listed: Awaited<ReturnType<Client["listTools"]>>["tools"];
beforeAll(async () => {
	listed = await withMcpClient(
		(server) =>
			registerNovaTools(server, {
				userId: "member",
				scopes: ["nova.read", "nova.write"],
				authKind: "api-key",
			}),
		async (client) => (await client.listTools()).tools,
	);
});

it("publishes input schemas that a validator for their declared dialect can compile", () => {
	const refused: string[] = [];
	for (const tool of listed) {
		const schema = tool.inputSchema as Json;
		const declared = schema.$schema;
		const Validator =
			typeof declared === "string" && declared.includes("draft-07")
				? Ajv
				: Ajv2020;
		try {
			new Validator({ strict: false, validateFormats: false }).compile(schema);
		} catch (error) {
			refused.push(
				`${tool.name}: a JSON Schema validator could not compile the input schema this tool publishes (${reason(error)}). Clients hand this schema to their model provider as it is, so look for a reference that points nowhere or a keyword holding the wrong kind of value.`,
			);
		}
	}
	expect(refused).toEqual([]);
});

it("publishes only patterns that a regex engine other than JavaScript's can read", () => {
	const refused: string[] = [];
	for (const tool of listed)
		visitSchemas(tool.inputSchema as Json, "", (schema, pointer) => {
			/* A schema publishes a regex in two places: the `pattern` keyword,
			 * and each key of `patternProperties`. */
			const published: [string, string][] = [];
			if (typeof schema.pattern === "string")
				published.push([`${pointer}/pattern`, schema.pattern]);
			if (object(schema.patternProperties))
				for (const key of Object.keys(schema.patternProperties))
					published.push([`${pointer}/patternProperties`, key]);
			for (const [where, pattern] of published)
				try {
					new RRegex(pattern).free();
				} catch (error) {
					refused.push(
						`${tool.name} at ${where}: JavaScript reads ${pattern}, but the Rust regex engine cannot (${reason(error)}). Model providers check published patterns with engines like it and turn away a client that sends this one. Where the pattern is written, escape what is special inside a character class, such as [ and ], and leave out lookarounds and backreferences.`,
					);
				}
		});
	expect(refused).toEqual([]);
});

it("publishes an exact choice between saved and private read targets", () => {
	const tool = listed.find((entry) => entry.name === "get_form");
	if (!tool) throw new Error("get_form is missing");
	const validate = new Ajv({
		strict: false,
		validateFormats: false,
	}).compile(tool.inputSchema);
	const address = { moduleUuid: "Intake", formUuid: "Patient intake" };
	expect(validate({ ...address, app_id: "saved-app" })).toBe(true);
	expect(
		validate({ ...address, work_id: "00000000-0000-4000-8000-000000000001" }),
	).toBe(true);
	expect(
		validate({
			...address,
			app_id: "saved-app",
			work_id: "00000000-0000-4000-8000-000000000001",
		}),
	).toBe(false);
	expect(validate(address)).toBe(false);
});

it("rejects malformed work IDs in lifecycle and shared schemas", () => {
	for (const tool of listed) {
		const properties = (tool.inputSchema as Json).properties;
		if (!object(properties) || !properties.work_id) continue;
		const validate = new Ajv2020({
			strict: false,
			validateFormats: false,
		}).compile(properties.work_id as Json);
		expect(validate("placeholder"), tool.name).toBe(false);
		expect(validate("00000000-0000-4000-8000-000000000001"), tool.name).toBe(
			true,
		);
	}
});

/** A served tool by name, or a failure naming it. */
function served(name: string) {
	const tool = listed.find((entry) => entry.name === name);
	if (!tool) throw new Error(`${name} is missing from tools/list`);
	return tool;
}

/** Whether a served tool takes `input` as its whole input, validated in the
 *  schema's declared dialect: `true`, or what the validator refused. */
function takes(name: string, input: Json) {
	const schema = served(name).inputSchema as Json;
	const Validator =
		typeof schema.$schema === "string" && schema.$schema.includes("draft-07")
			? Ajv
			: Ajv2020;
	const validate = new Validator({
		strict: false,
		validateFormats: false,
	}).compile(schema);
	return validate(input) || validate.errors;
}

it("serves a question's keypad and text settings, a search with no title, where blanks sort and the calculated value in text", () => {
	const module = {
		work_id: "00000000-0000-4000-8000-000000000001",
		request_id: "questions-and-text",
		moduleUuid: "11111111-1111-4111-8111-111111111111",
	};
	const form = { ...module, formUuid: "22222222-2222-4222-8222-222222222222" };
	const field = { ...form, fieldUuid: "33333333-3333-4333-8333-333333333333" };

	const phone = {
		kind: "text",
		id: "phone",
		label: "Phone {{= format-date(today(), '%e %b %Y')}}",
		help: "Use *digits*",
		keypad: "numbers",
		plain_help: true,
	};
	expect(takes("add_fields", { ...form, fields: [phone] })).toBe(true);
	expect(
		takes("add_fields", { ...form, fields: [{ ...phone, keypad: "letters" }] }),
	).not.toBe(true);
	expect(
		takes("edit_field", {
			...field,
			updates: { kind: "text", keypad: null, plain_help: null },
		}),
	).toBe(true);

	for (const [name, input] of [
		["create_form", { ...module, name: "Visit", type: "survey" }],
		["update_form", form],
	] as const) {
		expect(takes(name, { ...input, plain_text: true }), name).toBe(true);
		expect(takes(name, { ...input, plain_text: "yes" }), name).not.toBe(true);
	}

	expect(
		takes("set_case_search_display", {
			...module,
			searchScreenTitle: { kind: "none" },
			searchScreenSubtitle: null,
			searchButtonDisplayCondition: null,
		}),
	).toBe(true);
	expect(
		takes("set_case_search_display", {
			...module,
			searchScreenTitle: { kind: "untitled" },
			searchScreenSubtitle: null,
			searchButtonDisplayCondition: null,
		}),
	).not.toBe(true);

	const column = (blanks: string) => ({
		...module,
		columns: [
			{
				kind: "plain",
				field: "case_name",
				header: "Name",
				sort: { direction: "asc", priority: 0, blanks },
			},
		],
	});
	expect(takes("add_case_list_columns", column("last"))).toBe(true);
	expect(takes("add_case_list_columns", column("middle"))).not.toBe(true);

	// A page's title is a wording position, described with the formula.
	expect(JSON.stringify(served("set_form_sections").inputSchema)).toContain(
		"{{= formula}} inserts a calculated value",
	);
});

it("serves a property column's walk to the case above as a list of links", () => {
	const module = {
		work_id: "00000000-0000-4000-8000-000000000001",
		request_id: "case-list-related-columns",
		moduleUuid: "11111111-1111-4111-8111-111111111111",
	};
	const columns = (via: readonly Json[]) => ({
		...module,
		columns: [{ kind: "plain", field: "case_name", header: "Household", via }],
	});
	expect(
		takes("add_case_list_columns", columns([{ identifier: "parent" }])),
	).toBe(true);
	expect(
		takes(
			"add_case_list_columns",
			columns([
				{ identifier: "parent" },
				{ identifier: "host", throughCaseType: "village" },
			]),
		),
	).toBe(true);
	// A walk names at least one link, and a calculated column has none.
	expect(takes("add_case_list_columns", columns([]))).not.toBe(true);
	expect(
		takes("add_case_list_columns", {
			...module,
			columns: [
				{
					kind: "calculated",
					header: "Total",
					expression: { kind: "term", term: { kind: "literal", value: 1 } },
					via: [{ identifier: "parent" }],
				},
			],
		}),
	).not.toBe(true);
	expect(
		takes("update_case_list_column", {
			...module,
			columnUuid: "44444444-4444-4444-8444-444444444444",
			column: {
				kind: "date",
				field: "visit_date",
				header: "Last visit",
				pattern: "%Y-%m-%d",
				via: [{ identifier: "parent" }],
			},
		}),
	).toBe(true);
});

it("serves a sort's name in Sort by as text on every column's rule", () => {
	const module = {
		work_id: "00000000-0000-4000-8000-000000000001",
		request_id: "case-list-sort-label",
		moduleUuid: "11111111-1111-4111-8111-111111111111",
	};
	const sort = { direction: "asc", priority: 0, label: "Feeling sick" };
	expect(
		takes("add_case_list_columns", {
			...module,
			columns: [
				{
					kind: "plain",
					field: "feeling_sick",
					header: "Feeling sick",
					visibleInList: false,
					sort,
				},
			],
		}),
	).toBe(true);
	expect(
		takes("update_case_list_column", {
			...module,
			columnUuid: "44444444-4444-4444-8444-444444444444",
			column: {
				kind: "date",
				field: "visit_date",
				header: "Last visit",
				pattern: "%Y-%m-%d",
				visibleInList: false,
				sort,
			},
		}),
	).toBe(true);
	// The name is text, never another shape.
	expect(
		takes("add_case_list_columns", {
			...module,
			columns: [
				{
					kind: "plain",
					field: "feeling_sick",
					header: "Feeling sick",
					visibleInList: false,
					sort: { ...sort, label: 1 },
				},
			],
		}),
	).not.toBe(true);
	expect(JSON.stringify(served("add_case_list_columns").inputSchema)).toContain(
		"The name workers pick this column by in the list's Sort by menu",
	);
});

it("serves accept_placement_moves as exactly a reason and a 64-hex digest", () => {
	const properties = (served("upload_app_to_hq").inputSchema as Json)
		.properties;
	if (!object(properties) || !object(properties.accept_placement_moves))
		throw new Error("upload_app_to_hq serves no accept_placement_moves");
	const accept = properties.accept_placement_moves;
	expect(accept.description).toBe(
		"Send only after a refusal returned placement_moves, with its reason and digest, once the user agreed to move those case changes.",
	);
	const validate = new Ajv2020({
		strict: false,
		validateFormats: false,
	}).compile(accept);
	const digest = "ab".repeat(32);
	expect(validate({ reason: "save-to-case", digest })).toBe(true);
	expect(validate({ reason: "same-type-child-links", digest })).toBe(true);
	expect(validate({ reason: "save-to-case", digest: "AB".repeat(32) })).toBe(
		false,
	);
	expect(validate({ reason: "save-to-case", digest: "ab" })).toBe(false);
	expect(validate({ reason: "somewhere-else", digest })).toBe(false);
	expect(validate({ reason: "save-to-case" })).toBe(false);
	expect(
		validate({ reason: "save-to-case", digest, moves: ["In Visit"] }),
	).toBe(false);
});

it("tells a client what an upload records and what a move offer asks of the user", () => {
	expect(served("upload_app_to_hq").description).toContain(
		"The first upload of a case change records where CommCare HQ keeps it, which changes the saved app (`placements.recorded`); work begun with `begin_work` before then has to begin again. If a refusal carries `placement_moves`, show the user each move's `sentence`, and send `accept_placement_moves` with its `reason` and `digest` only when the user agrees: the move changes where CommCare HQ keeps those answers in every project space the app is published to. `hq_placement_moves_changed` means the offer changed since; show the new one. `app_changed_while_publishing` means the app, or where it publishes, kept changing while Nova prepared the upload, and nothing more was sent; relay the `message`, which says when to upload again.",
	);
	expect(served("check_project_space_compatibility").description).toContain(
		"`placement_moves`, where present, lists the case changes Nova can move so the app doesn't need Save to Case.",
	);
});

it("tells a client what to do for unreadable source and installation profile stops", () => {
	const { description } = served("upload_app_to_hq");
	const instructions = [
		"If the current HQ app source cannot be read safely before an update, the call returns `hq_app_state_unknown` and leaves the existing HQ app unchanged.",
		"If an installation profile needs an edit in the project space, show the complete hq_installation_profile_review message and its review_url. Follow any Read the next part choice until the complete review has been disclosed. Use the replacement_choices labels to browse Nova installations and their matching installations in the project space. Send the chosen navigation token to see that page. Ask the user to confirm the exact destination ID, languages and worker before sending a binding choice. Ask the user to confirm a newly selected practice worker before sending confirm_installation_profiles with the returned confirmation.",
		"If an application profile of the app on CommCare HQ includes a language the app no longer has, the call returns `hq_build_profile_language_missing` before sending the app's content: relay the `message` and its `url`, and upload again once the user has changed the profile there.",
	];
	let previous = -1;
	for (const instruction of instructions) {
		const position = description?.indexOf(instruction) ?? -1;
		expect(position, instruction).toBeGreaterThan(previous);
		previous = position;
	}
});

it("tells a client what the two stops over data CommCare HQ manages ask of it, right after the drift stop's", () => {
	expect(served("upload_app_to_hq").description).toContain(
		"uploading again lists what changed. A success after such a publish can carry `app_preview_note`; relay it. Refreshing a lookup table or places managed in CommCare HQ during upload also requires HQ Import. If a lookup table the app reads is managed in CommCare HQ and changed there in a way the app depends on, the call returns `hq_managed_data_changed` before sending anything: relay the `message`, which names each table, what changed and what the user can do, and upload again once that is done. To publish Nova's copy of a table instead, the user can hand it to Nova with `set_lookup_table_management`: show what that does and ask first. `managed_table_handed_back` means a table was handed back to CommCare HQ while the upload was getting ready, and Nova stopped before sending any lookup table or the app's content: upload again, and Nova leaves that table as it is.",
	);
});

it("serves the CommCare Supply confirmation on upload and withdrawal, and names it in the compatibility check", () => {
	const upload = (served("upload_app_to_hq").inputSchema as Json).properties;
	if (!object(upload) || !object(upload.confirm_commtrack_off))
		throw new Error("upload_app_to_hq serves no confirm_commtrack_off");
	expect(upload.confirm_commtrack_off.type).toBe("boolean");
	expect(upload.confirm_commtrack_off.description).toBe(
		"Send only after an `hq_confirmation_needed` refusal named them and the user said yes to each.",
	);
	expect(served("upload_app_to_hq").description).toContain(
		"(a plan feature, the flat location list, a Connect forwarder, Sync Cases On Form Entry turned off, CommCare Supply turned off)",
	);
	expect(served("upload_app_to_hq").description).toContain(
		"`confirm_form_entry_sync_off` and `confirm_commtrack_off`",
	);

	const withdraw = (
		served("withdraw_deployment_confirmation").inputSchema as Json
	).properties;
	if (!object(withdraw) || !object(withdraw.kind))
		throw new Error("withdraw_deployment_confirmation serves no kind");
	const validateKind = new Ajv2020({
		strict: false,
		validateFormats: false,
	}).compile(withdraw.kind);
	expect(validateKind("commtrack-off")).toBe(true);
	expect(validateKind("commcare-supply")).toBe(false);
	expect(withdraw.kind.description).toContain("`commtrack-off`");

	expect(served("check_project_space_compatibility").description).toContain(
		"`commtrack_off` says whether the project space's CommCare Supply setting needs confirming, and `placement_moves`, where present, lists the case changes Nova can move so the app doesn't need Save to Case.",
	);
});

it("serves provision_workers' confirm_worker_levels as level codes, and withdrawal of a worker level", () => {
	const provision = served("provision_workers");
	const properties = (provision.inputSchema as Json).properties;
	if (!object(properties) || !object(properties.confirm_worker_levels))
		throw new Error("provision_workers serves no confirm_worker_levels");
	const validateLevels = new Ajv2020({
		strict: false,
		validateFormats: false,
	}).compile(properties.confirm_worker_levels);
	expect(validateLevels(["district", "Health_Facility", "_ward-2"])).toBe(true);
	/* A level code HQ derives from a name is checked where the call is read:
	 * its rule is a refinement no JSON Schema keyword states. */
	expect(validateLevels("district")).toBe(false);
	expect(properties.confirm_worker_levels.description).toContain(
		"`worker_levels_unconfirmed`",
	);
	expect(provision.description).toContain("`confirm_worker_levels`");

	const withdraw = (
		served("withdraw_deployment_confirmation").inputSchema as Json
	).properties;
	if (!object(withdraw) || !object(withdraw.kind))
		throw new Error("withdraw_deployment_confirmation serves no kind");
	const validateKind = new Ajv2020({
		strict: false,
		validateFormats: false,
	}).compile(withdraw.kind);
	expect(validateKind("worker-level")).toBe(true);
	expect(withdraw.kind.description).toContain("`worker-level`");
});

it("serves refresh_deployment's kept_values and tells a client what the kept list is", () => {
	const refresh = served("refresh_deployment");
	const properties = (refresh.inputSchema as Json).properties;
	if (!object(properties) || !object(properties.kept_values))
		throw new Error("refresh_deployment serves no kept_values");
	expect(properties.kept_values.type).toBe("boolean");
	expect(properties.kept_values.description).toBe(
		"Read the project space's kept settings again, in place of the build and release check.",
	);
	const required = (refresh.inputSchema as Json).required;
	expect(Array.isArray(required) && required.includes("kept_values")).toBe(
		false,
	);
	expect(refresh.description).toMatch(
		/ Pass `kept_values: true` to read again the settings this project space keeps in CommCare HQ \(the `kept` list of `get_deployment`\) without asking about builds\. It updates them only where nothing Nova publishes has changed in CommCare HQ since the last publish, and says so otherwise\. /,
	);
	expect(refresh.description).toMatch(
		/ Where Nova couldn't read back `kept` or `nova_revision` after its write landed, that field is left out and the refresh still landed: `get_deployment` reads them again\. Reading fresh kept settings also requires HQ Import\.$/,
	);
	expect(served("get_deployment").description).toContain(
		" `deployment.kept` lists the settings that stay as CommCare HQ holds them on that project space, with the date Nova read them.",
	);
});

it("tells a client which lookup tables and places are copies of CommCare HQ's, and that changing them is refused", () => {
	expect(served("get_lookup_tables").description).toContain(
		"A table with `managed_in_commcare_hq` is a copy of a table that lives in CommCare HQ. Read it freely. Changing it is refused: its rows and columns change in CommCare HQ.",
	);
	expect(served("get_organization").description).toContain(
		"When `places_managed_in_commcare_hq` is present, the places are a copy of CommCare HQ's. Levels and place information can still be changed; places cannot.",
	);
});

/** A served tool's input schema's property names, sorted, and whether it is closed. */
function inputShape(name: string) {
	const schema = served(name).inputSchema as Json;
	const properties = object(schema.properties)
		? Object.keys(schema.properties).sort()
		: [];
	const required = Array.isArray(schema.required)
		? [...schema.required].sort()
		: [];
	return {
		properties,
		required,
		additionalProperties: schema.additionalProperties,
	};
}

/** The served schemas' every position, for a keyword no position may hold. */
function everyPosition(name: string): Json[] {
	const positions: Json[] = [];
	visitSchemas(served(name).inputSchema as Json, "", (schema) =>
		positions.push(schema),
	);
	return positions;
}

/** A served tool's one property, compiled on its own in the schema's dialect. */
function validatorOf(name: string, property: string) {
	const properties = (served(name).inputSchema as Json).properties;
	if (!object(properties) || !object(properties[property]))
		throw new Error(`${name} serves no ${property}`);
	return new Ajv2020({ strict: false, validateFormats: false }).compile(
		properties[property],
	);
}

it("serves bring_in_hq_app with every answer required and no default", () => {
	const all = [
		"app_name",
		"domain",
		"hq_app_id",
		"owner_rule_choices",
		"project_id",
		"reading_id",
		"review_digest",
		"runs_only_on",
		"split_datetime",
		"table_choices",
	];
	expect(inputShape("bring_in_hq_app")).toEqual({
		properties: all,
		required: all,
		additionalProperties: false,
	});
	const runsOnlyOn = validatorOf("bring_in_hq_app", "runs_only_on");
	expect(runsOnlyOn(null)).toBe(true);
	expect(runsOnlyOn("web-apps")).toBe(true);
	expect(runsOnlyOn("android")).toBe(true);
	expect(runsOnlyOn("both")).toBe(false);
	expect(runsOnlyOn(undefined)).toBe(false);
	const digest = validatorOf("bring_in_hq_app", "review_digest");
	expect(digest("ab".repeat(32))).toBe(true);
	expect(digest("AB".repeat(32))).toBe(false);
	const readingId = validatorOf("bring_in_hq_app", "reading_id");
	expect(readingId("0192f5a0-0000-7000-8000-000000000001")).toBe(true);
	expect(readingId("0192f5a0-0000-4000-8000-000000000001")).toBe(false);
	expect(
		everyPosition("bring_in_hq_app").filter((schema) => "default" in schema),
	).toEqual([]);
});

it("serves read_hq_app as one closed object", () => {
	expect(inputShape("read_hq_app")).toEqual({
		properties: ["domain", "hq_app_id", "page", "project_id"],
		required: ["domain", "hq_app_id", "project_id"],
		additionalProperties: false,
	});
	const page = validatorOf("read_hq_app", "page");
	expect(page(`120:${"ab".repeat(32)}`)).toBe(true);
	expect(page("120")).toBe(false);
	expect(page(`120:${"AB".repeat(32)}`)).toBe(false);
	/* A review's lookup tables are paged as an account is, and the create's
	 * answers cover every page's tables. */
	expect(served("read_hq_app").description).toContain(
		"Each review page holds its share of `review.tables`, and `review.tables_total` says how many there are in all; show the user every table of every page before calling `bring_in_hq_app`.",
	);
	expect(served("bring_in_hq_app").description).toContain(
		"`table_choices` holds one answer for each table whose review entry has a `choice`, on every page of the review,",
	);
});

it("serves the four other bring-in tools as closed objects", () => {
	expect(inputShape("list_hq_apps")).toEqual({
		properties: ["domain"],
		required: ["domain"],
		additionalProperties: false,
	});
	expect(inputShape("stop_publishing")).toEqual({
		properties: ["app_id", "domain", "hq_app_id", "server"],
		required: ["app_id", "domain", "hq_app_id", "server"],
		additionalProperties: false,
	});
	expect(inputShape("refresh_managed_data")).toEqual({
		properties: ["app_id", "project_id", "table_id"],
		required: ["project_id"],
		additionalProperties: false,
	});
	expect(inputShape("set_lookup_table_management")).toEqual({
		properties: [
			"current_workbook_base64",
			"managed_by",
			"project_id",
			"review_digest",
			"source_domain",
			"source_server",
			"table_id",
		],
		required: ["managed_by", "project_id", "table_id"],
		additionalProperties: false,
	});
	expect(inputShape("separate_lookup_table")).toEqual({
		properties: [
			"app_ids",
			"name",
			"project_id",
			"review_digest",
			"table_id",
			"tag",
		],
		required: ["project_id", "table_id"],
		additionalProperties: false,
	});
	/* A separate table is made only under the digest of the preview the
	 * user read, and never for an app named some other way. */
	expect(
		takes("separate_lookup_table", {
			project_id: "program",
			table_id: "table",
			confirmed: true,
		}),
	).not.toBe(true);
	expect(
		takes("separate_lookup_table", {
			project_id: "program",
			table_id: "table",
			name: "Facilities 2",
			tag: "facilities_2",
			app_ids: ["app"],
			review_digest: "a".repeat(64),
		}),
	).toBe(true);
	/* A change of who manages a table is made only under the digest of the
	 * preview the user read: there is no bare yes. */
	expect(
		takes("set_lookup_table_management", {
			project_id: "program",
			table_id: "table",
			managed_by: "nova",
			confirmed: true,
		}),
	).not.toBe(true);
	expect(
		takes("set_lookup_table_management", {
			project_id: "program",
			table_id: "table",
			managed_by: "nova",
			review_digest: "not a digest",
		}),
	).not.toBe(true);
	expect(
		takes("set_lookup_table_management", {
			project_id: "program",
			table_id: "table",
			managed_by: "nova",
			review_digest: "a".repeat(64),
		}),
	).toBe(true);
	const managedBy = (served("set_lookup_table_management").inputSchema as Json)
		.properties;
	if (!object(managedBy) || !object(managedBy.managed_by))
		throw new Error("set_lookup_table_management serves no managed_by");
	expect(managedBy.managed_by.enum).toEqual(["nova", "commcare-hq"]);
	expect(
		takes("stop_publishing", {
			app_id: "app",
			server: "production",
			domain: "clinic",
			hq_app_id: "hq-app",
			reason: "the user asked",
		}),
	).not.toBe(true);
	/* The stop names the HQ app the client read, or it is no stop at all. */
	expect(
		takes("stop_publishing", {
			app_id: "app",
			server: "production",
			domain: "clinic",
		}),
	).not.toBe(true);
	expect(
		takes("stop_publishing", {
			app_id: "app",
			server: "production",
			domain: "clinic",
			hq_app_id: "hq-app",
		}),
	).toBe(true);
});

it("serves read_hq_changes and bring_in_hq_changes as closed objects, the bring-in with every answer required", () => {
	expect(inputShape("read_hq_changes")).toEqual({
		properties: ["app_id", "domain", "page"],
		required: ["app_id"],
		additionalProperties: false,
	});
	const page = validatorOf("read_hq_changes", "page");
	expect(page(`120:${"ab".repeat(32)}`)).toBe(true);
	expect(page("120")).toBe(false);

	const answers = [
		"app_id",
		"discard_nova_changes",
		"owner_rule_choices",
		"reading_id",
		"review_digest",
		"table_choices",
	];
	expect(inputShape("bring_in_hq_changes")).toEqual({
		properties: [...answers, "domain"].sort(),
		required: answers,
		additionalProperties: false,
	});
	const discard = validatorOf("bring_in_hq_changes", "discard_nova_changes");
	expect(discard(true)).toBe(true);
	expect(discard("yes")).toBe(false);
	const choices = validatorOf("bring_in_hq_changes", "table_choices");
	expect(choices({ district: "use-project" })).toBe(true);
	expect(choices({ district: "both" })).toBe(false);
	const owners = validatorOf("bring_in_hq_changes", "owner_rule_choices");
	expect(owners({ clinic: "worker" })).toBe(true);
	expect(owners({ clinic: "first_clinic" })).toBe(false);
	expect(
		everyPosition("bring_in_hq_changes").filter(
			(schema) => "default" in schema,
		),
	).toEqual([]);
	expect(
		takes("read_hq_changes", { app_id: "app", domain: "clinic", server: "eu" }),
	).not.toBe(true);
});

it("tells a client an agent never chooses for the user", () => {
	expect(served("bring_in_hq_app").description).toContain(
		"never choose the name, where the app runs, the date-and-time split, a lookup table's answer or an owner rule's answer for them",
	);
	expect(served("read_hq_app").description).toContain(
		"never choose it for them",
	);
	expect(served("set_lookup_table_management").description).toContain(
		"Never decide this for the user.",
	);
});

it("names each key where a client reads it", () => {
	const relayInOrder =
		"Relay each `sentence` of `workers.lines`, then of `hq_only.lines`, then `reassurance` where it is not null, then `note`";
	const compatibility = served("check_project_space_compatibility").description;
	expect(compatibility).toContain("`first_publish`");
	expect(compatibility).toContain(relayInOrder);
	/* An upload where publishing was stopped makes a new app beside the one
	 * that stays: the check says so before the upload, and the upload names
	 * where. */
	expect(compatibility).toContain(
		"`new_app_beside`, where it is not null, says Nova stopped publishing this app to the project space, so an upload there makes a new app beside the one that stays: relay it before the upload, and upload only if the user wants a new app there.",
	);
	expect(served("upload_app_to_hq").description).toContain(
		"Where Nova stopped publishing the app to that project space, an upload makes a new app beside the one that stays there, which `check_project_space_compatibility` says in `new_app_beside` before the upload.",
	);
	const deployment = served("get_deployment").description;
	expect(deployment).toContain("`brought_in`");
	expect(deployment).toContain("`ending`");
	/* An ended deployment whose HQ app another Nova app holds now names no
	 * HQ app, and the client is told why, so it offers no way back. */
	expect(deployment).toContain(
		"where `ending.held_by_another_app` is true, another Nova app publishes to that CommCare HQ app now, so `ending.hq_app_id` is left out and there is no way back to it to offer",
	);
	expect(deployment).toContain(
		"`state` is one of `preflight`, `uploaded`, `built`, `released`, `runnable`, `incomplete` or `ended`",
	);
	expect(served("upload_app_to_hq").description).toContain(
		"`publishing_stopped`",
	);
	expect(served("upload_app_to_hq").description).toContain("`since`");
	expect(served("get_hq_connection").description).toContain("`list_hq_apps`");
	expect(served("stop_publishing").description).toContain(
		"`setup_artifact` is then null, and `get_deployment` reads it again",
	);
	expect(served("stop_publishing").description).toContain(
		"the call returns `deployment_changed` and stops nothing",
	);
	/* CommCare HQ can hold no name for an app, so the client is told the review's
	 * name can be empty and asks the user for one there. */
	const bringInInput = (served("bring_in_hq_app").inputSchema as Json)
		.properties;
	if (!object(bringInInput) || !object(bringInInput.app_name))
		throw new Error("bring_in_hq_app serves no app_name");
	expect(bringInInput.app_name.description).toContain(
		"empty where CommCare HQ holds none",
	);
	/* Where a change can be brought in, and the revision CommCare HQ's copy
	 * matches, are each named where a client meets them. */
	expect(served("upload_app_to_hq").description).toContain(
		" When the app's change has `can_bring_in` true, you can read what changed with `read_hq_changes` and bring it in with `bring_in_hq_changes`, or publish over it by naming it in `discard_hq_changes`. Ask the user which.",
	);
	expect(deployment).toContain("`nova_revision`");
	expect(served("read_hq_changes").description).toContain("`can_bring_in`");
	for (const key of ["`reading_id`", "`review_digest`", "`nova_changes`"])
		expect(served("bring_in_hq_changes").description).toContain(key);

	const read = served("read_hq_app").description ?? "";
	for (const key of [
		"`first_publish`",
		"`check_again`",
		"`next_page`",
		"`restarted`",
	])
		expect(read).toContain(key);
	expect(served("bring_in_hq_app").description).toContain("`first_publish`");
	/* Each tool that names `first_publish` names its four parts in the order
	 * a client relays them. */
	for (const name of [
		"read_hq_app",
		"bring_in_hq_app",
		"check_project_space_compatibility",
	]) {
		const description = served(name).description ?? "";
		const at = [
			"`workers.lines`",
			"`hq_only.lines`",
			"`reassurance` where it is not null",
			"`note`",
		].map((part) => description.indexOf(part));
		expect(
			at.every((index) => index >= 0),
			name,
		).toBe(true);
		expect(
			[...at].sort((a, b) => a - b),
			name,
		).toEqual(at);
	}
});
