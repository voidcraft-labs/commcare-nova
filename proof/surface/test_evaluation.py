"""The session instance, the instance sources, the registered XPath functions and Core's XPath grammar.

Contracts and the failures they catch:
- The session paths are the elements Core builds: running Core's own
  ``SessionInstanceBuilder.getSessionInstance`` on a frame with two case
  datums and a typed query, and a user property, gives exactly the item paths
  (a datum's or a user property's name standing for ``*``), so a builder
  helper the tree pass does not follow, or a wrong parent, fails.
- The instance sources are in Core's dispatch order: running Core's own
  ``generateRoot`` on a ``src`` holding two tokens reaches the setup of the
  branch the items order first (``ledgerdb`` before ``casedb``), each
  single-token ``src`` the branch whose test it meets, and an unknown one the
  empty root. A planted branch in a temporary copy takes its place in the
  order.
- The functions a form's evaluation context holds (``FormDef.initEvalContext``,
  read back from Core's compiled classes) are the registrations the family
  records there; ``here`` is registered by Core's command line and by Android
  (in Java and in Kotlin), and a planted Kotlin registration is read.
- Core's own XPath parser builds, for each operator token's lexeme, the
  expression and operator the family records, in the precedence it records;
  for each axis name the parser accepts, the axis and the reference verdict
  it records. A lexeme planted in a temporary copy of the lexer is read.
- A planted element in a temporary copy of the session builder is a path.
"""

from __future__ import annotations

import itertools

from proof.surface.families.evaluation import function_handlers, instance_sources, session_paths, xpath_grammar
from proof.surface.java import run_java

SESSION = "src/main/java/org/commcare/session"
INITIALIZER_DIRS = (
    "src/main/java/org/commcare/core/process",
    "src/main/java/org/commcare/cases/instance",
    "src/main/java/org/javarosa/core/model/instance",
    "src/cli/java/org/commcare/util/mocks",
)
INITIALIZER = "src/main/java/org/commcare/core/process/CommCareInstanceInitializer.java"
# The Core sources the `wide` reading needs to resolve what a planted Android file refers to.
WIDE_CORE = (
    "src/main/java/org/javarosa/form/api",
    "src/main/java/org/javarosa/xform/parse/XFormParser.java",
    "src/main/java/org/javarosa/core/model/condition/HereFunctionHandler.java",
    "src/cli/java/org/commcare/util/screen/ScreenUtils.java",
)


def test_session_paths_are_what_core_builds(items, sources):
    built = run_java(sources, "probe", extra=["session"])
    named = {"case_id", "other_case_id", "user_property"}
    expected = {"/".join("*" if step in named else step for step in path.split("/")) for path in built}
    recorded = {key.split(":", 1)[1] for key in items if key.startswith("session-path:")}
    # `fingerprintquery` needs a callout's results, which the probe's frame does not hold.
    assert expected == recorded - {"session/data/fingerprintquery"}
    assert items["session-path:session/data/*"]["built"][0]["nameFrom"] == "step.getId()"


def test_a_planted_session_element_is_read(plant, sources, items):
    builder = f"{SESSION}/SessionInstanceBuilder.java"
    core = plant(
        sources.core,
        [SESSION],
        {
            builder: (
                '        addData(sessionMeta, "applanguage", applanguage);\n',
                '        addData(sessionMeta, "applanguage", applanguage);\n'
                '        addData(sessionMeta, "planted", deviceId);\n',
            )
        },
    )
    assert "session-path:session/context/planted" in {one.key for one in session_paths(sources, core)}
    assert "session-path:session/context/planted" not in items


def _expected_setup(branches: list[dict], src: str) -> str:
    for branch in sorted(branches, key=lambda b: b["order"]):
        token = branch["token"]
        if branch["match"] == "contains" and token in src or branch["match"] == "startsWith" and src.startswith(token):
            return branch["setup"]
    return None


def test_instance_sources_follow_cores_dispatch_order(items, sources):
    branches = []
    for key, facts in items.items():
        if key.startswith("instance-source:") and key != "instance-source:(none)":
            branches.append({**facts, "token": key.split(":", 1)[1]})
    assert [b["token"] for b in sorted(branches, key=lambda b: b["order"])][:2] == ["ledgerdb", "casedb"]
    probes = ["jr://instance/casedb-ledgerdb", "jr://fixture/casedb", "jr://instance/session"]
    probes += ["jr://instance/remote/results", "jr://instance/selected-entities/a", "jr://instance/nothing-known"]
    reached = run_java(sources, "probe", extra=["instance-source", *probes])
    for src in probes:
        setup = _expected_setup(branches, src)
        if setup is None:
            assert reached[src].endswith("NULL"), (src, reached[src])
        else:
            assert reached[src] == setup, (src, reached[src], setup)
    assert items["instance-source:fixture"]["setupRaises"] == ["FixtureInitializationException"]
    assert "AndroidInstanceInitializer" in items["instance-source:casedb"]["setupOverriddenBy"]


