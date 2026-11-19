"""An expression of a suite spelled with other whitespace or other quote marks around its strings.

HQ's build writes a stored expression into the suite as its author typed it:
a calculated column's text into its detail's ``xpath@function``
(``detail_screen.py``, ``$calculated_property``) and a case list's filter into
the entry's datum ``@nodeset`` (``suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath``).
Nova writes each in its own spelling: one space around an operator and after
a comma, and a string in single quotes. Every reader of a suite reads an
attribute Core's suite parsers hand to ``XPathParseTool.parseXPath``
(``proof/rules/_suite.py::XPATH_ATTRIBUTES``) through Core's parser, whose
lexer skips whitespace between tokens and gives a string token the text
between its quote marks, whichever they are
(``org/javarosa/xpath/parser/Lexer.java::lex``, ``Token.STR`` with
``expr.substring(i + 1, end)``), and whose parser builds the expression from
those tokens alone (``Parser.parse``): Formplayer and CommCare Android load
the suite with Core's own parsers, and the Web Apps client shows what
Formplayer evaluates.

The rule writes each such attribute as its tokens, read with the port of
Core's lexer (``proof/rules/_xpath.py::spans``), one space between two, each
string in single quotes, or in double quotes where it holds a single quote.
Two texts the lexer reads as the same tokens, a string by its value, are
then one text, and two it reads as different tokens stay two: each written
token lexes back as itself, so the written text gives back the tokens it was
written from. A text the port does not read is left as it is.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._suite import rewrite_expressions
from proof.rules._xpath import spans, string_value


def written(text):
    """``text`` as its tokens, one space between two and each string quoted as the rule says; ``text`` where the
    port of Core's lexer does not read it."""
    found = spans(text)
    if found is None:
        return text
    parts = []
    for token, _ in found:
        if token.kind == "STR":
            value = string_value(token)
            parts.append(f'"{value}"' if "'" in value else f"'{value}'")
        else:
            parts.append(token.text)
    return " ".join(parts)


def normalize(root):
    return rewrite_expressions(root, written)


RULE = SpellingRule(
    "suite-xpath-lexemes",
    ("suite.xml", "*/suite.xml"),
    "An expression of a suite spelled with other whitespace between its tokens or other quote marks around a"
    " string, which Core's lexer reads as the same tokens (Lexer.lex).",
    normalize,
    readers=(
        ("formplayer", "test_formplayer_walks_a_suite_expression_alike_in_either_spelling"),
        ("webapps", "test_formplayer_walks_a_suite_expression_alike_in_either_spelling"),
        ("android", "test_a_list_reads_a_suite_expression_alike_in_either_spelling"),
    ),
)
