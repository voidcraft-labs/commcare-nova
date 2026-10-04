"""What Core evaluates an app's expressions against: the session instance, the instance sources,
the XPath functions registered outside Core's parser, and Core's XPath grammar.

Keys:

- ``session-path:<path>``: each element ``SessionInstanceBuilder.getSessionInstance``
  builds (``session-path:session/context/deviceid``), read by the Java
  helper's tree pass over the builder and its helpers. A step ``*`` is an
  element named at run time (``session/data/*``, a datum's id), with the
  expression that names it; each records the value it is given and the
  conditions it is built and added under.
- ``instance-source:<token>``: each branch of ``CommCareInstanceInitializer.generateRoot``,
  keyed by what it tests an instance's ``src`` for (``instance-source:casedb``,
  ``instance-source:jr://instance/remote``), with its place in the dispatch
  order, the test (``contains`` or ``startsWith``), the setup method it runs,
  the subclasses (Core's command line, Android) that override that setup, and
  what the setup throws. ``instance-source:(none)`` is what an unmatched
  ``src`` gets.
- ``jr-handler:<name>``: each XPath function a runtime registers on an
  evaluation context (``addFunctionHandler``) rather than Core's parser
  building it (``jr-handler:jr:itext``, ``jr-handler:here``), with each
  registration's place, platform, handler class, argument prototypes and
  whether it takes its arguments raw. Kotlin registrations are read as tokens.
- ``xpath-token:<TOKEN>``: each token type of Core's XPath lexer (the
  ``Token`` constants), with the conditions under which ``Lexer.lex`` makes it
  and the text it is made from, and for an operator the expression it builds,
  the order ``Parser.parseOperators`` applies it in and its associativity.
- ``xpath-axis:<AXIS_...>`` and ``xpath-test:<TEST_...>``: each axis and node
  test of ``XPathStep``, with the name the parser accepts for it and, for an
  axis, whether Core makes a reference (``XPathPathExpr.getReference``, run on
  Core's own classes) of a step on it with each node test, or the refusal.
- ``xpath-expr:<Class>``: each expression class Core's parser builds, with
  where, the path contexts it is built with, whether evaluating it refuses
  (``XPathUnionExpr``, ``XPathFilterExpr``), and for ``XPathPathExpr`` the
  functions a filter expression may start a reference with.
"""

from __future__ import annotations

from pathlib import Path

from proof.surface.families.data import name
from proof.surface.java import run_java
from proof.surface.model import Item, Sources, SurfaceError, item


def extract(sources: Sources) -> list[Item]:
    return [
        *session_paths(sources),
        *instance_sources(sources),
        *function_handlers(sources),
        *xpath_grammar(sources),
    ]


def session_paths(sources: Sources, core: Path | None = None) -> list[Item]:
    read = run_java(sources, "session", core)
    items = []
    for path, facts in sorted(read.items()):
        built = facts["built"]
        where = sorted({one[field] for one in built for field in ("builtAt", "addedAt") if field in one})
        items.append(item(f"session-path:{name(path)}", where, built=built))
    return items


def instance_sources(sources: Sources, core: Path | None = None, android: Path | None = None) -> list[Item]:
    read = run_java(sources, "instance-sources", core, android)
    items = []
    initializers = read["initializers"]
    for branch in read["branches"]:
        setup = branch["setup"]
        overridden = {
            initializer: {"platform": facts["platform"], "at": facts["at"]}
            for initializer, facts in sorted(initializers.items())
            if setup in facts["overrides"]
        }
        items.append(
            item(
                f"instance-source:{name(branch['token'] or branch['test'])}",
                branch["at"],
                order=branch["order"],
                test=branch["test"],
                match=branch["match"],
                setup=setup,
                setupOverriddenBy=overridden,
                setupRaises=read["raises"].get(setup, []),
            )
        )
    fallback = read["fallback"]
    items.append(item("instance-source:(none)", fallback["at"], order=fallback["order"], returns=fallback["returns"]))
    return items


def function_handlers(sources: Sources, core: Path | None = None, android: Path | None = None) -> list[Item]:
    read = run_java(sources, "wide", core, android)["functionHandlers"]
    by_name: dict[str, list[dict]] = {}
    for registration in read:
        if registration["name"] is None:
            raise SurfaceError(
                f"A runtime registers an XPath function handler at {registration['at']} "
                f"({registration['expression']}), and the surface extractor could not tell which function it answers. "
                "The function handler reader (proof/surface/java/.../Runtimes.java) must learn how this handler "
                "is made."
            )
        by_name.setdefault(registration["name"], []).append(registration)
    return [
        item(
            f"jr-handler:{name(function)}",
            sorted({one["at"] for one in registrations}),
            registrations=sorted(registrations, key=lambda one: (one["at"], one["expression"])),
        )
        for function, registrations in sorted(by_name.items())
    ]


def xpath_grammar(sources: Sources, core: Path | None = None) -> list[Item]:
    read = run_java(sources, "xpath-grammar", core)
    lexer = "commcare-core/src/main/java/org/javarosa/xpath/parser/Lexer.java::Lexer.lex"
    step = "commcare-core/src/main/java/org/javarosa/xpath/expr/XPathStep.java::XPathStep"
    items = [
        item(
            f"xpath-token:{token}",
            [lexer, "commcare-core/src/main/java/org/javarosa/xpath/parser/Token.java::Token"],
            **facts,
        )
        for token, facts in sorted(read["tokens"].items())
    ]
    items += [item(f"xpath-axis:{axis}", step, **facts) for axis, facts in sorted(read["axes"]["axes"].items())]
    items += [item(f"xpath-test:{test}", step, **facts) for test, facts in sorted(read["axes"]["tests"].items())]
    items += [
        item(f"xpath-expr:{expression}", facts["builtBy"], **{k: v for k, v in facts.items() if k != "builtBy"})
        for expression, facts in sorted(read["expressions"].items())
    ]
    return items
