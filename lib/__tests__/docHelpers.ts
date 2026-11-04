/**
 * Domain-native test fixture builders.
 *
 * Tests should construct `BlueprintDoc` shapes directly — no wire-format
 * round-trip. `buildDoc` accepts a concise nested spec that mirrors the
 * shape most tests want to express (modules → forms → fields) and emits a
 * fully normalized `BlueprintDoc` ready to feed to the validator.
 *
 * `f()` builds a single `Field` with an auto-assigned uuid and sensible
 * default label; override any property by passing it in the patch. The
 * shape is union-wide on purpose — callers pick the `kind` and provide
 * whatever keys that variant supports.
 *
 * A field spec may still say where its answer is saved,
 * `caseWrite: { caseType, property }`, though a field holds no destination:
 * a form saves case data only through its case operations. `buildDoc`
 * lowers the sugar through the one "Saves to" planner
 * (`fieldCaseWriteMutations.ts::planFieldCaseWrite`) once the doc is
 * assembled, so a fixture keeps stating the content it means.
 */

import { Immer } from "immer";
import { testUuid } from "@/__tests__/helpers/uuid";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { planExplicitPreloads } from "@/lib/doc/explicitPreloads";
import {
	nameFirstWithinBuckets,
	nearestRepeatOf,
	planFieldCaseWrite,
} from "@/lib/doc/fieldCaseWriteMutations";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { operationsFromFieldWrites } from "@/lib/doc/fieldWriteOperations";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppSettings,
	type BlueprintDoc,
	type CaseOperation,
	type CaseProperty,
	type CaseType,
	type ConnectType,
	contentRunsOn,
	type Field,
	type FieldKind,
	type Form,
	type FormLink,
	isCaptureField,
	isContainerKindName,
	type Module,
	NEW_APP_SETTINGS,
	ownCaseOperationId,
	PLATFORMS,
	type ProseTemplate,
	plainColumn,
	propertyAgreedType,
	proseText,
	type UserCollections,
	type Uuid,
	unavailableUses,
	wholeNumberStartsOnDecimal,
	writerOffersPreload,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression/builders";
