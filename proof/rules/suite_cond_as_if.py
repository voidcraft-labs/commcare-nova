"""A call of ``cond`` with three arguments in a suite's expression, where Nova writes ``if``.

CommCare HQ's own apps write ``cond(test, value, otherwise)`` in a
calculated column (the WASH starter app's task and status columns), and HQ's
build writes the stored text into the suite (``detail_screen.py``,
``$calculated_property``). Nova's reader holds ``cond`` in a record slot as
the nested ``if`` it equals (``lib/commcare/reader/syntaxCompare.ts``,
``reader/expressions/folds.ts::condFold``) and its emitter prints ``if``.

Core builds the two as two classes (``parser/ast/ASTNodeFunctionCall.java::buildFuncExpr``:
``XPathIfFunc``, ``XPathCondFunc``) that evaluate alike for every argument
of a three-argument call: both are built with ``evaluateArgsFirst`` false, so
neither evaluates an argument before its body
(``expr/XPathFuncExpr.java::evaluateArguments``), and both bodies read the
first argument through ``FunctionUtils.toBoolean`` and evaluate and return
the second where it is true and the third where it is not
(``expr/XPathIfFunc.java::evalBody``; ``expr/XPathCondFunc.java::evalBody``,
whose loop over the pairs runs once for three arguments before it returns
the last). Core's evaluation looks a function up among the context's custom
handlers by its name first (``XPathFuncExpr.evalRaw``); the handlers a
suite's readers add are ``format_date`` and ``dow`` (``suite/model/Text.java``)
and ``here`` (Formplayer's ``FormplayerHereFunctionHandler``, CommCare
Android's ``EntitySelectActivity.getHereFunctionHandler``), so neither name
reaches one. Formplayer and CommCare Android read a suite with Core's own
parsers, and the Web Apps client shows what Formplayer evaluates.

The rule writes ``if`` for the name of each call of ``cond`` with exactly
three arguments in an attribute Core's suite parsers read as XPath
(``proof/rules/_suite.py::XPATH_ATTRIBUTES``), found with the port of Core's
lexer (``proof/rules/_xpath.py::spans``): a name followed by ``(``, which Core's
parser always builds as that function's call (``Parser.parseFuncCalls``), its
arguments the parts its commas at the call's own depth divide. A call of
``cond`` with more arguments, which Nova prints as ``if`` nested in ``if``,
is a tree of another shape and is left as it is, as is a text the port does
not read.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._suite import rewrite_expressions
from proof.rules._xpath import spans

# The brackets that nest inside a call's argument list: parentheses and a predicate's square brackets.
_OPENS = frozenset({"LPAREN", "LBRACK"})
_CLOSES = frozenset({"RPAREN", "RBRACK"})


def _argument_count(found, opening):
    """How many arguments the call whose ``(`` is ``found[opening]`` holds, or None where its ``)`` never comes."""
    depth, commas = 0, 0
    for index in range(opening, len(found)):
        kind = found[index][0].kind
        if kind in _OPENS:
            depth += 1
        elif kind in _CLOSES:
            depth -= 1
            if depth == 0:
                return 0 if index == opening + 1 else commas + 1
        elif kind == "COMMA" and depth == 1:
            commas += 1
    return None


def as_if(text):
    """``text`` with each three-argument call of ``cond`` named ``if``; ``text`` where the port does not read it."""
    found = spans(text)
    if found is None:
        return text
    starts = [
        start
        for index, (token, start) in enumerate(found[:-1])
        if token.kind == "QNAME"
        and token.text == "cond"
        and found[index + 1][0].kind == "LPAREN"
        and _argument_count(found, index + 1) == 3
    ]
    for start in reversed(starts):
        text = text[:start] + "if" + text[start + len("cond") :]
    return text


def normalize(root):
    return rewrite_expressions(root, as_if)


RULE = SpellingRule(
    "suite-cond-as-if",
    ("suite.xml", "*/suite.xml"),
    "A three-argument cond() in a suite's expression, which Core evaluates as the if() Nova writes"
    " (XPathCondFunc.evalBody, XPathIfFunc.evalBody).",
    normalize,
    readers=(
        ("formplayer", "test_formplayer_walks_a_cond_and_its_if_alike"),
        ("webapps", "test_formplayer_walks_a_cond_and_its_if_alike"),
        ("android", "test_a_list_reads_a_cond_and_its_if_alike"),
    ),
)
