// lib/domain/casePropertyTypes.ts
//
// Leaf module for the case-property `data_type` enum. Lives in
// its own file (rather than alongside the rest of the case-type
// schema in `blueprint.ts`) so the module-graph stays acyclic:
// the predicate AST (`./predicate/types.ts`) needs the enum for
// typed literals, the structured `Module` schema
// (`./modules.ts`) imports the predicate AST for the
// `caseListConfig.filter` / `searchInputs[].xpath` /
// `calculatedColumns[].expression` slots, and `blueprint.ts`
// imports `Module` for `BlueprintDoc.modules`. Routing the enum
// through a leaf file lets every consumer pull it without
// pulling the rest of the blueprint shape transitively.

import { z } from "zod";

/**
 * The data types a case property may declare. Exported as a
 * readonly tuple so every consumer that reasons about case-
 * property typing — the predicate AST, the JSON Schema emitter,
 * the SQL compiler — shares one enumeration rather than
 * maintaining parallel copies. The Zod enum is built from the
 * tuple via `z.enum(...)` so the runtime schema and the static
 * union stay in lockstep: adding a variant to the tuple expands
 * both surfaces in one edit.
 */
export const casePropertyDataTypes = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
] as const;
export type CasePropertyDataType = (typeof casePropertyDataTypes)[number];
export const casePropertyDataTypeSchema = z.enum(casePropertyDataTypes);