import {
	type FormStructure,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import {
	type ExpressionCarrierRef,
	expressionSlotKey,
	expressionSlotValue,
	rewriteExpressionSlotValues,
} from "@/lib/domain/referenceSlots";

/** Parse source only in the actual slot that will store it. */
export function parseFixtureExpression(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	text: string,
): Expression {
	const parsed = parseFormExpression(text, {
		doc: { ...doc },
		slot,
		lookup: "unavailable",
	});
	if (!parsed.ok)
		throw new Error(parsed.issues.map((issue) => issue.message).join("\n"));
	if (parsed.expression === undefined)
		throw new Error("A fixture expression cannot be empty.");
	return parsed.expression;
}

/** Monotonic counter keeps auto-assigned uuids stable + readable per test run. */
let counter = 0;
function nextUuid(prefix: string): Uuid {
	counter++;
	return testUuid(`${prefix}-${counter.toString().padStart(4, "0")}`);
}

/**
 * Build a single domain `Field` spec with an auto-assigned uuid.
 *
 * The default `label` mirrors `id` so text/int/etc. fixtures work without
 * callers having to spell the label every time. Container kinds (group,
 * repeat) accept a `children` spec that this helper converts into nested
 * `Field[]` by recursion.
 *
 * Intentionally permissive: tests often need to construct shapes that
 * violate the discriminated union to exercise error paths (e.g. setting
 * `validate_msg` on a label). The helper accepts arbitrary keys so those
 * fixtures can be expressed directly.
 */
export function f(spec: FieldSpec): FieldSpec {
	return spec;
}

/** A spec for a single field (possibly with nested children). */
export type FieldSpec = {
	kind: FieldKind;
	id: string;
	uuid?: string;
	label?: string | ProseTemplate;
	children?: FieldSpec[];
	[key: string]: unknown;
};

/** A spec for a single form. Fields are given as a nested list. */
export interface FormSpec {
	uuid?: string;
	id?: string;
	name: string;
	type: Form["type"];
	purpose?: string;
	displayCondition?: Form["displayCondition"];
	/** When a registration creates its case. Source text is parsed in the
	 *  `form_open_condition` slot against the assembled doc. */
	openCondition?: string | Expression;
	/** When the form closes its own case. Source text is parsed in the
	 *  `form_close_condition` slot against the assembled doc. */
	closeCondition?: string | Expression;
	connect?: Form["connect"];
	postSubmit?: Form["postSubmit"];
	/** Where the form goes when no destination that may not run runs, in
	 *  its stored shape, beside `formLinks`. */
	otherwise?: Form["otherwise"];
	/** Authored with string conditions/datum XPaths (the concise spec
	 *  shape); `buildDoc` parses them against the assembled form. A link's
	 *  `uuid` is auto-minted when the spec omits it, like a field's. */
	formLinks?: Array<{
		uuid?: string;
		condition?: string | Expression;
		target: FormLink["target"];
		datums?: Array<{
			name: NonNullable<FormLink["datums"]>[number]["name"];
			xpath: string | Expression;
		}>;
	}>;
	fields?: FieldSpec[];
}

/**
 * A case-list config as a FIXTURE writes one: the two ordering arrays are
 * optional, and a config that omits them means "both screens show the columns
 * in the order I wrote them".
 *
 * The domain type requires both arrays, because in a real doc a sequence that
 * is merely absent would mean "derive it somehow" — the ambiguity array
 * position exists to remove. A fixture is not a real doc: it writes the
 * columns in visual order because that's how a person reads a test. So the
 * spec accepts the shorthand and `buildDoc` resolves it to the real shape,
 * which keeps the derivation in ONE place instead of in every fixture.
 */
export type CaseListConfigSpec = Omit<
	NonNullable<Module["caseListConfig"]>,
	"listColumnOrder" | "detailColumnOrder"
> &
	Partial<
		Pick<
			NonNullable<Module["caseListConfig"]>,
			"listColumnOrder" | "detailColumnOrder"
		>
	>;

/**
 * Resolve a fixture's case-list config to the domain shape, filling either
 * ordering array it left out with the written column order.
 */
export function resolveCaseListConfig(
	spec: CaseListConfigSpec,
): NonNullable<Module["caseListConfig"]> {
	const written = spec.columns.map((column) => column.uuid);
	return {
		...spec,
		listColumnOrder: spec.listColumnOrder ?? written,
		detailColumnOrder: spec.detailColumnOrder ?? [...written],
	};
}

/** A spec for a single module. Forms are nested; case-list columns are optional. */
export interface ModuleSpec {
	uuid?: string;
	id?: string;
	name: string;
	caseType?: string;
	caseListMenuItem?: Module["caseListMenuItem"];
	/** The module's case list registration form, named by its form spec's
	 *  `uuid` label (resolved through `testUuid`). */
	caseListRegistrationForm?: { formUuid: string; label?: string };
	parentCaseModuleUuid?: string;
	purpose?: string;
	displayCondition?: Module["displayCondition"];
	caseListConfig?: CaseListConfigSpec;
	caseSearchConfig?: Module["caseSearchConfig"];
	forms?: FormSpec[];
}

/**
 * Build a `CaseListConfig` snapshot from a flat `{field, header}[]`
 * column list. Tests construct columns this way overwhelmingly often
 * (every fixture builds the simplest case-list shape), so the helper
 * keeps fixtures concise without forcing each test to spell the
 * empty `searchInputs` array itself.
 *
 * Each entry becomes a `kind: "plain"` column with an auto-assigned
 * `uuid`. The helper short-circuits the schema's identity slot so
 * fixtures that don't care about column identity stay compact —
 * fixtures that DO care (drag-reorder tests, sort-on-column lookups)
 * pass `plainColumn(uuid, field, header)` directly.
 */
export function caseListConfig(
	columns: ReadonlyArray<{ field: string; header: string }>,
): NonNullable<Module["caseListConfig"]> {
	const built = columns.map((c) =>
		plainColumn(nextUuid("col"), c.field, c.header),
	);
	// Both screens show the columns in the order the fixture wrote them. A
	// column belongs to Results and Details from birth, so a config cannot be
	// built with one missing from either.
	const sequence = built.map((column) => column.uuid);
	return {
		columns: built,
		listColumnOrder: sequence,
		detailColumnOrder: [...sequence],
		searchInputs: [],
	};
}

/**
 * Give a doc's three user collections the ordering arrays their records imply,
 * in whatever order the fixture wrote the record's keys.
 *
 * A real doc's record and its sequence cannot disagree — `assembleBlueprint`
 * throws on exactly that — but a fixture assembles the doc by hand, so a
 * record written without its array reads back as an EMPTY collection and the
 * test silently exercises nothing. This is the one place to spell the pairing,
 * so a fixture can keep writing just the records.
 */
export function withUserSequences<T extends UserCollections>(doc: T): T {
	const sequenceOf = (record: Record<string, unknown> | undefined) =>
		Object.keys(record ?? {}) as Uuid[];
	return {
		...doc,
		...(doc.userProperties !== undefined && {
			userPropertyOrder: sequenceOf(doc.userProperties),
		}),
		...(doc.userTypes !== undefined && {
			userTypeOrder: sequenceOf(doc.userTypes),
		}),
		...(doc.personas !== undefined && {
			personaOrder: sequenceOf(doc.personas),
		}),
	};
}

/** Top-level spec. Mirrors the `BlueprintDoc` shape minus ordering/entity maps. */
export interface DocSpec {
	appId?: string;
	appName?: string;
	connectType?: ConnectType | null;
	caseTypes?: FixtureCaseType[] | null;
	/** Defaults to a new app's settings, both lists off, declaring the
	 * platforms the content runs on (`contentRunsOn`). A spec that gives
	 * `appSettings` is used as given. */
	appSettings?: AppSettings;
	modules?: ModuleSpec[];
}

type FixtureProse = string | ProseTemplate;
type FixtureCaseProperty = Omit<CaseProperty, "label" | "hint" | "options"> & {
	label: FixtureProse;
	hint?: FixtureProse;
	options?: Array<
		Omit<NonNullable<CaseProperty["options"]>[number], "label"> & {
			label: FixtureProse;
		}
	>;
};
type FixtureCaseType = Omit<CaseType, "properties"> & {
	properties: FixtureCaseProperty[];
};

/**
 * Build a fully normalized `BlueprintDoc` from a concise nested spec.
 *
 * Every uuid is auto-assigned unless the spec provides one. The resulting
 * doc has a populated `fieldParent` reverse index so tests that read that
 * field work without a separate bootstrap step.
 *
 * Field specs are flattened into the doc's `fields` map and their parent/
 * child relationships are captured in `fieldOrder`. Container kinds carry
 * a (possibly empty) `fieldOrder` entry; leaves do not.
 *
 * A spec that gives no `appSettings` declares the platforms its content runs
 * on, read after `configure` (`contentRunsOn`): one platform where a feature
 * the other can't run is held, both otherwise, and a content that runs on
 * neither is refused, since the gate would refuse it on every declaration.
 * So each fixture keeps its meaning without stating a platform; a test of
 * the declaration gives `appSettings` itself.
 */
export function buildDoc(
	spec: DocSpec = {},
	configure?: (doc: BlueprintDoc) => void,
): BlueprintDoc {
	const modules: BlueprintDoc["modules"] = {};
	const forms: BlueprintDoc["forms"] = {};
	const fields: BlueprintDoc["fields"] = {};
	const moduleOrder: Uuid[] = [];
	const formOrder: BlueprintDoc["formOrder"] = {};
	const fieldOrder: BlueprintDoc["fieldOrder"] = {};
	const caseWrites: FixtureCaseWrites = new Map();

	for (const modSpec of spec.modules ?? []) {
		const moduleUuid = testUuid(modSpec.uuid ?? nextUuid("mod"));
		moduleOrder.push(moduleUuid);
		formOrder[moduleUuid] = [];

		modules[moduleUuid] = {
			uuid: moduleUuid,
			id: modSpec.id ?? modSpec.name.toLowerCase().replace(/\s+/g, "_"),
			name: modSpec.name,
			...(modSpec.caseType !== undefined && { caseType: modSpec.caseType }),
			...(modSpec.parentCaseModuleUuid !== undefined && {
				parentCaseModuleUuid: testUuid(modSpec.parentCaseModuleUuid),
			}),
			...(modSpec.caseListMenuItem !== undefined && {
				caseListMenuItem: modSpec.caseListMenuItem,
			}),
			...(modSpec.caseListRegistrationForm !== undefined && {
				caseListRegistrationForm: {
					kind: "after-empty-search" as const,
					formUuid: testUuid(modSpec.caseListRegistrationForm.formUuid),
					...(modSpec.caseListRegistrationForm.label !== undefined && {
						label: modSpec.caseListRegistrationForm.label,
					}),
				},
			}),
			...(modSpec.purpose !== undefined && { purpose: modSpec.purpose }),
			...(modSpec.displayCondition !== undefined && {
				displayCondition: modSpec.displayCondition,
			}),
			...(modSpec.caseListConfig !== undefined && {
				caseListConfig: resolveCaseListConfig(modSpec.caseListConfig),
			}),
			...(modSpec.caseSearchConfig !== undefined && {
				caseSearchConfig: modSpec.caseSearchConfig,
			}),
		};

		for (const formSpec of modSpec.forms ?? []) {
			const formUuid = testUuid(formSpec.uuid ?? nextUuid("frm"));
			formOrder[moduleUuid].push(formUuid);
			fieldOrder[formUuid] = [];

			forms[formUuid] = {
				uuid: formUuid,
				id: formSpec.id ?? formSpec.name.toLowerCase().replace(/\s+/g, "_"),
				name: formSpec.name,
				type: formSpec.type,
				...(formSpec.purpose !== undefined && { purpose: formSpec.purpose }),
				...(formSpec.displayCondition !== undefined && {
					displayCondition: formSpec.displayCondition,
				}),
				...(formSpec.openCondition !== undefined && {
					openCondition: formSpec.openCondition as Form["openCondition"],
				}),
				...(formSpec.closeCondition !== undefined && {
					closeCondition: formSpec.closeCondition as Form["closeCondition"],
				}),
				...(formSpec.connect !== undefined && { connect: formSpec.connect }),
				...(formSpec.postSubmit !== undefined && {
					postSubmit: formSpec.postSubmit,
				}),
				...(formSpec.formLinks !== undefined && {
					formLinks: formSpec.formLinks.map((link) => ({
						...link,
						uuid: testUuid(link.uuid ?? nextUuid("link")),
					})) as unknown as FormLink[],
				}),
				...(formSpec.otherwise !== undefined && {
					otherwise: formSpec.otherwise,
				}),
			};

			installFields(
				formSpec.fields ?? [],
				formUuid,
				fields,
				fieldOrder,
				caseWrites,
			);
		}
	}

	const doc: BlueprintDoc = {
		appId: spec.appId ?? "test-app",
		appName: spec.appName ?? "Test",
		connectType: spec.connectType ?? null,
		caseTypes: normalizeFixtureCaseTypes(spec.caseTypes),
		appSettings: { ...(spec.appSettings ?? NEW_APP_SETTINGS) },
		modules,
		forms,
		fields,
		moduleOrder,
		formOrder,
		fieldOrder,
		fieldParent: {},
	};
	configure?.(doc);
	rebuildFieldParent(doc);
	addOwnCases(doc);
	// A form's own case takes its name from the writes, which the parser's
	// datum projection reads while it resolves the fixture's text.
	lowerCaseWrites(doc, caseWrites);
	resolveDocExpressions(doc);
	if (spec.appSettings === undefined) declareContentPlatforms(doc);
	return doc;
}

/** Where each fixture field's `caseWrite` sugar said its answer is saved. */
type FixtureCaseWrites = Map<Uuid, { caseType: string; property: string }>;

/**
 * For a test that hand-assembles its document rather than using `buildDoc`:
 * give each case form its own case and lower each field's `caseWrite` sugar
 * (`caseWrites`, by field uuid) into the form's case operations, exactly as
 * `buildDoc` does. Mutates `doc` in place and returns it.
 */
export function lowerFixtureCaseWrites(
	doc: BlueprintDoc,
	caseWrites: ReadonlyMap<Uuid, { caseType: string; property: string }>,
): BlueprintDoc {
	addOwnCases(doc);
	lowerCaseWrites(doc, new Map(caseWrites));
	return doc;
}

/**
 * Give every registration, follow-up and close form of a module with a case
 * type that holds no own case one, first, as `formScaffoldMutations` births
 * a form: it writes nothing until a field's `caseWrite` is lowered onto it.
 * Its uuid is the one `lib/doc/__tests__/ownCaseFixture.ts::ownCaseUuidFor`
 * names, so a test can address it.
 */
function addOwnCases(doc: BlueprintDoc): void {
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		const caseType = doc.modules[moduleUuid]?.caseType;
		if (caseType === undefined) continue;
		for (const formUuid of formUuids) {
			const form = doc.forms[formUuid];
			if (form === undefined || form.type === "survey") continue;
			const operations = form.caseOperations ?? [];
			if (operations.some((operation) => operation.action === "own")) continue;
			form.caseOperations = [
				{
					uuid: testUuid(`own-case-of-${formUuid}`),
					id: ownCaseOperationId(
						caseType,
						new Set(operations.map((operation) => operation.id)),
					),
					action: "own",
				},
				...operations,
			];
		}
	}
}

