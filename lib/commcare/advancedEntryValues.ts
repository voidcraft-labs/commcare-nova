// The suite's entry functions and HQ's source settings for the same form-local
// supplies. HQ's EntriesHelper.get_auto_select_datums_and_assertions checks
// existence in the restore for every mode. Only usercase predicates by type.
import type {
	BlueprintDoc,
	DatumRef,
	Expression,
	FormCaseSelection,
	Uuid,
} from "@/lib/domain";
import { userPropertySlugsByUuid } from "@/lib/domain/users";
import { requireExpressionContext } from "./expressionContext";
import type { LookupWireNaming } from "./lookup/naming";
import type { AdvancedFormActions, AutoSelectCase } from "./types";
import {
	USERCASE_ID_FUNCTION,
	USERCASE_MISSING_ASSERT_TEST,
	USERCASE_MISSING_LOCALE_ID,
} from "./usercaseWire";
import { w } from "./xpath/wire/builders";
import { toWire } from "./xpath/wire/fromExpression";
import {
	caseDbInstance,
	lookupInstance,
	sessionInstance,
} from "./xpath/wire/instances";
import { serializeWire } from "./xpath/wire/serialize";
import type { WireExpr, WirePath } from "./xpath/wire/tree";

export interface EntryAssertion {
	readonly test: WireExpr;
	readonly localeId: string;
	readonly arguments?: readonly string[];
}

function one(path: WireExpr): WireExpr {
	return w.eq(w.call("count", [path]), w.num(1));
}

function caseWithId(id: WireExpr): WirePath {
	return w.instance(caseDbInstance(), [
		w.step("casedb"),
		w.step("case", [w.eq(w.context([w.attr("case_id")]), id)]),
	]);
}

function caseDatum(tag: string): WirePath {
	return w.instance(sessionInstance(), [
		w.step("session"),
		w.step("data"),
		w.step(`case_id_${tag}`),
	]);
}

export function entryValueWire(
	doc: BlueprintDoc,
	formUuid: Uuid,
	supplyUuid: Uuid,
	slot: "form_selection_source" | "form_entry_value",
	value: Expression,
	datumId: (ref: DatumRef) => string | undefined,
	lookupNaming?: LookupWireNaming,
): WireExpr {
	const types = requireExpressionContext(
		doc,
		{ entity: "form", uuid: formUuid, slot, member: { supplyUuid } },
		lookupNaming,
	);
	return toWire(value, {
		target: "suite",
		types,
		bindings: {
			datumId,
			userPropertySlugs: types.facts.userPropertySlugs,
			...(lookupNaming && {
				lookup: { naming: lookupNaming, instanceScope: "suite" },
			}),
		},
	});
}

export interface AutoCaseProjection {
	readonly configuration: AutoSelectCase;
	readonly value: WireExpr;
	readonly assertions: readonly EntryAssertion[];
}

export function automaticCase(
	doc: BlueprintDoc,
	formUuid: Uuid,
	selection: FormCaseSelection,
	datumId: (ref: DatumRef) => string | undefined,
	naming?: LookupWireNaming,
): AutoCaseProjection | undefined {
	const source = selection.source;
	if (source.kind === "choose") return undefined;
	const settings = (
		mode: AutoSelectCase["mode"],
		value_key = "",
		value_source = "",
	): AutoSelectCase => ({
		doc_type: "AutoSelectCase",
		mode,
		value_key,
		value_source,
	});
	if (source.kind === "worker-record")
		return {
			configuration: settings("usercase"),
			value: USERCASE_ID_FUNCTION,
			assertions: [
				{
					test: USERCASE_MISSING_ASSERT_TEST,
					localeId: USERCASE_MISSING_LOCALE_ID,
				},
			],
		};
	let value: WireExpr;
	let required: WireExpr;
	let configuration: AutoSelectCase;
	const assertions: EntryAssertion[] = [];
	if (source.kind === "expression") {
		required = value = entryValueWire(
			doc,
			formUuid,
			selection.uuid,
			"form_selection_source",
			source.value,
			datumId,
			naming,
		);
		configuration = settings(
			"raw",
			serializeWire(value, { target: "suite" }).text,
		);
	} else if (source.kind === "worker-data") {
		const key =
			source.property.kind === "session-user"
				? source.property.field
				: userPropertySlugsByUuid(doc).get(source.property.userPropertyUuid);
		if (!key)
			throw new Error(
				`The worker property for “${selection.name}” no longer exists.`,
			);
		const data = w.instance(sessionInstance(), [
			w.step("session"),
			w.step("user"),
			w.step("data"),
		]);
		required = w.append(data, [w.step(key)]);
		const present = w.and(one(data), one(required));
		value = w.call("if", [present, required, w.str("")]);
		configuration = settings("user", key);
		assertions.push({
			test: present,
			localeId: "case_autoload.user.property_missing",
			arguments: [key],
		});
	} else if (source.kind === "table") {
		const table = naming?.tableFor(source.table);
		if (!table || !naming)
			throw new Error(
				`The lookup table for “${selection.name}” is needed to open this form.`,
			);
		const key = table.wireNameFor(source.column);
		const rows = w.instance(lookupInstance(source.table, naming, "suite"), [
			w.step(table.listElementName),
			w.step(table.rowElementName),
		]);
		required = value = w.append(rows, [w.step(key)]);
		configuration = settings("fixture", key, table.tag);
		assertions.push(
			{
				test: one(rows),
				localeId: "case_autoload.fixture.exactly_one_fixture",
				arguments: [table.tag],
			},
			{
				test: one(value),
				localeId: "case_autoload.fixture.property_missing",
				arguments: [key],
			},
		);
	} else {
		const earlier = doc.forms[formUuid]?.caseSelections?.find(
			(row) => row.uuid === source.selection,
		);
		if (!earlier)
			throw new Error(
				`“${selection.name}” follows a record outside this form.`,
			);
		required = value = w.append(caseWithId(caseDatum(earlier.tag)), [
			w.step("index"),
			w.step(source.identifier),
		]);
		configuration = settings("case", source.identifier, earlier.tag);
		assertions.push({
			test: one(value),
			localeId: "case_autoload.case.property_missing",
			arguments: [source.identifier],
		});
	}
	assertions.push({
		test: one(caseWithId(required)),
		localeId: `case_autoload.${configuration.mode}.case_missing`,
	});
	return { configuration, value, assertions };
}

/** Resolve the optional automatic choices against this Project's lookup naming
 * at the HQ transport and the post-reading comparison alike. */
export function advancedActionsWithEntry(
	actions: AdvancedFormActions,
	datums: readonly {
		advancedLoadTag?: string;
		autoConfiguration?: AutoSelectCase;
	}[],
): AdvancedFormActions {
	const byTag = new Map(
		datums.flatMap((row) =>
			row.advancedLoadTag && row.autoConfiguration
				? [[row.advancedLoadTag, row.autoConfiguration] as const]
				: [],
		),
	);
	return {
		...actions,
		load_update_cases: actions.load_update_cases.map((load) => {
			const auto = byTag.get(load.case_tag);
			return auto ? { ...load, auto_select: auto } : load;
		}),
	};
}
