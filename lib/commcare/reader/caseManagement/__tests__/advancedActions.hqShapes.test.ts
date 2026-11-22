/**
 * An advanced form in the shapes CommCare HQ's case configuration page stores
 * that Nova's emitter does not write.
 *
 * Contract: each shape below reads into the finding its manifest entry names,
 * once, at its place, or reads as the same state; `judgeLoads` tells a tag Nova would not derive on a load that changes no
 * case from a chain that differs. The plausible failures: Nova re-tagging a
 * load, which renames a session value HQ's forms read; a hyphenated tag (HQ's
 * page derives one from a hyphenated case type) losing its original spelling; an index name Nova cannot spell held; a saved-if-
 * changed write read as saved every time in a project space that applies it.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	type CaseOperation,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { formField, term, unowned } from "@/lib/domain/expression/builders";
import {
	advancedFixture,
	chosen,
	HOUSEHOLD_VISIT,
	HOUSEHOLDS,
	MEMBERS,
	OP,
	read,
	U,
	VISITS,
} from "../../../__tests__/advancedPlacementFixture";
import { planFormCaseWire } from "../../../casePlacementPlan";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import {
	codesOf,
	type AppJson as MenuAppJson,
	readMenusOf as readMenusOfDoc,
} from "../../menus/__tests__/menuReading";
import {
	judgeLoads,
	type StoredLoad,
	settleAdvancedMenu,
} from "../advancedActions";
import {
	type AppJson,
	findingCodes,
	readCases as readCasesOf,
} from "./caseReading";

const F = "forms-and-case-writes";

const readCases = namingFromHqPages(readCasesOf);
const readMenusOf = namingFromHqPages(readMenusOfDoc);

/** The stored actions of the form under test, the first advanced form. */
function actionsOf(app: AppJson | MenuAppJson): Record<string, unknown> & {
	load_update_cases: Record<string, unknown>[];
	open_cases: Record<string, unknown>[];
} {
	for (const module of app.modules)
		for (const form of module.forms)
			if (
				form.doc_type === "AdvancedForm" &&
				form.name !== undefined &&
				JSON.stringify(form.name).includes("Under test")
			)
				return form.actions as never;
	throw new Error("The app holds the advanced form under test.");
}

/** The surface keys of an advanced form's actions. */
const ACTION_KEYS = [
	"schema:LoadUpdateAction",
	"schema:AdvancedOpenCaseAction",
	"schema:AdvancedForm.actions",
];

/** The findings a form's actions raise: their entries, and every key of theirs left unclaimed. */
function actionFindings(
	reading: Awaited<ReturnType<typeof readCases>>,
): string[] {
	return reading.findings.flatMap((finding) =>
		finding.code.startsWith(F)
			? [finding.code]
			: finding.code === "unrecognized" &&
					ACTION_KEYS.some((key) =>
						(finding.detail?.name ?? "").startsWith(key),
					)
				? [`unrecognized ${finding.detail?.name}`]
				: [],
	);
}

const memberFollowup = (extra: CaseOperation[] = []) =>
	advancedFixture({
		formType: "followup",
		menu: "members",
		operations: () => [
			{
				uuid: OP("own"),
				id: "member",
				action: "own",
				writes: [{ property: "age", value: read("age") }],
			},
			...extra,
		],
	});

const registration = (extra: CaseOperation[] = []) =>
	advancedFixture({
		formType: "registration",
		operations: () => [
			{ uuid: OP("own"), id: "household", action: "own", name: read("name") },
			...extra,
		],
	});

const kid: CaseOperation = {
	uuid: OP("kid"),
	id: "member",
	action: "create",
	caseType: "member",
	target: { kind: "new" },
	name: read("kid_name"),
	forEach: { repeat: U("kids") },
	links: [
		{
			identifier: "parent",
			targetType: "household",
			target: { kind: "op", opUuid: OP("own") },
			relationship: "child",
		},
	],
};