/** Reduces fixture batches without freezing: tests edit fixtures in place. */
const FIXTURE_IMMER = new Immer({ autoFreeze: false });

const CATALOG_KINDS: ReadonlySet<Mutation["kind"]> = new Set([
	"declareCaseType",
	"addCaseProperty",
]);

/**
 * Lower each field's `caseWrite` sugar into the form's case operations,
 * form by form, in data-tree order, each bucket's `case_name` writer first
 * so a new child case is made with its name. Each write is planned by
 * `planFieldCaseWrite` (with the starting value it is born with) and
 * applied through the reducers without the gate, since a fixture may be
 * built invalid on purpose; the catalog entries the planner would declare
 * are left out, so the fixture's catalog stays the one it states.
 *
 * Where the planner refuses a write the fixture asked for (a second name for
 * one case, a child case with no name), the form takes the operations its
 * writes made before the planner existed instead
 * (`operationsFromFieldWrites`, with `planExplicitPreloads` for the writers
 * that opened with their case's value), so a fixture of a shape the gate
 * refuses still states it.
 */
/**
 * Whether a generated save's question keeps the starting value
 * `planExplicitPreloads` gives it, as the cutover's mapping does: every one
 * but a whole-number question's on a decimal property, which the gate
 * refuses (`WHOLE_NUMBER_STARTS_ON_DECIMAL`), since the generators build
 * documents the gate admits. A choice question on a property that can hold
 * other values keeps its starting value, as the cutover keeps it: only the
 * "Saves to" planner refuses that, on the property's type, while the gate
 * leaves it to a value-level check (issue #856). Throws where the saved
 * question isn't in the document.
 */
