# CommCare XPath Language (CodeMirror 6)

XPath 1.0 language with CommCare hashtag references (`#case/prop`, `#form/question`, `#user/prop`), built on a Lezer grammar.

## Grammar design decisions

- **Hashtag refs use `!hashtag` precedence on the inner `/`**. Without this, the parser reduces early and treats the `/` as a child-step operator, splitting `#case/property` into a hashtag followed by a path.
- **Keyword operators (`and`, `or`, `div`, `mod`) use `@specialize` wrapped in uppercase `Keyword<w>`.** Lowercase inline rules make specialized tokens invisible in the parse tree, breaking consumers that need to identify operators.
- **Standalone `/` has dynamic precedence `~-10`** so path interpretation (`/step`) wins over bare root — the correct behavior in virtually all CommCare XPath.
- **Number literals beat `"."`** in token precedence so `.666` parses as a number, not a self-step followed by digits.

## Node type comparisons

Always use pre-resolved `NodeType` objects from `parser.nodeSet.types` (the `T` lookup), never string name comparisons. Applies to operators, delimiters, keywords, and composite node types.