describe("an advanced form's tags", () => {
	it.each(["load_follow-up0", "load_follow_up0"])(
		"keeps the submitted tag %s on the selected record",
		async (tag) => {
			const { doc } = memberFollowup();
			const reading = await readCases(doc, {
				edit: (app) => {
					const loads = actionsOf(app).load_update_cases;
					(loads[loads.length - 1] as Record<string, unknown>).case_tag = tag;
				},
			});
			expect(actionFindings(reading)).toEqual([]);
			const own = reading.forms
				.filter((form) => form.docType === "AdvancedForm")
				.flatMap((form) => form.form.caseOperations ?? [])
				.find((operation) => operation.action === "own");
			expect(own?.placement).toEqual({ kind: "advanced", tag });
		},
	);

	it("keeps a hyphenated opened record tag when another case links to it", async () => {
		const { doc } = registration([kid]);
		const tag = "open-household_0";
		const reading = await readCases(doc, {
			edit: (app) => {
				const [own, child] = actionsOf(app).open_cases;
				if (!own || !child) throw new Error("The form opens two records.");
				own.case_tag = tag;
				const [link] = child.case_indices as { tag: string }[];
				if (!link) throw new Error("The child needs its household link.");
				link.tag = tag;
			},
		});
		expect(actionFindings(reading)).toEqual([]);
		const operations = reading.forms.flatMap(
			(form) => form.form.caseOperations ?? [],
		);
		const own = operations.find(
			(op) =>
				op.action === "own" &&
				op.placement?.kind === "advanced" &&
				op.placement.tag === tag,
		);
		expect(own).toBeDefined();
		const child = operations.find(
			(op) => op.action === "create" && op.caseType === "member",
		);
		expect(child?.links?.[0]?.target).toEqual({
			kind: "op",
			opUuid: own?.uuid,
		});
	});

	it("tells a write-less load tagged after the menu's case type from a chain that differs", () => {
		const { doc, formUuid } = memberFollowup();
		const plan = planFormCaseWire(doc, formUuid);
		if (plan.kind !== "advanced")
			throw new Error("The members menu is held advanced.");
		const menuId = (uuid: string) =>
			uuid === HOUSEHOLDS ? "households" : uuid === MEMBERS ? "members" : uuid;
		const stored: StoredLoad[] = plan.loads.map((load, i) => ({
			tag: load.tag,
			caseType: load.caseType,
			detailsModule: menuId(load.listModule as string),
			...(load.index !== undefined && { index: load.index }),
			changes: i === plan.loads.length - 1,
		}));
		expect(judgeLoads(plan.loads, stored, undefined, menuId)).toEqual({
			kind: "same",
		});
		// HQ's page names a new load after the menu's case type, whatever the load's.
		const parent = { ...(stored[0] as StoredLoad), tag: "load_member0" };
		const child = {
			...(stored[1] as StoredLoad),
			index: { tag: "load_member0", identifier: "parent" },
		};
		expect(judgeLoads(plan.loads, [parent, child], undefined, menuId)).toEqual({
			kind: "tag",
			tag: "load_member0",
		});
		// The same tag on a load that writes its case is no tag Nova can leave alone.
		expect(
			judgeLoads(
				plan.loads,
				[{ ...parent, changes: true }, child],
				undefined,
				menuId,
			),
		).toEqual({
			kind: "chain",
			tag: "load_member0",
		});
		// A chain one load short is the chain finding.
		expect(
			judgeLoads(plan.loads, [stored[1] as StoredLoad], undefined, menuId).kind,
		).toBe("chain");
	});
});