export function generatedStartingValueAdmitted(
	doc: BlueprintDoc,
	write: {
		readonly fieldUuid: Uuid;
		readonly caseType: string;
		readonly property: string;
	},
): boolean {
	const field = doc.fields[write.fieldUuid];
	if (field === undefined)
		throw new Error(
			`The generator saves question ${write.fieldUuid}, which isn't in the document.`,
		);
	return !wholeNumberStartsOnDecimal(
		field,
		propertyAgreedType(doc, write.caseType, write.property),
	);
}

function lowerCaseWrites(
	doc: BlueprintDoc,
	caseWrites: FixtureCaseWrites,
): void {
	if (caseWrites.size === 0) return;
	// Plan over a copy: the planners memoize per document object, and the
	// fixture itself is written once the lowering is done.
	let work: BlueprintDoc = structuredClone(doc);
	const apply = (base: BlueprintDoc, mutations: readonly Mutation[]) =>
		mutations.length === 0
			? base
			: FIXTURE_IMMER.produce(base, (draft) => {
					applyMutations(draft, mutations);
				});
	const touched = new Set<Uuid>();
	for (const formUuids of Object.values(doc.formOrder)) {
		for (const formUuid of formUuids) {
			const writers = dataTreeOrder(doc, formUuid).flatMap((fieldUuid) => {
				const write = caseWrites.get(fieldUuid);
				return write === undefined ? [] : [{ fieldUuid, ...write }];
			});
			if (writers.length === 0) continue;
			for (const writer of writers) touched.add(writer.fieldUuid);
			const items = nameFirstWithinBuckets(
				writers.map((writer) => ({
					writer,
					view: {
						caseType: writer.caseType,
						slot: writer.property === "case_name" ? "name" : "write",
					} as const,
					repeat: nearestRepeatOf(doc, writer.fieldUuid),
				})),
			);
			const before = work;
			let refused = false;
			for (const { writer } of items) {
				const plan = planFieldCaseWrite(work, writer.fieldUuid, {
					caseType: writer.caseType,
					property: writer.property,
				});
				if (!plan.ok) {
					refused = true;
					break;
				}
				work = apply(
					work,
					plan.mutations.filter(
						(mutation) => !CATALOG_KINDS.has(mutation.kind),
					),
				);
			}
			if (!refused) continue;
			const preloaded = writers.filter((writer) =>
				writerOffersPreload(before, writer.fieldUuid, writer.property),
			);
			work = apply(
				before,
				operationsFromFieldWrites(
					before,
					formUuid,
					writers.map((writer) => ({
						...writer,
						capture: isCaptureField(before.fields[writer.fieldUuid]),
					})),
				),
			);
			const fits = preloaded.filter((writer) =>
				generatedStartingValueAdmitted(work, writer),
			);
			work = apply(
				work,
				planExplicitPreloads(
					work,
					formUuid,
					fits.map((writer) => writer.fieldUuid),
				),
			);
		}
	}
	for (const [formUuid, form] of Object.entries(work.forms)) {
		const target = doc.forms[formUuid];
		if (target === undefined) continue;
		if (form.caseOperations === undefined) delete target.caseOperations;
		else
			target.caseOperations = withFixtureOperationUuids(
				formUuid as Uuid,
				new Set((target.caseOperations ?? []).map((op) => op.uuid)),
				form.caseOperations,
			);
	}
	for (const fieldUuid of touched) {
		const field = work.fields[fieldUuid];
		if (field !== undefined && "default_value" in field)
			(doc.fields[fieldUuid] as Record<string, unknown>).default_value =
				field.default_value;
	}
}