def test_a_planted_branch_takes_its_place_in_the_order(plant, sources, items):
    core = plant(
        sources.core,
        list(INITIALIZER_DIRS),
        {
            INITIALIZER: (
                '        } else if (ref.contains("fixture")) {\n',
                '        } else if (ref.contains("planted")) {\n'
                "            return setupFixtureData(instance);\n"
                '        } else if (ref.contains("fixture")) {\n',
            )
        },
    )
    planted = {one.key: one.facts for one in instance_sources(sources, core)}
    assert planted["instance-source:planted"]["order"] == 3
    assert planted["instance-source:fixture"]["order"] == 4
    assert "instance-source:planted" not in items


def test_registered_functions_are_those_core_registers(items, sources):
    form_handlers = set(run_java(sources, "probe", extra=["form-handlers"]))
    recorded = {
        key.split(":", 1)[1]
        for key, facts in items.items()
        if key.startswith("jr-handler:")
        and any(r["at"].endswith("FormDef.initEvalContext") for r in facts["registrations"])
    }
    assert form_handlers == recorded == {"jr:itext", "jr:choice-name"}
    here = items["jr-handler:here"]["registrations"]
    assert {r["platform"] for r in here} == {"android", "cli"}
    assert any(r["at"].split("::")[0].endswith(".kt") for r in here)
    assert {r["handler"] for r in here} == {"AndroidHereFunctionHandler", "HereDummyFunc"}


def test_a_planted_kotlin_registration_is_read(plant, sources, items):
    loader = "app/src/org/commcare/tasks/EntityLoaderHelper.kt"
    android = plant(
        sources.android,
        [
            loader,
            "app/src/org/commcare/activities/EntitySelectActivity.java",
            "app/src/org/commcare/utils/AndroidHereFunctionHandler.java",
            "app/assets/locales",
        ],
        {
            loader: (
                "class EntityLoaderHelper(",
                "fun plantedRegistration(evalCtx: EvaluationContext) {\n"
                "    evalCtx.addFunctionHandler(EntitySelectActivity.getHereFunctionHandler())\n}\n\n"
                "class EntityLoaderHelper(",
            )
        },
    )
    core = plant(sources.core, list(WIDE_CORE), {})
    planted = {one.key: one.facts for one in function_handlers(sources, core, android)}
    ats = [r["at"] for r in planted["jr-handler:here"]["registrations"]]
    assert any(at.endswith("EntityLoaderHelper.kt::?.plantedRegistration") for at in ats), ats
    assert planted["jr-handler:here"]["registrations"][0]["handler"] == "AndroidHereFunctionHandler"
    assert not any("plantedRegistration" in r["at"] for r in items["jr-handler:here"]["registrations"])


def test_the_grammar_is_what_cores_parser_builds(items, sources):
    operators = {
        key.split(":", 1)[1]: facts
        for key, facts in items.items()
        if key.startswith("xpath-token:") and "binaryOperator" in facts
    }
    lexemes = {name: facts["lexed"][0]["lexeme"] for name, facts in operators.items()}
    expressions = [f"1 {lexeme} 2" for lexeme in lexemes.values()]
    # Precedence: in `a X b Y c`, the operator applied first is outermost.
    pairs = [
        (a, b) for a, b in itertools.permutations(lexemes, 2) if operators[a]["applied"] != operators[b]["applied"]
    ]
    expressions += [f"1 {lexemes[a]} 2 {lexemes[b]} 3" for a, b in pairs]
    axes = {key.split(":", 1)[1]: facts for key, facts in items.items() if key.startswith("xpath-axis:")}
    expressions += [f"{facts['parserName']}::a" for facts in axes.values() if facts["parserName"]]
    parsed = run_java(sources, "probe", extra=["xpath", *expressions])
    for name, facts in operators.items():
        built = parsed[f"1 {lexemes[name]} 2"]
        assert built["class"] == facts["binaryOperator"]["expression"], (name, built)
        if facts["binaryOperator"]["operator"] is not None:
            assert built["op"] == facts["binaryOperator"]["operator"], (name, built)
    for a, b in pairs:
        first = a if operators[a]["applied"] < operators[b]["applied"] else b
        built = parsed[f"1 {lexemes[a]} 2 {lexemes[b]} 3"]
        assert built["class"] == operators[first]["binaryOperator"]["expression"], (a, b, built)
    for facts in axes.values():
        if facts["parserName"]:
            built = parsed[f"{facts['parserName']}::a"]
            assert built["reference"] == facts["referenceByTest"]["TEST_NAME"], (facts, built)
    assert items["xpath-expr:XPathUnionExpr"]["evaluation"].startswith("refuses")
    assert items["xpath-expr:XPathPathExpr"]["referenceFilterHeads"] == ["instance", "current"]


def test_a_planted_lexeme_is_read(plant, sources, items):
    lexer = "src/main/java/org/javarosa/xpath/parser/Lexer.java"
    core = plant(
        sources.core,
        ["src/main/java/org/javarosa/xpath"],
        {
            lexer: (
                "            } else if (c == '|') {\n",
                "            } else if (c == '~') {\n                token = new Token(Token.UNION);\n"
                "            } else if (c == '|') {\n",
            )
        },
    )
    planted = {one.key: one.facts for one in xpath_grammar(sources, core)}
    assert {lexed["lexeme"] for lexed in planted["xpath-token:UNION"]["lexed"]} == {"|", "~"}
    assert {lexed["lexeme"] for lexed in items["xpath-token:UNION"]["lexed"]} == {"|"}
