// lib/preview/engine/searchExpressionEvaluation.ts
//
// Runtime evaluation for the two case-search ValueExpression surfaces:
// prompt defaults and the excluded-owner expression. The shipped app
// evaluates both with CommCare's on-device XPath evaluator. Preview reuses
// Nova's existing XPath evaluator over the exact emitted expression instead
// of growing a second, subtly different AST interpreter.
//
// The evaluator intentionally has no case-row context. Search prompt defaults
// and hidden query values run against the session/search-input instances, not
// against a selected case. A property/relation read therefore resolves blank
// here, matching a search screen before a case has been selected.

import { emitOnDeviceExpression } from "@/lib/commcare/expression/onDeviceEmitter";
import { bySortKey } from "@/lib/doc/order/compare";
import type { SearchInputDef } from "@/lib/domain";
import type {
	SessionContextField,
	ValueExpression,
} from "@/lib/domain/predicate";
import { xpathToString } from "@/lib/preview/xpath/coerce";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import type { SearchInputValues } from "./runtimeBindings";
import { bindSearchInputValuesInExpression } from "./runtimeBindings";

/** The session slices a search expression can read on the device. */
export interface PreviewSearchSessionValues {
	readonly context: Readonly<Partial<Record<SessionContextField, string>>>;
	readonly user: Readonly<Record<string, string>>;
}

/** Narrow user shape shared by Better Auth's client and server session. */
export interface PreviewSearchUser {
	readonly id: string;
	readonly name?: string | null;
	readonly email?: string | null;
}

const EMPTY_SESSION_VALUES: PreviewSearchSessionValues = {
	context: {
		deviceid: "nova-preview",
		appversion: "preview",
	},
	user: {},
};

/**
 * Project a Nova login into the CommCare session vocabulary used by authored
 * expressions. `userid` is the important identity bridge: local case rows are
 * owned by that same authenticated id, so excluding the current worker behaves
 * truthfully in preview. Open-namespace user data is necessarily best-effort;
 * the common profile fields are populated and an unknown custom field resolves
 * blank, just as it would for a worker without that user-data field.
 */
export function previewSearchSessionValues(
	user: PreviewSearchUser | null | undefined,
): PreviewSearchSessionValues {
	if (user === null || user === undefined) return EMPTY_SESSION_VALUES;

	const email = user.email?.trim() ?? "";
	const name = user.name?.trim() ?? "";
	const username = email || name || user.id;
	const nameParts = name.split(/\s+/).filter(Boolean);
	const firstName = nameParts[0] ?? "";
	const lastName = nameParts.slice(1).join(" ");

	return {
		context: {
			userid: user.id,
			username,
			deviceid: "nova-preview",
			appversion: "preview",
		},
		user: Object.fromEntries(
			[
				["userid", user.id],
				["username", username],
				["email", email],
				["name", name],
				["first_name", firstName],
				["last_name", lastName],
			].filter((entry): entry is [string, string] => entry[1] !== ""),
		),
	};
}

/**
 * Evaluate one search ValueExpression with the same XPath implementation the
 * form preview already uses. Runtime search-input refs are first substituted
 * into the AST because the scalar preview evaluator deliberately does not
 * model XML nodeset predicates such as `field[@name='query']`.
 */
export function evaluatePreviewSearchExpression(
	expression: ValueExpression,
	session: PreviewSearchSessionValues,
	inputValues: SearchInputValues = new Map(),
): string {
	const bound = bindSearchInputValuesInExpression(expression, inputValues);
	const xpath = emitOnDeviceExpression(bound);
	const result = evaluate(xpath, {
		contextPath: "",
		position: 1,
		size: 1,
		getValue: (path) => sessionPathValue(path, session),
		resolveHashtag: () => "",
	});
	return xpathToString(result);
}

function sessionPathValue(
	path: string,
	session: PreviewSearchSessionValues,
): string | undefined {
	const contextPrefix = "/session/context/";
	if (path.startsWith(contextPrefix)) {
		const field = path.slice(contextPrefix.length) as SessionContextField;
		return session.context[field];
	}

	const userPrefix = "/session/user/data/";
	if (path.startsWith(userPrefix)) {
		return session.user[path.slice(userPrefix.length)];
	}

	return undefined;
}

/**
 * Resolve prompt defaults in displayed order. CommCare evaluates every prompt
 * default against the session context before it constructs the search-input
 * instance, so sibling defaults do not feed one another. Preview mirrors that
 * lifecycle by evaluating each expression with an empty input bag.
 *
 * A date-range prompt stores one default expression, while Nova renders two
 * explicit bounds. A single date seeds From (the same shape SearchCanvas
 * depicts); legacy full-range strings can seed both bounds.
 */
export function resolveSearchInputDefaults(
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
): SearchInputValues {
	const values = new Map<string, string>();
	for (const input of [...searchInputs].sort(bySortKey)) {
		if (input.default === undefined) continue;
		const value = evaluatePreviewSearchExpression(
			input.default,
			session,
		).trim();
		if (value === "") continue;
		if (input.type === "date-range") {
			const bounds = dateRangeDefaultBounds(value);
			if (bounds === undefined) continue;
			values.set(`${input.name}:from`, bounds.from);
			if (bounds.to !== undefined) values.set(`${input.name}:to`, bounds.to);
		} else {
			values.set(input.name, value);
		}
	}
	return values;
}

function dateRangeDefaultBounds(
	value: string,
): { readonly from: string; readonly to?: string } | undefined {
	const wire = /^__range__(\d{4}-\d{2}-\d{2})__(\d{4}-\d{2}-\d{2})$/.exec(
		value,
	);
	if (wire !== null) return { from: wire[1], to: wire[2] };

	const human = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/.exec(value);
	if (human !== null) return { from: human[1], to: human[2] };

	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return { from: value };
	}
	return undefined;
}

/** CCHQ splits this one niche value on whitespace only; commas remain ids. */
export function parseExcludedOwnerIds(value: string): readonly string[] {
	return [...new Set(value.trim().split(/\s+/).filter(Boolean))];
}