/**
 * `operations` with each operation the lowering made (one whose uuid is not
 * in `before`) named from its form, action, case type and repeat, as
 * `testUuid` names every other fixture identity: the planner draws a new
 * operation's uuid at random, and a fixture is the same document every time
 * it is built. Every reference to a renamed operation is renamed with it.
 */
function withFixtureOperationUuids(
	formUuid: Uuid,
	before: ReadonlySet<Uuid>,
	operations: readonly CaseOperation[],
): CaseOperation[] {
	const renames = new Map<string, Uuid>();
	const counts = new Map<string, number>();
	for (const operation of operations) {
		if (before.has(operation.uuid)) continue;
		const key = `${formUuid}:${operation.action}:${operation.caseType ?? ""}:${operation.forEach?.repeat ?? "root"}`;
		const n = counts.get(key) ?? 0;
		counts.set(key, n + 1);
		renames.set(operation.uuid, testUuid(`case-write-operation:${key}:${n}`));
	}
	if (renames.size === 0) return [...operations];
	const rename = (value: unknown): unknown => {
		if (typeof value === "string") return renames.get(value) ?? value;
		if (Array.isArray(value)) return value.map(rename);
		if (value !== null && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [key, rename(entry)]),
			);
		return value;
	};
	return operations.map((operation) => rename(operation) as CaseOperation);
}

