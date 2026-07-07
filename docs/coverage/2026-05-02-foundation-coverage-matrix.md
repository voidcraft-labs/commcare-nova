# Foundation coverage matrix — case-list & search

Date: 2026-05-02
Owner: Plan 1 (foundation) — Task C8 final verification gate
Spec source: `docs/specs/2026-04-30-case-list-search-design.md`,
"Wire emission" section, V1-IN list at lines 457-478

This matrix grounds every operator in the spec's V1-IN list against
its actual coverage across four compilation surfaces:

1. **Type checker** — `lib/domain/predicate/typeChecker.ts`
2. **On-device XPath emitter** — case-list filter + search-filter
   slot. Two compilers split by AST family:
   - Predicate → `lib/commcare/predicate/caseListFilterEmitter.ts`
   - ValueExpression → `lib/commcare/expression/onDeviceEmitter.ts`
3. **CSQL emitter** — server-parsed by ElasticSearch. Total
   emission via hoist + faithful per-arm rules:
   - Hoist routing → `lib/commcare/predicate/csqlHoist.ts`
   - Predicate faithful → `lib/commcare/predicate/csqlEmitter.ts`
   - ValueExpression faithful → `lib/commcare/expression/csqlEmitter.ts`
4. **Postgres compiler** — `lib/case-store/sql/`:
   - Predicate → `compilePredicate.ts`
   - ValueExpression → `compileExpression.ts`
   - Term → `compileTerm.ts`
   - Relation walks → `compileRelationPath.ts`
   - Literals (shared) → `compileLiteral.ts`

Citation form: `file:line` per cell. N/A cells carry a one-line
reason; the matrix never substitutes a fabricated citation for a
genuinely-missing one.

## Predicate AST coverage

Spec V1-IN block at lines 459-469.