describe("an advanced form's loads and open actions", () => {
	it("refuses an open action's index named outside an XML element name", async () => {
		const { doc } = registration([kid]);
		const reading = await readCases(doc, {
			edit: (app) => {
				const opens = actionsOf(app).open_cases;
				const indices = (
					opens[1] as { case_indices: Record<string, unknown>[] }
				).case_indices;
				(indices[0] as Record<string, unknown>).reference_id = "my-parent";
			},
		});
		expect(findingCodes(reading)).toContain(
			`${F}/index-identifier-outside-an-xml-element-name`,
		);
	});

	it("refuses an index whose relationship a question chooses under the entry its shape is, each once", async () => {
		const { doc } = registration([kid]);
		for (const [question, entry] of [
			["", `${F}/relationship-question-without-relationship-question`],
			[
				"/data/kids/kid_age",
				`${F}/caseindex-relationship-question-inside-a-repeat`,
			],
			[
				"/data/age",
				`${F}/caseindex-relationship-question-relationship-question-the-index-naming-an`,
			],
		] as const) {
			const reading = await readCases(doc, {
				edit: (app) => {
					const opens = actionsOf(app).open_cases;
					const index = (
						opens[1] as { case_indices: Record<string, unknown>[] }
					).case_indices[0] as Record<string, unknown>;
					index.relationship = "question";
					index.relationship_question = question;
				},
			});
			expect(
				findingCodes(reading).filter((code) => code === entry),
				question,
			).toHaveLength(1);
		}
	});

	it("reads an open action with no name, which HQ's build refuses, as unrecognized and never drops it", async () => {
		const { doc } = registration([kid]);
		const reading = await readCases(doc, {
			edit: (app) => {
				const opens = actionsOf(app).open_cases;
				(opens[1] as { name_update: Record<string, unknown> }).name_update = {
					question_path: "",
				};
			},
		});
		expect(
			reading.findings.filter(
				(one) =>
					one.code === "unrecognized" &&
					one.detail?.name === "schema:AdvancedOpenCaseAction.name_update",
			),
		).toHaveLength(1);
		expect(
			reading.forms
				.flatMap((form) => form.form.caseOperations ?? [])
				.filter((one) => one.action === "create"),
		).toEqual([]);
	});

	it("refuses a load's saved-if-changed write where the project space applies it, and reads it as saved every time where it does not", async () => {
		const { doc } = memberFollowup();
		const edit = (app: AppJson) => {
			const loads = actionsOf(app).load_update_cases;
			const properties = (
				loads[loads.length - 1] as {
					case_properties: Record<string, Record<string, unknown>>;
				}
			).case_properties;
			(properties.age as Record<string, unknown>).update_mode = "edit";
		};
		const applied = await readCases(doc, { edit, saveOnlyEditedApplied: true });
		expect(findingCodes(applied)).toContain(
			`${F}/update-mode-edit-off-a-follow-up-form-s-own-update`,
		);
		const unapplied = await readCases(doc, {
			edit,
			saveOnlyEditedApplied: false,
		});
		expect(
			findingCodes(unapplied).filter((code) => code.startsWith(F)),
		).toEqual([]);
	});

	describe("a written key outside Nova's property grammar, or one HQ's server stores apart", () => {
		// HQ's build holds every key of every advanced action, a load's and an open
		// action's, to `validate_property` with parents and its reserved words on the
		// last step (`AdvancedFormValidator.check_actions` over `get_all_actions` →
		// `check_case_properties`), and writes each key as the update's element
		// (`xform.py::make_case_elem`).
		const ILLEGAL = `${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`;
		const NON_CORE = `${F}/update-key-holding-a-character-validate-property-accepts-that-is`;
		const NON_ASCII = `${F}/update-key-holding-a-non-ascii-core-name-character`;
		// HQ's build writes a load's and an open action's keys into the case block's
		// `<update>` as it writes a basic update's (`_create_casexml_advanced` →
		// `add_case_updates`), and HQ's server stores these two apart from the case's
		// properties there (`update_strategy.py::_apply_update_action`).
		const DIVERTED = `${F}/update-keys-location-id-hq-user-id`;
		const CASES: readonly (readonly [string, string])[] = [
			["location_id", DIVERTED],
			["hq_user_id", DIVERTED],
			["dob+1", ILLEGAL],
			["status", ILLEGAL],
			["date-opened", ILLEGAL],
			["case_name", ILLEGAL],
			["parent/stat+us", ILLEGAL],
			["parent/status", ILLEGAL],
			["age\n\n", ILLEGAL],
			// One trailing newline passes HQ's grammar, and lxml refuses it as a tag.
			["age\n", NON_CORE],
			["a½", NON_CORE],
			["a名字", NON_ASCII],
		];

		/** A whole reading of `doc` with `key` written to the case of `stored`'s map. */
		async function writing(
			doc: BlueprintDoc,
			key: string,
			stored: (app: MenuAppJson) => Record<string, unknown>,
		) {
			return readMenusOf(doc, (app) => {
				const properties = stored(app).case_properties as Record<
					string,
					unknown
				>;
				const [first] = Object.values(properties);
				properties[key] = first;
			});
		}

		it("refuses the worker's load's key the same way, once, with no second finding at the load", async () => {
			const { doc } = memberFollowup([
				{
					uuid: OP("worker"),
					id: "commcare_user",
					action: "update",
					caseType: "commcare-user",
					target: { kind: "worker-record" },
					writes: [{ property: "last_household", value: read("name") }],
				},
			]);
			const workerLoad = (app: MenuAppJson) => {
				const worker = actionsOf(app).load_update_cases.find(
					(load) => load.auto_select !== null,
				);
				if (worker === undefined)
					throw new Error("The form loads the worker's record.");
				return worker;
			};
			for (const [key, entry] of [
				["status", ILLEGAL],
				["mood\n", NON_CORE],
				// The worker's record is a case HQ's server updates as any other.
				["location_id", DIVERTED],
				["hq_user_id", DIVERTED],
			] as const) {
				// The key replaces the load's one write, which would leave it writing nothing.
				const reading = await readMenusOf(doc, (app) => {
					const load = workerLoad(app);
					const [value] = Object.values(
						load.case_properties as Record<string, unknown>,
					);
					load.case_properties = { [key]: value };
				});
				expect(reading.outcome.defects, key).toEqual([]);
				expect(codesOf(reading), key).toEqual([entry]);
			}
		});

		const lastLoad = (app: MenuAppJson) => {
			const loads = actionsOf(app).load_update_cases;
			return loads[loads.length - 1] as Record<string, unknown>;
		};
		const ownOpen = (app: MenuAppJson) => {
			const open = actionsOf(app).open_cases[0] as Record<string, unknown>;
			// The registration's own open action writes nothing but its name; give it
			// a write of the form's `age` to copy.
			open.case_properties = {
				...(open.case_properties as Record<string, unknown>),
				size: {
					...(open.name_update as Record<string, unknown>),
					question_path: "/data/age",
				},
			};
			return open;
		};

		for (const [surface, fixture, stored] of [
			["a load's", () => memberFollowup().doc, lastLoad],
			["an open action's", () => registration().doc, ownOpen],
		] as const)
			it(`refuses ${surface} key under the row HQ's build gives it, at its key, never a defect`, async () => {
				const doc = fixture();
				// The pair: the map as Nova writes it reads with no finding.
				const plain = await writing(doc, "size", stored);
				expect(codesOf(plain)).toEqual([]);
				expect(plain.outcome.defects).toEqual([]);
				for (const [key, entry] of CASES) {
					const reading = await writing(doc, key, stored);
					expect(reading.outcome.defects, key).toEqual([]);
					const found = reading.findings.filter((one) => one.code === entry);
					expect(found, key).toHaveLength(1);
					expect(found[0]?.detail?.name, key).toBe(key);
					expect(
						codesOf(reading).filter((code) => code.startsWith("unrecognized")),
						key,
					).toEqual([]);
				}
				// A name in Nova's grammar past its length is unrecognized at its map.
				const long = await writing(doc, "a".repeat(256), stored);
				expect(long.outcome.defects).toEqual([]);
				expect(codesOf(long)).toEqual([
					`unrecognized:${
						surface === "a load's"
							? "schema:LoadUpdateAction.case_properties"
							: "schema:AdvancedOpenCaseAction.case_properties"
					}`,
				]);
			});

		// HQ's build writes a key whose question is an `<upload>` into the block's
		// `<attachment>`, not its `<update>` (`XFormCaseBlock.add_case_updates` over
		// `is_attachment`), so HQ's server neither stores it as the case's location nor
		// copies it to the external id: the write is the upload question's row alone.
		const UPLOAD = `${F}/update-from-an-upload-question-attachment-mode`;

		/** The fixture with an image question at the form under test's root, which writes nothing. */
		function withPhoto(fixture: {
			readonly doc: BlueprintDoc;
			readonly formUuid: Uuid;
		}): BlueprintDoc {
			return produce(fixture.doc, (draft) => {
				const uuid = testUuid("adv-photo");
				draft.fields[uuid] = {
					uuid,
					kind: "image",
					id: "photo",
					label: proseText("Photo"),
				} as never;
				draft.fieldOrder[fixture.formUuid]?.push(uuid);
				rebuildFieldParent(draft);
			});
		}

		/** A whole reading with `key` written from the image question in `stored`'s map. */
		function fromPhoto(
			doc: BlueprintDoc,
			key: string,
			stored: (app: MenuAppJson) => Record<string, unknown>,
			only = false,
		) {
			return readMenusOf(doc, (app) => {
				const load = stored(app);
				const properties = load.case_properties as Record<string, unknown>;
				const [first] = Object.values(properties);
				const write = {
					...(first as Record<string, unknown>),
					question_path: "/data/photo",
				};
				load.case_properties = only
					? { [key]: write }
					: { ...properties, [key]: write };
			});
		}

		for (const [surface, fixture, stored] of [
			["a load's", () => withPhoto(memberFollowup()), lastLoad],
			["an open action's", () => withPhoto(registration()), ownOpen],
		] as const)
			it(`reads ${surface} \`location_id\` and \`hq_user_id\` from an upload question as the upload question's write, as any key from one reads`, async () => {
				const doc = fixture();
				// The pair: a key HQ's server keeps as a property, read from the image question.
				const plain = await fromPhoto(doc, "size", stored);
				expect(codesOf(plain)).toEqual([UPLOAD]);
				expect(plain.outcome.defects).toEqual([]);
				for (const key of ["location_id", "hq_user_id"]) {
					const reading = await fromPhoto(doc, key, stored);
					expect(reading.outcome.defects, key).toEqual([]);
					expect(codesOf(reading), key).toEqual([UPLOAD]);
					expect(reading.findings[0]?.detail?.name, key).toBe(key);
				}
			});

		it("reads the worker's load whose one write is from an upload question as that write's finding alone, never as a load writing nothing", async () => {
			const { doc, formUuid } = memberFollowup([
				{
					uuid: OP("worker"),
					id: "commcare_user",
					action: "update",
					caseType: "commcare-user",
					target: { kind: "worker-record" },
					writes: [{ property: "last_household", value: read("name") }],
				},
			]);
			const workerLoad = (app: MenuAppJson) => {
				const worker = actionsOf(app).load_update_cases.find(
					(load) => load.auto_select !== null,
				);
				if (worker === undefined)
					throw new Error("The form loads the worker's record.");
				return worker;
			};
			for (const key of ["last_household", "location_id", "hq_user_id"]) {
				const reading = await fromPhoto(
					withPhoto({ doc, formUuid }),
					key,
					workerLoad,
					true,
				);
				expect(reading.outcome.defects, key).toEqual([]);
				expect(codesOf(reading), key).toEqual([UPLOAD]);
			}
		});
	});

	it("reads an open action that names Nova's owner node of no owner as unowned", async () => {
		const { doc } = registration([
			{
				uuid: OP("pet"),
				id: "pet",
				action: "create",
				caseType: "pet",
				target: { kind: "new" },
				name: read("name"),
				owner: unowned(),
			},
		]);
		const reading = await readCases(doc);
		const pet = reading.forms
			.flatMap((form) => form.form.caseOperations ?? [])
			.find((operation) => operation.action === "create");
		expect(pet?.owner).toEqual(unowned());
	});

	it("reads an open action whose indices are all extensions and that names no owner as unowned, as HQ's build leaves it", async () => {
		const extension = (owner?: CaseOperation["owner"]): CaseOperation => ({
			...kid,
			...(owner !== undefined && { owner }),
			links: (kid.links ?? []).map((link) => ({
				...link,
				relationship: "extension" as const,
			})),
		});
		// Nova's export of an unowned extension case names no `owner_id`, the
		// shape HQ's page stores for one (`autoset_owner_id_for_advanced_action`).
		const { doc } = registration([extension(unowned())]);
		const opens = (app: AppJson) => actionsOf(app).open_cases;
		let stored: Record<string, unknown> | undefined;
		const reading = await readCases(doc, {
			edit: (app) => {
				stored = opens(app)[1]?.case_properties as Record<string, unknown>;
			},
		});
		expect(stored).toBeDefined();
		expect(stored).not.toHaveProperty("owner_id");
		expect(actionFindings(reading)).toEqual([]);
		expect(findingCodes(reading)).toEqual([]);
		const member = reading.forms
			.flatMap((form) => form.form.caseOperations ?? [])
			.find((operation) => operation.action === "create");
		expect(member?.owner).toEqual(unowned());
		// The worker's extension case carries Nova's owner node, which reads as no owner.
		const worker = await readCases(registration([extension()]).doc);
		expect(actionFindings(worker)).toEqual([]);
		expect(
			worker.forms
				.flatMap((form) => form.form.caseOperations ?? [])
				.find((operation) => operation.action === "create")?.owner,
		).toBeUndefined();
	});

	describe("a preload on an earlier load, which HQ's build reads from that load's own case", () => {
		const OTHER_CASE = `${F}/index-path-through-a-case-type-the-app-does-not-fix`;
		/** The form's stored actions with a preload of the case's name into `name` on load `at`. */
		const preloadOn = (at: number) => (app: MenuAppJson) => {
			const load = actionsOf(app).load_update_cases[at] as Record<
				string,
				unknown
			>;
			load.preload = { "/data/name": "name" };
		};
		/** The default a whole reading gives the form under test's question `name`. */
		const nameDefault = (doc: BlueprintDoc | undefined) =>
			(
				Object.values(doc?.fields ?? {}).find((field) => field.id === "name") as
					| { readonly default_value?: unknown }
					| undefined
			)?.default_value;
		const householdName = {
			kind: "term",
			term: { kind: "form-case", caseType: "household", property: "case_name" },
		};
		/** Visits chosen under Members, which holds households chosen under a household:
		 *  the chain household, household, visit, the form's own last. */
		const visitUnderTwoHouseholds = () =>
			advancedFixture({
				formType: "followup",
				menu: "visits",
				configure: (built) => {
					built.modules[MEMBERS] = {
						...built.modules[MEMBERS],
						caseType: "household",
					} as never;
					built.modules[VISITS] = {
						...built.modules[VISITS],
						parentCaseModuleUuid: MEMBERS,
					} as never;
				},
				operations: () => [
					{
						uuid: OP("own"),
						id: "visit",
						action: "own",
						writes: [{ property: "remark", value: read("name") }],
					},
				],
			});

		it("reads it as the read of the load's case type where the type sits that deep", async () => {
			const { doc } = memberFollowup();
			const reading = await readMenusOf(doc, preloadOn(0));
			expect(codesOf(reading)).toEqual([]);
			expect(nameDefault(reading.doc)).toEqual(householdName);
		});

		it("refuses a preloaded property HQ's build refuses, and reads `owner_id`, which it does not", async () => {
			// `LoadUpdateAction.get_property_names` → `check_case_properties`: a reserved word or a
			// name outside the grammar keeps the form out of HQ's build.
			const { doc } = memberFollowup();
			const ILLEGAL = `${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`;
			for (const property of ["status", "case_type", "dob+1"]) {
				const reading = await readMenusOf(doc, (app) => {
					const load = actionsOf(app).load_update_cases[0] as Record<
						string,
						unknown
					>;
					load.preload = { "/data/name": property };
				});
				expect(codesOf(reading), property).toContain(ILLEGAL);
			}
			const owner = await readMenusOf(doc, (app) => {
				const load = actionsOf(app).load_update_cases[0] as Record<
					string,
					unknown
				>;
				load.preload = { "/data/name": "owner_id" };
			});
			expect(codesOf(owner)).toEqual([]);
			expect(nameDefault(owner.doc)).toEqual({
				kind: "term",
				term: {
					kind: "form-case",
					caseType: "household",
					property: "owner_id",
				},
			});
		});

		it("reads a property HQ's grammar takes for its trailing newline as the element CommCare reads", async () => {
			// `validate_property` matches with `re.match` and a closing `$`, which takes one
			// trailing newline; HQ's build maps neither `name` nor `owner_id` spelled so, and
			// Core's lexer drops the newline: the load reads the child element of the name.
			const { doc } = memberFollowup();
			const preloadOf = (property: string) =>
				readMenusOf(doc, (app) => {
					const load = actionsOf(app).load_update_cases[0] as Record<
						string,
						unknown
					>;
					load.preload = { "/data/name": property };
				});
			const named = await preloadOf("case_name\n");
			expect(codesOf(named)).toEqual([]);
			expect(nameDefault(named.doc)).toEqual(householdName);
			expect(named.doc).toEqual((await preloadOf("name")).doc);
			const UNNAMED =
				"expressions-and-data/a-form-expression-outside-what-nova-types";
			for (const property of ["name\n", "status\n", "owner_id\n"]) {
				const reading = await preloadOf(property);
				expect(codesOf(reading), property).toContain(UNNAMED);
				expect(codesOf(reading), property).not.toContain(
					`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
				);
				expect(reading.outcome.defects, property).toEqual([]);
			}
		});

		it("reads one on the load next to the own where the load before it shares its type", async () => {
			const { doc } = visitUnderTwoHouseholds();
			const plain = await readMenusOf(doc, (app) => {
				expect(
					actionsOf(app).load_update_cases.map((one) => one.case_type),
				).toEqual(["household", "household", "visit"]);
			});
			expect(codesOf(plain)).toEqual([]);
			// The read walks one `parent` index from the visit: the household HQ reads it from.
			const reading = await readMenusOf(doc, preloadOn(1));
			expect(codesOf(reading)).toEqual([]);
			expect(nameDefault(reading.doc)).toEqual(householdName);
		});

		it("refuses one on a load the read of its type does not reach, a nearer load holding that type", async () => {
			const { doc } = visitUnderTwoHouseholds();
			const reading = await readMenusOf(doc, preloadOn(0));
			expect(codesOf(reading).filter((code) => code === OTHER_CASE)).toEqual([
				OTHER_CASE,
			]);
			// Members holds households too: a household chosen under a household.
			const { doc: twoHouseholds } = advancedFixture({
				formType: "followup",
				menu: "members",
				configure: (built) => {
					built.modules[MEMBERS] = {
						...built.modules[MEMBERS],
						caseType: "household",
					} as never;
				},
				operations: () => [
					{
						uuid: OP("own"),
						id: "household",
						action: "own",
						writes: [{ property: "remark", value: read("name") }],
					},
				],
			});
			expect(codesOf(await readMenusOf(twoHouseholds))).toEqual([]);
			const own = await readMenusOf(twoHouseholds, preloadOn(0));
			expect(codesOf(own).filter((code) => code === OTHER_CASE)).toEqual([
				OTHER_CASE,
			]);
		});

		it("reads one reached through an index other than `parent` where the read walks that index", async () => {
			// The app links a member to its household as `mother`, so Nova's chain chooses
			// the member by that index, and a read of the household walks `index/mother`
			// from the member (`caseTypeDepths.ts::caseTypeHopMap`): the case HQ loads.
			const { doc } = advancedFixture({
				formType: "followup",
				menu: "members",
				configure: (built) => {
					const remark = built.fieldOrder[HOUSEHOLD_VISIT]?.[0] as Uuid;
					built.forms[HOUSEHOLD_VISIT] = {
						...built.forms[HOUSEHOLD_VISIT],
						caseOperations: [
							{
								uuid: OP("baby"),
								id: "baby",
								action: "create",
								caseType: "member",
								target: { kind: "new" },
								name: term(formField(remark)),
								links: [
									{
										identifier: "mother",
										targetType: "household",
										target: { kind: "session" },
										relationship: "child",
									},
								],
							},
						],
					} as never;
				},
				operations: () => [
					{
						uuid: OP("own"),
						id: "member",
						action: "own",
						writes: [{ property: "age", value: read("age") }],
					},
				],
			});
			const plain = await readMenusOf(doc, (app) => {
				const [, own] = actionsOf(app).load_update_cases;
				const index = own?.case_index as
					| { readonly reference_id?: unknown }
					| undefined;
				expect(index?.reference_id).toBe("mother");
			});
			expect(codesOf(plain)).toEqual([]);
			const reading = await readMenusOf(doc, preloadOn(0));
			expect(codesOf(reading)).toEqual([]);
			expect(nameDefault(reading.doc)).toEqual(householdName);
		});

		it("refuses one reached through an index the app's links do not name, which the read does not walk", async () => {
			// No link of the app joins a member to its household, so a read of the household
			// walks `index/parent`; HQ chose the member by `index/mother`.
			const { doc } = memberFollowup();
			const reading = await readMenusOf(doc, (app) => {
				const [, own] = actionsOf(app).load_update_cases;
				(own?.case_index as Record<string, unknown>).reference_id = "mother";
				preloadOn(0)(app);
			});
			expect(codesOf(reading)).toContain(OTHER_CASE);
			expect(reading.outcome.defects).toEqual([]);
		});
	});

	it("refuses an auto-selected load in a mode Nova does not hold", async () => {
		const { doc } = memberFollowup([
			{
				uuid: OP("worker"),
				id: "commcare_user",
				action: "update",
				caseType: "commcare-user",
				target: { kind: "worker-record" },
				writes: [{ property: "last_household", value: read("name") }],
			},
		]);
		const reading = await readCases(doc, {
			edit: (app) => {
				const worker = actionsOf(app).load_update_cases.find(
					(load) => load.auto_select !== null,
				);
				if (worker === undefined)
					throw new Error("The form loads the worker's record.");
				worker.auto_select = {
					doc_type: "AutoSelectCase",
					mode: "user",
					value_source: "",
					value_key: "district",
				};
			},
		});
		expect(findingCodes(reading)).toContain(`${F}/auto-select-mode-user`);
	});

	it("claims every key of the worker's load Nova writes, and refuses one indexed to another load", async () => {
		const { doc } = memberFollowup([
			{
				uuid: OP("worker"),
				id: "commcare_user",
				action: "update",
				caseType: "commcare-user",
				target: { kind: "worker-record" },
				writes: [{ property: "last_household", value: read("name") }],
			},
		]);
		const whole = await readCases(doc);
		expect(actionFindings(whole)).toEqual([]);
		const indexed = await readCases(doc, {
			edit: (app) => {
				const loads = actionsOf(app).load_update_cases;
				const worker = loads.find((load) => load.auto_select !== null);
				if (worker === undefined)
					throw new Error("The form loads the worker's record.");
				worker.case_index = {
					doc_type: "CaseIndex",
					tag: loads[0]?.case_tag,
					reference_id: "parent",
					relationship: "child",
					relationship_question: "",
				};
			},
		});
		expect(findingCodes(indexed)).toContain(
			`${F}/loadupdateaction-case-index-on-an-auto-selected-load-or-on-the`,
		);
	});

	it("refuses open actions of one repeat that share the row's block, and reads them where two are indexed", async () => {
		const visit: CaseOperation = {
			uuid: OP("kid-visit"),
			id: "visit",
			action: "create",
			caseType: "visit",
			target: { kind: "new" },
			name: read("kid_name"),
			forEach: { repeat: U("kids") },
			links: [
				{
					identifier: "member",
					targetType: "member",
					target: { kind: "op", opUuid: OP("kid") },
					relationship: "child",
				},
			],
		};
		const { doc } = registration([kid, visit]);
		const nested = await readCases(doc);
		expect(actionFindings(nested)).toEqual([]);
		// One of the two indexed: HQ's build writes both blocks at the row's one `case`.
		const shared = await readCases(doc, {
			edit: (app) => {
				const open = actionsOf(app).open_cases.find(
					(one) => one.case_type === "visit",
				);
				if (open === undefined) throw new Error("The form opens a visit.");
				open.case_indices = [];
			},
		});
		expect(findingCodes(shared)).toContain(
			`${F}/two-or-more-open-actions-whose-repeat-context-is-one-repeat`,
		);
	});

	it("raises one finding at an advanced menu Nova would write basic", async () => {
		// Two index names between members and households: no one chain index.
		const { doc } = memberFollowup([
			{
				uuid: OP("parent"),
				id: "household",
				action: "update",
				caseType: "household",
				target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
				writes: [{ property: "remark", value: read("name") }],
			},
		]);
		const reading = await readCases(doc);
		const members = reading.ctx.draft.modules.find(
			(module) => module.module.name === doc.modules[MEMBERS]?.name,
		);
		if (members === undefined)
			throw new Error("The app holds the members menu.");
		const blocked = {
			...doc,
			forms: {
				...doc.forms,
				...Object.fromEntries(
					Object.entries(doc.forms).map(([uuid, form]) => [
						uuid,
						form.type === "registration" || form.type === "survey"
							? form
							: {
									...form,
									caseOperations: [
										...(form.caseOperations ?? []),
										...(["parent", "household"] as const).map(
											(identifier): CaseOperation => ({
												uuid: OP(`link-${uuid}-${identifier}`),
												id: `link_${identifier}`,
												action: "create",
												caseType: "member",
												target: { kind: "new" },
												name: read("name"),
												links: [
													{
														identifier,
														targetType: "household",
														target: { kind: "session" },
														relationship: "child",
													},
												],
											}),
										),
									],
								},
					]),
				),
			},
		};
		const before = reading.ctx.accounting.findings().length;
		settleAdvancedMenu(reading.ctx, blocked, { ...members, uuid: MEMBERS });
		const raised = reading.ctx.accounting.findings().slice(before);
		expect(raised.map((one) => one.code)).toEqual([
			"menus-and-case-lists/advanced-module-nova-would-write-as-a-basic-one",
		]);
	});

	for (const [why, change] of [
		[
			"whose forms read the search",
			{ caseSearchConfig: { formsReadSearch: true } },
		],
		[
			"whose case list menu item is narrowed (its cases are chosen after a parent's)",
			{ caseListMenuItem: {} },
		],
	] as const)
		it(`raises one finding at an advanced menu ${why}`, async () => {
			const { doc } = memberFollowup();
			const reading = await readCases(doc);
			const members = reading.ctx.draft.modules.find(
				(module) => module.module.name === doc.modules[MEMBERS]?.name,
			);
			if (members === undefined)
				throw new Error("The app holds the members menu.");
			const blocked = {
				...doc,
				modules: {
					...doc.modules,
					[MEMBERS]: { ...doc.modules[MEMBERS], ...change },
				},
			} as typeof doc;
			const before = reading.ctx.accounting.findings().length;
			settleAdvancedMenu(reading.ctx, blocked, { ...members, uuid: MEMBERS });
			const raised = reading.ctx.accounting.findings().slice(before);
			expect(raised.map((one) => [one.code, one.place.kind])).toEqual([
				[
					"menus-and-case-lists/advanced-module-nova-would-write-as-a-basic-one",
					"menu",
				],
			]);
		});

	it("reads an open action with a close back with the close sharing its place", async () => {
		const { doc } = registration([kid]);
		const reading = await readCases(doc, {
			edit: (app) => {
				const open = actionsOf(app).open_cases.find(
					(one) => one.case_type === "member",
				);
				if (open === undefined) throw new Error("The form opens a member.");
				open.close_condition = {
					type: "always",
					doc_type: "FormActionCondition",
				};
			},
		});
		const operations = reading.forms.flatMap(
			(form) => form.form.caseOperations ?? [],
		);
		const create = operations.find(
			(one) => one.action === "create" && one.caseType === "member",
		);
		const close = operations.find((one) => one.action === "close");
		expect(close?.target).toEqual({ kind: "op", opUuid: create?.uuid });
		expect(close?.placement).toBeUndefined();
		expect(findingCodes(reading).filter((code) => code.startsWith(F))).toEqual(
			[],
		);
	});

	it("raises the tag entry for a load that changes no case tagged after the menu's case type", async () => {
		const { doc } = memberFollowup();
		const reading = await readMenusOf(doc, (app) => {
			const loads = actionsOf(app as unknown as AppJson).load_update_cases;
			const [parent, own] = loads;
			if (parent === undefined || own === undefined)
				throw new Error("The form loads a parent and its own case.");
			const old = parent.case_tag as string;
			// HQ's page names a new load after the menu's case type, whatever the load's.
			parent.case_tag = "load_member0";
			const index = own.case_index as Record<string, unknown>;
			if (index.tag !== old)
				throw new Error("The own load names the parent's tag.");
			index.tag = "load_member0";
		});
		expect(menuCodes(reading)).toContain(
			`${F}/load-changing-no-case-with-a-tag-nova-does-not-derive`,
		);
		expect(menuCodes(reading)).not.toContain(
			`${F}/advanced-form-loads-other-than-its-menu-s-one-chain`,
		);
	});

	it("raises the chain entry where two forms of one menu load different chains", async () => {
		const { doc } = memberFollowup();
		const reading = await readMenusOf(doc, (app) => {
			const module = app.modules.find((one) =>
				one.forms.some((form) =>
					JSON.stringify(form.name).includes("Under test"),
				),
			);
			const form = module?.forms.find((one) =>
				JSON.stringify(one.name).includes("Under test"),
			);
			if (module === undefined || form === undefined)
				throw new Error("The app holds the form under test.");
			// A second form of the menu, as HQ's page copies one, whose own load chooses its case
			// with no parent first.
			const copy = JSON.parse(JSON.stringify(form)) as Record<string, unknown>;
			const attachments = app._attachments as Record<string, string>;
			const source = attachments[`${form.unique_id as string}.xml`] as string;
			copy.unique_id = "0123456789abcdef0123456789abcde0";
			copy.xmlns =
				"http://openrosa.org/formdesigner/0123456789ABCDEF0123456789ABCDE0";
			copy.name = { en: "Second" };
			attachments[`${copy.unique_id as string}.xml`] = source.replace(
				form.xmlns as string,
				copy.xmlns as string,
			);
			const loads = (
				copy.actions as { load_update_cases: Record<string, unknown>[] }
			).load_update_cases;
			const own = loads[loads.length - 1] as Record<string, unknown>;
			own.case_index = {
				doc_type: "CaseIndex",
				tag: "",
				reference_id: "parent",
				relationship: "child",
			};
			(
				copy.actions as { load_update_cases: Record<string, unknown>[] }
			).load_update_cases = [own];
			module.forms.push(copy);
		});
		expect(menuCodes(reading)).toContain(
			`${F}/advanced-form-loads-other-than-its-menu-s-one-chain`,
		);
	});
});

describe("a chain through a basic menu", () => {
	it("reads the chain of an advanced menu chosen under a basic menu with its own parent selection, where the selections are the only evidence of the parent types", async () => {
		// No form links a member to a household or a visit to a member: the two parent types are
		// the catalog's, and the menus' parent selections are all a reading has of them.
		const followup = (name: string, caseType: string) => ({
			name,
			type: "followup" as const,
			fields: [
				f({
					kind: "text",
					id: "note",
					caseWrite: { caseType, property: "note" },
				}),
			],
		});
		const doc = produce(
			buildDoc({
				caseTypes: [
					{ name: "household", properties: [] },
					{ name: "member", parent_type: "household", properties: [] },
					{ name: "visit", parent_type: "member", properties: [] },
				],
				modules: [
					{
						uuid: "chain-households",
						name: "Households",
						caseType: "household",
						forms: [
							{
								name: "Add household",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "name",
										caseWrite: { caseType: "household", property: "case_name" },
									}),
								],
							},
						],
					},
					{
						uuid: "chain-members",
						name: "Members",
						caseType: "member",
						parentCaseModuleUuid: "chain-households",
						forms: [followup("Check member", "member")],
					},
					{
						uuid: "chain-visits",
						name: "Visits",
						caseType: "visit",
						parentCaseModuleUuid: "chain-members",
						forms: [followup("Review visit", "visit")],
					},
				],
			}),
			(draft) => {
				const visits = draft.modules[testUuid("chain-visits")];
				if (visits !== undefined) visits.heldKind = "advanced";
			},
		);
		const reading = await readMenusOf(doc);
		expect(menuCodes(reading)).toEqual([]);
		const read = reading.doc as BlueprintDoc;
		const named = (name: string) =>
			Object.values(read.modules).find((one) => one.name === name);
		expect(named("Visits")?.heldKind).toBe("advanced");
		expect(named("Visits")?.parentCaseModuleUuid).toBe(named("Members")?.uuid);
		expect(named("Members")?.parentCaseModuleUuid).toBe(
			named("Households")?.uuid,
		);
		const parentOf = (name: string) =>
			read.caseTypes?.find((type) => type.name === name)?.parent_type;
		expect([parentOf("member"), parentOf("visit")]).toEqual([
			"household",
			"member",
		]);
		// The loads the reading's chain gives are the ones the source stores, tag by tag.
		const visitsUuid = named("Visits")?.uuid as string;
		const form = read.formOrder[visitsUuid]?.[0];
		const planned = planFormCaseWire(read, form as never);
		const visitsForm = reading.app.modules[2]?.forms[0];
		if (visitsForm === undefined) throw new Error("The source holds the form.");
		const stored = (
			visitsForm.actions as {
				load_update_cases: { case_tag: string; case_type: string }[];
			}
		).load_update_cases;
		expect(
			planned.kind === "advanced" &&
				planned.actions.load_update_cases.map((load) => [
					load.case_tag,
					load.case_type,
				]),
		).toEqual(stored.map((load) => [load.case_tag, load.case_type]));
		expect(stored.map((load) => load.case_type)).toEqual([
			"household",
			"member",
			"visit",
		]);
	});
});

/** An open action of a member, its one index under `parent` to the action tagged `tag`. */
function memberOpen(
	tag: string,
	relationship: "child" | "extension",
): Record<string, unknown> {
	const condition = (type: string) => ({
		type,
		question: null,
		answer: null,
		operator: "=",
		doc_type: "FormActionCondition",
	});
	return {
		doc_type: "AdvancedOpenCaseAction",
		case_type: "member",
		case_tag: "open_member_0",
		name_update: {
			question_path: "/data/name",
			update_mode: "always",
			doc_type: "ConditionalCaseUpdate",
		},
		case_properties: {},
		repeat_context: "",
		case_indices: [
			{
				tag,
				reference_id: "parent",
				relationship,
				relationship_question: "",
				doc_type: "CaseIndex",
			},
		],
		open_condition: condition("always"),
		close_condition: condition("never"),
	};
}

describe("an open action's index beside the menus' parent selection", () => {
	it("refuses a parent index to another type or as an extension once, at the form", async () => {
		const { doc } = memberFollowup();
		for (const relationship of ["child", "extension"] as const) {
			const reading = await readMenusOf(doc, (app) => {
				const actions = actionsOf(app);
				const loads = actions.load_update_cases;
				// The member's own load as its parent, or the household load as an extension's.
				const tag = String(
					(relationship === "child" ? loads[loads.length - 1] : loads[0])
						?.case_tag,
				);
				actions.open_cases = [memberOpen(tag, relationship)];
			});
			expect(reading.outcome.defects, relationship).toEqual([]);
			expect(codesOf(reading), relationship).toEqual([
				`${F}/an-advanced-open-action-s-parent-index-against-a-menu-s-parent-selection`,
			]);
			expect(reading.findings[0]?.place.kind).toBe("form");
		}
	});

	it("stands an index to a refused load under that load's finding", async () => {
		const { doc } = memberFollowup();
		const reading = await readMenusOf(doc, (app) => {
			const actions = actionsOf(app);
			const [household] = actions.load_update_cases;
			actions.load_update_cases = [household as Record<string, unknown>];
			actions.open_cases = [memberOpen(String(household?.case_tag), "child")];
		});
		expect(reading.outcome.defects).toEqual([]);
		expect(codesOf(reading)).toContain(
			`${F}/advanced-form-loads-other-than-its-menu-s-one-chain`,
		);
		expect(codesOf(reading)).not.toContain("unrecognized:schema:CaseIndex.tag");
	});
});

function menuCodes(reading: Awaited<ReturnType<typeof readMenusOf>>): string[] {
	return reading.findings.map((one) => one.code);
}
