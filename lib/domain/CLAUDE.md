# lib/domain — the blueprint vocabulary

The shape every surface speaks. The agent (`lib/agent`), the doc store (`lib/doc`), the builder (`components/builder`), the wire emitter (`lib/commcare`), the case store (`lib/case-store`), and the preview engine (`lib/preview`) all bind against the Zod schemas here and cross to each other only as these domain shapes. This package is a leaf — it imports none of them.

**The schemas ARE the reference.** `blueprint.ts`, `fields/*`, `forms.ts`, `modules.ts`, `xpath/`, and `predicate/` (its own `CLAUDE.md`) are the authoritative shape; this doc holds only the few truths the schemas can't state.

## BlueprintDoc — normalized, with derived state stripped at the boundary

An app is UUID-keyed records (`modules` / `forms` / `fields`) plus parallel order arrays (`moduleOrder` / `formOrder` / `fieldOrder`) — not a nested tree. Two slots are derived and NEVER persisted: `fieldParent` (the field→parent reverse index, rebuilt from `fieldOrder` on load) and `refIndex` (the reference index, built on demand — see `lib/doc`). The type system enforces the strip: `PersistableDoc` is the on-disk shape, `BlueprintDoc` adds the derived slots for in-memory use, and `PersistedBlueprint` (a `never`-typed wall) is what every writer takes so an unstripped doc can't serialize its derived state.

`caseTypes` is a **generation-time catalog**, not a runtime authority: a case type's property defaults bake onto a field when the field is added, so **fields are self-contained** and the catalog is never consulted again at emit or runtime.

## Two identities per field — and which to use

Every field carries a mutable **semantic `id`** (this IS the CommCare property name / XForm node name; unique among siblings) and an immutable **stable `uuid`** (assigned at creation, never changes on rename). Use the `uuid` for UI identity (React keys, DOM selectors, drag IDs) and for cross-entity references that must survive a rename (form-link targets, the close-condition's checked field, expression identity leaves all point by uuid); use the `id` / path for mutations and for the expander/compiler.

**`case_property_on` names a case TYPE, not a property.** The field saves to the case type named there; the property it writes is the field's own `id`. The `_on` suffix is load-bearing — it forces the prepositional reading and keeps the SA from treating the value as a property name and corrupting field ids. Naming the module's own type is an ordinary property write; naming a different type auto-derives child-case creation. (Don't confuse it with `CasePropertyMapping.case_property` in `blueprint.ts`, which genuinely holds a property NAME — the one place the bare word survives, at the CommCare-flavored mapping boundary.)

## Fields are a registry, not a switch

Each field kind is one file under `fields/`, and the union (`fieldSchema`) discriminates on `kind`. Each kind's schema declares ONLY the slots it actually has — which is the structural reason a wrong-property-for-kind state is unexpressible (it's also why the SA's per-kind tool arms can't carry a slot the kind lacks). `kinds.ts` holds the per-kind metadata table (`FieldKindMetadata` — XForm control + data type, icon, label, `convertTargets`, the three-section editor schema) that the compiler, validator, editor panel, and SA tool-schema generator all read from ONE place: **adding a kind is one `fields/` file + a registry entry; adding a property is one schema field + one editor entry.** The two containers (`group`, `repeat`) are kinds, not a parallel tree — their children are the fields whose `fieldOrder` entry names them.

## Forms and modules

**Four form types** (`forms.ts`): `registration` creates a case, `followup` updates one, `close` loads + closes (a superset of followup), `survey` touches no case. Use the centralized sets — `CASE_FORM_TYPES`, `CASE_LOADING_FORM_TYPES` (`{followup, close}`) — never ad-hoc string comparisons. `isCaseFirstModule` mirrors `commcare-core`'s `getDataNeededByAllEntries` exactly (a module lands on its case list only when every form is case-loading); `defaultPostSubmit` is the form-type-aware navigation default.

A `Module` (`modules.ts`) carries an optional `caseType`, the `caseListConfig` (a `Column[]` of seven kinds + an optional `filter` predicate + `searchInputs`), and the `caseSearchConfig` (search-screen display + niche filters). These structured configs are the single source of truth every case-list surface reads — validator, wire emitters, SA tools, and the case-list workspace UI. Their AST-typed slots (the filter, calculated-column expressions, search-input predicates/defaults) come from `lib/domain/predicate`. Sort lives per-column (direction + priority); the comparator TYPE is derived at wire emission from the property's `data_type`, never authored.

## Expressions, Connect, media live where their boundary is

XPath-bearing slots store the typed AST from `xpath/` — **references are identity, text is a projection** (`printXPath`); renames never rewrite stored expressions. The Predicate / ValueExpression AST (`predicate/`) is the boolean + typed-value family behind filters, calculated columns, and search. Connect is a per-form opt-in (`form.connect`) gated by the app-level `connectType` (`learn` | `deliver` | null); the sub-config ids are deliberately transient-optional here and forced valid+unique at runtime (autofill + the emit-time tripwire — see `lib/agent` and `lib/commcare/connectDefaults.ts`). The media primitives (`AssetId`, `Media`, MIME partitions, size caps, the export ceiling, GCS key derivations) live in `multimedia.ts`; the verdicts, manifest, and wire emission live in `lib/media`.