/** Every field of `formUuid` in data-tree order: each before its children. */
function dataTreeOrder(doc: BlueprintDoc, formUuid: Uuid): Uuid[] {
	const order: Uuid[] = [];
	const walk = (parentUuid: Uuid) => {
		for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
			if (doc.fields[uuid] === undefined) continue;
			order.push(uuid);
			walk(uuid);
		}
	};
	walk(formUuid);
	return order;
}

/** Set `runsOnlyOn` to the platform the content allows, or leave both. */
function declareContentPlatforms(doc: BlueprintDoc): void {
	const platforms = contentRunsOn(doc);
	if (platforms.length === 0)
		throw new Error(
			`This fixture's content runs on neither platform: ${unavailableUses(
				doc,
				PLATFORMS,
			)
				.map((use) => use.feature)
				.join(", ")}. Give it appSettings, or take one of them out.`,
		);
	if (platforms.length === 1) doc.appSettings.runsOnlyOn = platforms[0];
}

function normalizeFixtureCaseTypes(
	caseTypes: FixtureCaseType[] | null | undefined,
): CaseType[] | null {
	if (caseTypes == null) return null;
	return caseTypes.map((caseType) => ({
		...caseType,
		properties: caseType.properties.map((property) => {
			const { label, hint, options, ...rest } = property;
			return {
				...rest,
				label: fixtureProse(label),
				...(hint !== undefined && { hint: fixtureProse(hint) }),
				...(options !== undefined && {
					options: options.map((option) => {
						const { label: optionLabel, ...optionRest } = option;
						return {
							...optionRest,
							label: fixtureProse(optionLabel),
						};
					}),
				}),
			};
		}),
	}));
}

function fixtureProse(value: FixtureProse): ProseTemplate {
	return typeof value === "string" ? proseText(value) : value;
}

/**
 * Fixtures author expression slots as XPath TEXT (the concise spec
 * shape); the canonical stored form is the expression AST. Convert
 * after assembly so references resolve against the COMPLETE built doc
 * — exactly the contract every live commit surface follows. Exported
 * for tests that hand-assemble docs instead of using `buildDoc`;
 * mutates in place and returns the doc for inline wrapping.
 */
