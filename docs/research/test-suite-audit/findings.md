# Findings from the test-suite audit

This records behavior discovered by executing replacement tests. The audit is
still in progress; `manifest.json` tracks direct file review separately from
passing tests.

## Compiler defects corrected during review

- A blank check over numeric arithmetic tried to compare the numeric result
  directly with an empty string. Postgres rejected a domain-valid expression
  before it could filter rows. Computed and bound scalar blank checks now use
  their text projection; the tests include null, blank, number, boolean, and
  timestamp bindings.
- Ordinary numeric literals had no SQL type. A prepared `1 + 2` expression
  failed with `operator is not unique: unknown + unknown`. The old arithmetic
  tests added explicit literal types to avoid that failure. The compiler now
  supplies integer/numeric types and the replacement tests use ordinary
  authored literals, fractions, and values outside int4 range.
- Nested arithmetic did not preserve AST grouping: `(2 + 3) * 4` returned `14`,
  and `10 - (5 - 2)` was exposed to SQL's left associativity. Arithmetic nodes
  now retain parentheses. Real Postgres assertions require `20` and `7`.

## Unresolved arithmetic contract discrepancy

Nova's current domain checker resolves `int div int` to `int`, and its Postgres
runtime returns `3` for `10 div 3`. CommCare Core's `XPathArithExpr.evalRaw`
converts both operands to doubles and uses `aval / bval`; its result retains
the fraction. The on-device emitter currently emits the division directly.

Evidence inspected locally:

- `lib/domain/predicate/typeChecker.ts`, the `arith` result-type rule.
- `lib/commcare/expression/onDeviceEmitter.ts`, arithmetic emission.
- `commcare-core/src/main/java/org/javarosa/xpath/expr/XPathArithExpr.java`,
  `evalRaw` and `DIVIDE`.
- [Postgres mathematical operators](https://www.postgresql.org/docs/18/functions-math.html),
  which specify truncation for division of integral operands.

The literal/grouping fixes preserve the current Nova type contract. Changing
that contract needs a decision covering existing integer destinations and
saved expressions, followed by validation across SQL and wire consumers. This
is an open finding, not a claim of arithmetic parity across targets.