| Operator                     | Type checker                                                   | On-device XPath                                                | CSQL                                                              | Postgres compiler                                                  |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `match-all` (sentinel)       | `lib/domain/predicate/typeChecker.ts:419`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:161`          | faithful `lib/commcare/predicate/csqlEmitter.ts:222`              | `lib/case-store/sql/compilePredicate.ts:313`                       |
| `match-none` (sentinel)      | `lib/domain/predicate/typeChecker.ts:420`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:166`          | faithful `lib/commcare/predicate/csqlEmitter.ts:226`              | `lib/case-store/sql/compilePredicate.ts:319`                       |
| `is-null`                    | `lib/domain/predicate/typeChecker.ts:431`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:224`          | faithful `lib/commcare/predicate/csqlEmitter.ts:259`              | `lib/case-store/sql/compilePredicate.ts:352`                       |
| `is-blank`                   | `lib/domain/predicate/typeChecker.ts:432`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:223`          | faithful `lib/commcare/predicate/csqlEmitter.ts:258`              | `lib/case-store/sql/compilePredicate.ts:354`                       |
| `and`                        | `lib/domain/predicate/typeChecker.ts:376`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:182`          | faithful `lib/commcare/predicate/csqlEmitter.ts:237`              | `lib/case-store/sql/compilePredicate.ts:323`                       |
| `or`                         | `lib/domain/predicate/typeChecker.ts:377`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:193`          | faithful `lib/commcare/predicate/csqlEmitter.ts:239`              | `lib/case-store/sql/compilePredicate.ts:325`                       |
| `not`                        | `lib/domain/predicate/typeChecker.ts:388`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:203`          | faithful `lib/commcare/predicate/csqlEmitter.ts:241`              | `lib/case-store/sql/compilePredicate.ts:327`                       |
| `eq` / `neq` / `gt` / `gte` / `lt` / `lte` (comparison family) | `lib/domain/predicate/typeChecker.ts:368-373` | `lib/commcare/predicate/caseListFilterEmitter.ts:171-176`      | faithful `lib/commcare/predicate/csqlEmitter.ts:230-235`          | `lib/case-store/sql/compilePredicate.ts:329-334` (dispatch via `compileComparison`) |
| `in`                         | `lib/domain/predicate/typeChecker.ts:407`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:209`          | faithful `lib/commcare/predicate/csqlEmitter.ts:254`              | `lib/case-store/sql/compilePredicate.ts:336`                       |
| `between`                    | `lib/domain/predicate/typeChecker.ts:449`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:211`          | faithful `lib/commcare/predicate/csqlEmitter.ts:256`              | `lib/case-store/sql/compilePredicate.ts:338`                       |
| `multi-select-contains`      | `lib/domain/predicate/typeChecker.ts:416`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:215`          | faithful `lib/commcare/predicate/csqlEmitter.ts:272`              | `lib/case-store/sql/compilePredicate.ts:340`                       |
| `match` (fuzzy)              | `lib/domain/predicate/typeChecker.ts:413` (mode-allowlist enforced) | `lib/commcare/predicate/caseListFilterEmitter.ts:373`     | faithful `lib/commcare/predicate/csqlEmitter.ts:573`              | `lib/case-store/sql/compilePredicate.ts:781`                       |
| `match` (phonetic)           | `lib/domain/predicate/typeChecker.ts:413` (mode-allowlist enforced) | `lib/commcare/predicate/caseListFilterEmitter.ts:375`     | faithful `lib/commcare/predicate/csqlEmitter.ts:575`              | `lib/case-store/sql/compilePredicate.ts:796`                       |
| `match` (fuzzy-date)         | `lib/domain/predicate/typeChecker.ts:413` (mode-allowlist enforced) | `lib/commcare/predicate/caseListFilterEmitter.ts:377`     | faithful `lib/commcare/predicate/csqlEmitter.ts:577`              | `lib/case-store/sql/compilePredicate.ts:805`                       |
| `match` (starts-with)        | `lib/domain/predicate/typeChecker.ts:413` (mode-allowlist enforced) | `lib/commcare/predicate/caseListFilterEmitter.ts:371`     | faithful `lib/commcare/predicate/csqlEmitter.ts:579`              | `lib/case-store/sql/compilePredicate.ts:773`                       |
| `within-distance`            | `lib/domain/predicate/typeChecker.ts:410`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:231`          | faithful `lib/commcare/predicate/csqlEmitter.ts:274` (lifts `center` value-expression operand via `csqlHoist.ts:381`) | `lib/case-store/sql/compilePredicate.ts:342`                       |
| `exists`                     | `lib/domain/predicate/typeChecker.ts:452`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:217`          | faithful `lib/commcare/predicate/csqlEmitter.ts:276`              | `lib/case-store/sql/compilePredicate.ts:344`                       |
| `missing`                    | `lib/domain/predicate/typeChecker.ts:453`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:219`          | faithful `lib/commcare/predicate/csqlEmitter.ts:278`              | `lib/case-store/sql/compilePredicate.ts:346`                       |
| `when-input-present`         | `lib/domain/predicate/typeChecker.ts:395`                      | `lib/commcare/predicate/caseListFilterEmitter.ts:221`          | faithful `lib/commcare/predicate/csqlEmitter.ts:280`              | `lib/case-store/sql/compilePredicate.ts:350`                       |

### Quantifier sub-arms

`multi-select-contains` carries an `any` / `all` quantifier that
dispatches inside the operator's compiler:

| Quantifier | On-device XPath                                              | CSQL                                                          | Postgres compiler                                                  |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `any`      | `lib/commcare/predicate/caseListFilterEmitter.ts:410`        | inside faithful `csqlEmitter.ts:272` arm dispatch             | `lib/case-store/sql/compilePredicate.ts:717`                       |
| `all`      | `lib/commcare/predicate/caseListFilterEmitter.ts:413`        | inside faithful `csqlEmitter.ts:272` arm dispatch             | `lib/case-store/sql/compilePredicate.ts:719`                       |

## ValueExpression AST coverage

Spec V1-IN block at lines 471-478. `unwrap-list` is a structural
arm of the union — not on the V1-IN list, but supported across all
four surfaces because the on-device wrapper pattern
`selected-any(prop, unwrap-list(...))` requires it. Listed for
completeness.

| Operator               | Type checker                                                   | On-device XPath                                                | CSQL                                                                                                                                | Postgres compiler                                                                                                                       |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `term`                 | `lib/domain/predicate/typeChecker.ts:1584`                     | `lib/commcare/expression/onDeviceEmitter.ts:128`               | faithful `lib/commcare/expression/csqlEmitter.ts:80` (preserved by hoist; no lift)                                                  | `lib/case-store/sql/compileExpression.ts:279` (delegates to `compileTerm.ts:364`)                                                       |
| `today`                | `lib/domain/predicate/typeChecker.ts:1593`                     | `lib/commcare/expression/onDeviceEmitter.ts:133`               | faithful `lib/commcare/expression/csqlEmitter.ts:102` (CCHQ value function)                                                         | `lib/case-store/sql/compileExpression.ts:281`                                                                                           |
| `now`                  | `lib/domain/predicate/typeChecker.ts:1596`                     | `lib/commcare/expression/onDeviceEmitter.ts:138`               | faithful `lib/commcare/expression/csqlEmitter.ts:106` (CCHQ value function)                                                         | `lib/case-store/sql/compileExpression.ts:283`                                                                                           |
| `date-add`             | `lib/domain/predicate/typeChecker.ts:1599`                     | `lib/commcare/expression/onDeviceEmitter.ts:196`               | faithful `lib/commcare/expression/csqlEmitter.ts:130` (CCHQ value function)                                                         | `lib/case-store/sql/compileExpression.ts:285`                                                                                           |
| `date-coerce`          | `lib/domain/predicate/typeChecker.ts:1637`                     | `lib/commcare/expression/onDeviceEmitter.ts:143`               | faithful `lib/commcare/expression/csqlEmitter.ts:110` (CCHQ value function)                                                         | `lib/case-store/sql/compileExpression.ts:287`                                                                                           |
| `datetime-coerce`      | `lib/domain/predicate/typeChecker.ts:1638`                     | `lib/commcare/expression/onDeviceEmitter.ts:148`               | faithful `lib/commcare/expression/csqlEmitter.ts:117` (CCHQ value function)                                                         | `lib/case-store/sql/compileExpression.ts:289`                                                                                           |
| `double`               | `lib/domain/predicate/typeChecker.ts:1664`                     | `lib/commcare/expression/onDeviceEmitter.ts:153`               | faithful `lib/commcare/expression/csqlEmitter.ts:124` (CCHQ value function)                                                         | `lib/case-store/sql/compileExpression.ts:291`                                                                                           |
| `arith`                | `lib/domain/predicate/typeChecker.ts:1689`                     | `lib/commcare/expression/onDeviceEmitter.ts:157`               | hoist + lift via wrapper at `lib/commcare/predicate/csqlHoist.ts:571` (absent from CSQL whitelist; reaching faithful arm throws at `lib/commcare/expression/csqlEmitter.ts:147`) | `lib/case-store/sql/compileExpression.ts:293`                                                                                           |
| `concat`               | `lib/domain/predicate/typeChecker.ts:1735`                     | `lib/commcare/expression/onDeviceEmitter.ts:165`               | hoist + lift via wrapper at `lib/commcare/predicate/csqlHoist.ts:572` (defensive throw at `lib/commcare/expression/csqlEmitter.ts:148`) | `lib/case-store/sql/compileExpression.ts:295`                                                                                           |
| `coalesce`             | `lib/domain/predicate/typeChecker.ts:1747`                     | `lib/commcare/expression/onDeviceEmitter.ts:169`               | hoist + lift via wrapper at `lib/commcare/predicate/csqlHoist.ts:573` (defensive throw at `lib/commcare/expression/csqlEmitter.ts:149`) | `lib/case-store/sql/compileExpression.ts:297`                                                                                           |
| `if`                   | `lib/domain/predicate/typeChecker.ts:1776`                     | `lib/commcare/expression/onDeviceEmitter.ts:173`               | hoist + lift via wrapper at `lib/commcare/predicate/csqlHoist.ts:574` (defensive throw at `lib/commcare/expression/csqlEmitter.ts:150`) | `lib/case-store/sql/compileExpression.ts:299` (predicate operand routes through `compilePredicate` thunk)                              |
| `switch`               | `lib/domain/predicate/typeChecker.ts:1813`                     | `lib/commcare/expression/onDeviceEmitter.ts:179`               | hoist + lift via wrapper at `lib/commcare/predicate/csqlHoist.ts:575` (defensive throw at `lib/commcare/expression/csqlEmitter.ts:151`) | `lib/case-store/sql/compileExpression.ts:301` (simple-CASE form; discriminator evaluates ONCE per row)                                  |
| `count`                | `lib/domain/predicate/typeChecker.ts:1865`                     | `lib/commcare/expression/onDeviceEmitter.ts:189`               | position-conditional; recogniser-shape preserved at `lib/commcare/predicate/csqlHoist.ts:581` (CCHQ's `_is_subcase_count` recogniser); defensive throw at `lib/commcare/expression/csqlEmitter.ts:152` if the lift policy reaches faithful emission | `lib/case-store/sql/compileExpression.ts:303` (predicate operand on `where` routes through `compilePredicate` thunk)                   |
| `format-date`          | `lib/domain/predicate/typeChecker.ts:1932`                     | `lib/commcare/expression/onDeviceEmitter.ts:184`               | hoist + lift via wrapper at `lib/commcare/predicate/csqlHoist.ts:562` (absent from CSQL whitelist; defensive throw at `lib/commcare/expression/csqlEmitter.ts:153`) | `lib/case-store/sql/compileExpression.ts:309`                                                                                           |
| `unwrap-list` (structural — not on V1-IN list) | `lib/domain/predicate/typeChecker.ts:1909` (resolves to `_sequence` sentinel) | `lib/commcare/expression/onDeviceEmitter.ts:207`               | faithful `lib/commcare/expression/csqlEmitter.ts:141` (CCHQ value function; surfaced via `selected-any(prop, unwrap-list(...))` pattern) | `lib/case-store/sql/compileExpression.ts:305` — defensive throw. No Postgres-side AST consumer accepts a sequence; the wire-emission boundary is the only consumer |

## Term family coverage

Terms are leaf-level values; every wire target consumes them
through a shared compiler.

| Term arm           | Type checker (resolveTermType)                                    | On-device XPath                                                            | CSQL                                                                              | Postgres compiler                                                        |
| ------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `prop`             | `lib/domain/predicate/typeChecker.ts:1362`                        | `lib/commcare/predicate/termEmitter.ts:218` (`emitOnDevicePropertyRef`)    | `lib/commcare/predicate/termEmitter.ts:344` (`emitCsqlPropertyRefText`) / `:358` (`emitCsqlPropertyRefSegment`) | `lib/case-store/sql/compileTerm.ts:364` → `compilePropertyRef`           |
| `input`            | `lib/domain/predicate/typeChecker.ts:1428`                        | `lib/commcare/predicate/termEmitter.ts:376` (`emitSearchInputXPath`)       | through `wrapTermAsSegmentList` at `:435` (CSQL XPath segment for input ref)      | `lib/case-store/sql/compileTerm.ts:368` → `compileBoundRef("searchInputs")` |
| `session-user`     | `lib/domain/predicate/typeChecker.ts:1439`                        | `lib/commcare/predicate/termEmitter.ts:387` (`emitSessionUserXPath`)       | through `wrapTermAsSegmentList` at `:435` (CSQL XPath segment for session-user)   | `lib/case-store/sql/compileTerm.ts:374` → `compileBoundRef("sessionUser")` |
| `session-context`  | `lib/domain/predicate/typeChecker.ts:1453`                        | `lib/commcare/predicate/termEmitter.ts:398` (`emitSessionContextXPath`)    | through `wrapTermAsSegmentList` at `:435` (CSQL XPath segment for session-context) | `lib/case-store/sql/compileTerm.ts:380` → `compileBoundRef("sessionContext")` |
| `literal`          | `lib/domain/predicate/typeChecker.ts:1481` (delegates to `literalType`) | `lib/commcare/predicate/termEmitter.ts:263` (`emitOnDeviceLiteralValue`) | `lib/commcare/predicate/termEmitter.ts:411` (`emitCsqlLiteralSegment`)            | `lib/case-store/sql/compileTerm.ts:366` → `compileLiteral.ts:122` (shared helper) |

## RelationPath coverage

Relation walks compose into `prop`'s `via` slot, into `exists` /
`missing` predicate operands, and into `count`'s `via` operand.

| RelationPath arm | Type checker                                                   | On-device XPath                                                                                                          | CSQL                                                                                                                  | Postgres compiler                                                                                                          |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `self`           | `lib/domain/predicate/typeChecker.ts:1088`                     | `lib/commcare/predicate/caseListFilterEmitter.ts:468` / `lib/commcare/expression/onDeviceEmitter.ts:278`                  | self collapses upstream; via emitter walking — see `lib/commcare/predicate/csqlEmitter.ts` and `csqlHoist.ts` `exists`/`missing`/`count` arms | `lib/case-store/sql/compileRelationPath.ts:373` (returns `{ kind: "self" }` marker; no subquery)                            |
| `ancestor`       | `lib/domain/predicate/typeChecker.ts:1109`                     | `lib/commcare/predicate/caseListFilterEmitter.ts:492` / `lib/commcare/expression/onDeviceEmitter.ts:281`                  | walked through `exists` / `count` arms inside the predicate / expression CSQL emitters                                | `lib/case-store/sql/compileRelationPath.ts:375` → `buildAncestorLeaf` (chained `case_indices` + `cases` joins per step)     |
| `subcase`        | `lib/domain/predicate/typeChecker.ts:1166`                     | `lib/commcare/predicate/caseListFilterEmitter.ts:498` / `lib/commcare/expression/onDeviceEmitter.ts:283`                  | walked through `exists` / `count` / subcase-count recogniser inside the predicate / expression CSQL emitters          | `lib/case-store/sql/compileRelationPath.ts:382` → `buildSubcaseLeaf` (single-hop reverse-direction join)                    |
| `any-relation`   | `lib/domain/predicate/typeChecker.ts:1167`                     | `lib/commcare/predicate/caseListFilterEmitter.ts:470` / `lib/commcare/expression/onDeviceEmitter.ts:285` (expanded to `(<ancestor> or <subcase>)` per CCHQ wire-grammar gap) | walked through `exists` / `count` arms; expansion to `(<ancestor-form> or <subcase-form>)` per CCHQ wire-grammar gap | `lib/case-store/sql/compileRelationPath.ts:394` → `buildAnyRelationLeaf` (`unionAll` of ancestor + subcase variants)       |

## Cross-arm verification gates

- Every Predicate union arm in the spec V1-IN block (lines 459-469) appears as a per-kind `case` arm in the dispatcher at `lib/case-store/sql/compilePredicate.ts:312-363`.
- Every ValueExpression union arm in the spec V1-IN block (lines 471-478) appears as a per-kind `case` arm in the dispatcher at `lib/case-store/sql/compileExpression.ts:278-317`. The structural arm `unwrap-list` (not on the V1-IN list) is documented separately (defensive Postgres throw + on-device support + CSQL faithful emission for the `selected-any(prop, unwrap-list(...))` wrapper).
- Every Predicate operator carrying `ValueExpression` operand slots (`comparison.left`/`.right`, `in.left`, `between.left`/`.lower`/`.upper`, `is-null.left`, `is-blank.left`, `within-distance.center`) routes through `compileValueExprOperand` at `lib/case-store/sql/compilePredicate.ts:399-407` — the single dispatch helper for term-vs-non-term arms.
- The cross-cycle recursion break (Expression compiler's `if.cond` / `count.where` arms recursing back into the Predicate compiler) lives at `lib/case-store/sql/compilePredicate.ts:422-428` (`expressionContextFor`) — exactly one site, exactly one direction.
- `RelationPath` compiles to `case_indices.depth = 1` per step in `compileRelationPath.ts` so the SQL is materialization-agnostic per spec § "case_indices materialization policy" lines 540-548.

## Coverage discipline going forward

- Adding an arm to either AST union (Predicate or ValueExpression) requires four parallel additions: type-checker case, on-device XPath case, CSQL case (faithful emission OR hoist routing), Postgres compiler case. The TypeScript exhaustiveness check on each compiler's `default: const _exhaustive: never = arm` clause surfaces every missing addition at compile time.
- Adding a new `match` mode requires a parallel addition in this matrix and a per-mode property-type allow-list in the type checker's `MATCH_MODE_PROPERTY_TYPE_ALLOW` table.
- The Postgres-strict null semantic (per `lib/case-store/sql/CLAUDE.md`'s "Postgres-strict null semantics" section) is the contract for `is-null` and `is-blank`; widening either operator's match set is a one-way change to the on-disk AST shape and requires a spec amendment.