export function resolveDocExpressions(doc: BlueprintDoc): BlueprintDoc {
	const owners: ExpressionCarrierRef[] = [
		...Object.values(doc.fields).map(({ uuid }) => ({
			entity: "field" as const,
			uuid,
		})),
		...Object.values(doc.forms).map(({ uuid }) => ({
			entity: "form" as const,
			uuid,
		})),
		...Object.values(doc.modules).map(({ uuid }) => ({
			entity: "module" as const,
			uuid,
		})),
	];
	const pending = new Map<string, { ref: ExpressionSlotRef; source: string }>();
	for (const owner of owners) {
		rewriteExpressionSlotValues(doc, owner, (value, ref) => {
			if (typeof value === "string")
				pending.set(expressionSlotKey(ref), { ref, source: value });
			return value;
		});
	}
	const resolved = new Map<string, Expression>();
	const resolving = new Set<string>();
	// The document each slot is parsed against. A form's entry supplies read
	// the form's after-submit links (which creates a link carries makes the
	// menu advanced), so a link slot not yet resolved is no text there: its
	// condition is absent and a datum value reads nothing, as a link being
	// added is absent from the document it is parsed against. Each resolved
	// link slot takes its place in a fresh call-local copy, so no answer the
	// domain memoized per document reads a slot that has since changed.
	// Fixture callers may deliberately mutate the returned document after
	// assembly, so nothing is cached on `doc` itself.
	const linkSlotsAsResolved = (): BlueprintDoc => {
		const forms = { ...doc.forms };
		const snapshot: BlueprintDoc = { ...doc, forms };
		for (const [formUuid, form] of Object.entries(doc.forms) as [
			Uuid,
			Form,
		][]) {
			if (form.formLinks === undefined) continue;
			forms[formUuid] = structuredClone(form);
			rewriteExpressionSlotValues(
				snapshot,
				{ entity: "form", uuid: formUuid },
				(value, ref) => {
					if (typeof value !== "string" || !isFormLinkSlot(ref)) return value;
					const known = resolved.get(expressionSlotKey(ref));
					if (known !== undefined) return known;
					return ref.slot === "form_link_condition"
						? undefined
						: term(literal(""));
				},
			);
		}
		return snapshot;
	};
	let parsingDoc = linkSlotsAsResolved();
	let structures = new Map<Uuid, FormStructure>();
	const read = (ref: ExpressionSlotRef): Expression | undefined => {
		const key = expressionSlotKey(ref);
		const source = pending.get(key);
		if (source === undefined) return expressionSlotValue(parsingDoc, ref);
		const existing = resolved.get(key);
		if (existing !== undefined) return existing;
		if (resolving.has(key))
			throw new Error(`Fixture expression dependency cycle at ${key}.`);
		resolving.add(key);
		try {
			const form =
				ref.entity === "module"
					? undefined
					: [...structures.values()].find((candidate) =>
							ref.entity === "form"
								? candidate.formUuid === ref.uuid
								: candidate.fields.has(ref.uuid),
						);
			const parsed = parseFormExpression(source.source, {
				doc: parsingDoc,
				slot: ref,
				lookup: "unavailable",
				...(form === undefined ? {} : { form }),
			});
			if (!parsed.ok)
				throw new Error(
					`Fixture expression ${key}: ${parsed.issues.map((issue) => issue.message).join("\n")}`,
				);
			if (parsed.expression === undefined)
				throw new Error(
					`Fixture expression ${key} is empty; omit an optional slot instead.`,
				);
			resolved.set(key, parsed.expression);
			return parsed.expression;
		} finally {
			resolving.delete(key);
		}
	};
	const structuresOf = (on: BlueprintDoc): Map<Uuid, FormStructure> => {
		const built = new Map<Uuid, FormStructure>();
		for (const formUuid of Object.keys(on.forms) as Uuid[]) {
			if (moduleUuidOfForm(on, formUuid) === undefined) continue;
			const base = formStructure(on, formUuid);
			if (base !== undefined)
				built.set(formUuid, { ...base, expressionAt: read });
		}
		return built;
	};
	structures = structuresOf(parsingDoc);
	// The link slots first, in document order, each against the links
	// resolved before it.
	for (const { ref } of pending.values()) {
		if (!isFormLinkSlot(ref) || resolved.has(expressionSlotKey(ref))) continue;
		read(ref);
		parsingDoc = linkSlotsAsResolved();
		structures = structuresOf(parsingDoc);
	}
	for (const { ref } of pending.values()) read(ref);
	for (const owner of owners)
		rewriteExpressionSlotValues(doc, owner, (value, ref) =>
			typeof value === "string" ? resolved.get(expressionSlotKey(ref)) : value,
		);
	return doc;
}

