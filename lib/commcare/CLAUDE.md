# lib/commcare

One-way emission boundary. This package owns CommCare's wire vocabulary — everything else in `lib/` talks to CommCare through the `@/lib/commcare` barrel and its sub-paths; nothing in this package reaches back into domain/doc state except via explicit parameters.

## Barrel surface (`index.ts` re-exports)

- `constants` — reserved case properties, case-type/property/xform-path regexes, length limits, media field kinds.
- `types` — TypeScript interfaces for the HQ import JSON (`HqApplication`, `HqModule`, `HqForm`, `FormActions`, `DetailPair`, etc.).
- `hqShells` — factory functions that stamp out boilerplate HQ JSON structures (`applicationShell`, `moduleShell`, `formShell`, `detailPair`, condition factories).
- `hashtags` — Vellum hashtag expansion (`#form/`, `#case/`, `#user/`) via the shared Lezer XPath parser, with the `VELLUM_HASHTAG_TRANSFORMS` table.
- `ids` — hex-id generators for HQ `unique_id` / xmlns URIs.
- `identifierValidation` — CommCare identifier guards (`validateCaseType`, `validateXFormPath`, `validatePropertyName`, `isReservedProperty`) and the `toSnakeId` slugifier.
- `session` — session datums, stack operations, post-submit destination → stack derivation, entry-definition assembly, and the `PostSubmitDestination` ↔ HQ workflow string mapping.
- `xml` — the single XML escape helper used across XForm + suite emission.

## Sub-paths imported directly (not re-exported)

- `@/lib/commcare/xpath` — Lezer grammar + parser, export-time transpiler, and parser-backed helpers like `detectUnquotedStringLiteral` (see its CLAUDE.md). Imported directly because it has its own focused surface (`parser`, `transpile`, parser term constants, `detectUnquotedStringLiteral`).
- `@/lib/commcare/validator` — deep pre- and post-expansion validator. Callers import named modules (`/runner`, `/errors`, `/fixes`, `/xformValidator`, `/xpathValidator`, `/functionRegistry`) so the full rule surface isn't pulled into every consumer.
- `@/lib/commcare/client` — server-only HQ REST API client.
- `@/lib/commcare/encryption` — KMS wrapper for user API keys at rest.
