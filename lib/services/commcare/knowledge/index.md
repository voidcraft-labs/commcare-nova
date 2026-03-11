# CommCare Knowledge Base

Reorganized platform knowledge for the Solutions Architect agent.
Generated on 2026-03-11.

## Topics

- **[Question Types Reference](question-types-reference.md)** — Complete reference of all CommCare question types, their data storage behavior, appearance attributes, and platform differences between Android and Web Apps.
- **[Form Logic & Expression Patterns](form-logic-expressions.md)** — XPath expression patterns for display conditions, validation conditions, calculate conditions, default values, and hidden values in CommCare forms.
- **[Case Types & Properties](case-types-and-properties.md)** — How cases work, case property naming rules, data types, reserved properties, and how to save/load case data in forms.
- **[Parent-Child & Extension Case Structures](parent-child-cases.md)** — How to structure case hierarchies using parent-child and extension relationships, including XPath patterns for traversing relationships.
- **[Case List & Case Detail Configuration](case-list-configuration.md)** — How to configure case list columns, display formats, calculated properties, filtering, sorting, and case detail tabs including nodesets.
- **[Case Search & Claim Configuration](case-search-claim.md)** — Server-side case search configuration including search properties, default search filters, _xpath_query CSQL syntax, and search workflows.
- **[Case Closure & Automatic Case Updates](case-closure-and-automation.md)** — Patterns for closing cases from forms, automatic case update rules, and server-side rule configuration.
- **[Case Sharing & Ownership](case-sharing-ownership.md)** — How case ownership works, case sharing groups, location-based sharing, and owner_id assignment patterns.
- **[Save to Case](save-to-case.md)** — Advanced case operations using Save to Case questions, including creating/updating arbitrary cases, repeat group patterns, and relative path behavior.
- **[Repeat Groups & Nested Data](repeat-groups.md)** — Repeat group types, XPath reference patterns inside/outside repeats, position(), current(), model iteration, and common pitfalls.
- **[Module & Menu Configuration](module-configuration.md)** — Module types (Survey, Case List, Advanced, Shadow, Report), navigation, case tag naming, and advanced module form-level case actions.
- **[Lookup Tables & Fixtures](lookup-tables-fixtures.md)** — How lookup tables work, instance declarations, XPath query patterns, cascading selects, multilingual tables, indexing, and access control.
- **[Location Hierarchy & Fixture XPath](location-fixture-xpath.md)** — How the locations fixture works, XPath patterns for accessing location data, ancestor lookups, and location-based owner assignment.
- **[Instance Declarations & URI Reference](instance-declarations-reference.md)** — Complete reference of all named instances available in CommCare forms, their URIs, and access patterns.
- **[User Properties & Session Data](user-properties-session-data.md)** — Custom user data configuration, XPath access patterns, built-in user properties, and user case references.
- **[GPS & Distance Calculation Patterns](gps-distance-patterns.md)** — GPS data format, component extraction, distance() function, auto-capture configuration, and map display requirements.
- **[XPath Performance & Optimization](xpath-performance-optimization.md)** — Critical performance rules for XPath expressions including indexed property ordering, casedb query patterns, calculation tree management, and case list caching.
- **[Application Design Limits & Guidelines](app-design-soft-limits.md)** — Soft limits, hard limits, and performance thresholds for app structure, data volumes, and case counts.
- **[Case Design Patterns](case-design-patterns.md)** — Common case architecture patterns including tasking, referrals, deduplication, rolling history, counter/incrementing, and impact tracking.
- **[Form Navigation & End-of-Form Behavior](form-navigation-end-of-form.md)** — End-of-form navigation options, form linking, form display conditions, menu/module display conditions, and session endpoint patterns.
- **[Multilingual App Configuration](multilingual-apps.md)** — How to configure multiple languages, translation architecture, language switching behavior, and lookup table multilingual patterns.
- **[Multimedia, Icons & Text Formatting](multimedia-icons-formatting.md)** — Static multimedia in forms, icon configuration in case lists and modules, custom icon badges, markdown formatting, and accessibility patterns.
- **[Conditional Alerts & Messaging Patterns](conditional-alerts-messaging.md)** — How conditional alerts work, schedule types, custom daily schedules, SMS survey configuration, and required case properties for messaging.
- **[Data Security & Encryption](data-security-encryption.md)** — The encrypt-string() function, AES-GCM implementation details, and security design patterns.
- **[Visit Scheduler & Model Iteration](visit-scheduler-advanced-modules.md)** — Visit scheduler configuration, phase-based scheduling, and model iteration patterns for iterating forms over dynamic case sets.
- **[Custom App Properties Reference](custom-app-properties.md)** — Key-value properties set on apps that control GPS behavior, sync, navigation, security, and display settings.
- **[Feature Flags Reference](feature-flags-reference.md)** — Feature flag categories, key flags needed for specific features, and guidance on which flags are safe to design around.
- **[Data Registry & Cross-Domain Access](data-registry.md)** — How data registries enable cross-project-space case search and the constraints on accessing registry data in forms.
- **[XPath Function Reference](xpath-function-reference.md)** — Complete reference of XPath functions available in CommCare including string, date, math, nodeset, and CommCare-specific functions.
- **[Mobile UCR & Report Modules](mobile-ucr-reports.md)** — How mobile UCRs deliver report data to devices, fixture structure (V1 vs V2), XPath access patterns, chart configuration, and sync delay.
- **[Form Validation & Error Patterns](form-submission-validation.md)** — Build-time validation errors, reserved case property names, runtime validation behavior, and common error causes.