function isFormLinkSlot(ref: ExpressionSlotRef): boolean {
	return (
		ref.entity === "form" &&
		(ref.slot === "form_link_condition" || ref.slot === "form_link_datum_xpath")
	);
}

/**
 * Install a flat field list under `parentUuid` in the entity maps,
 * recursing through container children. Each field is given an
 * auto-assigned uuid unless the spec provided one. Structural kinds
 * (group, repeat) receive their own `fieldOrder` entry — leaves do not.
 */
function installFields(
	specs: FieldSpec[],
	parentUuid: Uuid,
	fields: BlueprintDoc["fields"],
	fieldOrder: BlueprintDoc["fieldOrder"],
	caseWrites: FixtureCaseWrites,
): void {
	for (const spec of specs) {
		const {
			children,
			uuid: rawUuid,
			kind,
			id,
			label,
			caseWrite,
			...rest
		} = spec;
		const uuid = testUuid(rawUuid ?? nextUuid("fld"));
		fieldOrder[parentUuid].push(uuid);
		if (caseWrite !== undefined && caseWrite !== null) {
			const { caseType, property } = caseWrite as {
				caseType: string;
				property: string;
			};
			caseWrites.set(uuid, { caseType, property });
		}

		const base: Record<string, unknown> = {
			uuid,
			kind,
			id,
			...rest,
		};
		// `label` is required on every non-hidden variant; default to id
		// so callers that don't care about labels get a sensible fixture.
		// Hidden has no `label`, and a section's title is optional (absent =
		// untitled, the canonical state) — omit it when the caller does too.
		if (label !== undefined) {
			base.label = fixtureProse(label);
		} else if (kind !== "hidden" && kind !== "section") {
			base.label = proseText(id);
		}
		for (const proseSlot of ["hint", "help", "validate_msg"] as const) {
			if (typeof base[proseSlot] === "string") {
				base[proseSlot] = proseText(base[proseSlot]);
			}
		}
		if (
			(kind === "single_select" || kind === "multi_select") &&
			Array.isArray(base.options)
		) {
			base.optionsSource = {
				kind: "inline",
				options: normalizeFixtureOptions(base.options, uuid),
			};
			delete base.options;
		} else if (
			(kind === "single_select" || kind === "multi_select") &&
			isInlineOptionsSource(base.optionsSource)
		) {
			base.optionsSource = {
				...base.optionsSource,
				options: normalizeFixtureOptions(base.optionsSource.options, uuid),
			};
		}
		// `repeat` is a discriminated union on `repeat_mode`; default to
		// `user_controlled` so fixtures that don't care about the mode
		// stay valid against `fieldSchema`. Tests that need count_bound
		// or query_bound pass the mode explicitly via `...rest`.
		if (kind === "repeat" && base.repeat_mode === undefined) {
			base.repeat_mode = "user_controlled";
		}
		fields[uuid] = base as unknown as Field;

		// Container kinds carry a fieldOrder entry; without one, the walkers
		// treat the field as a leaf.
		if (isContainerKindName(kind)) {
			fieldOrder[uuid] = [];
			if (children?.length)
				installFields(children, uuid, fields, fieldOrder, caseWrites);
		}
	}
}

function isInlineOptionsSource(
	value: unknown,
): value is { kind: "inline"; options: unknown[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "inline" &&
		Array.isArray((value as { options?: unknown }).options)
	);
}

function normalizeFixtureOptions(
	options: unknown[],
	fieldUuid: Uuid,
): Array<Record<string, unknown>> {
	return options.map((rawOption, index) => {
		const option =
			typeof rawOption === "object" && rawOption !== null
				? (rawOption as Record<string, unknown>)
				: {};
		const rawLabel = option.label;
		return {
			...option,
			uuid:
				typeof option.uuid === "string"
					? testUuid(option.uuid)
					: testUuid(`${fieldUuid}-option-${index}`),
			...(typeof rawLabel === "string" && { label: proseText(rawLabel) }),
		};
	});
}
