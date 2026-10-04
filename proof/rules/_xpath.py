"""What Core's XPath lexer makes of an expression, for the rules that read a path's or a value's shape.

A private helper of the rule modules (``proof.rules.unregistered_rules``
reads a module whose name starts with ``_`` as no rule). The rules run in
the judges, which never start the Core runner, so ``tokens`` is commcare-core
``org/javarosa/xpath/parser/Lexer.java::lex`` ported branch for branch:
the same tokens, in the same order, from the same characters, with the
same switch between reading a value and reading an operator. Core's lexer
tells letters and digits by Java's ``Character`` classes; this port reads
the ASCII ones alone, where Java and Python agree, and a text holding any
other character outside a string literal is not read (None), so a rule
leaves it as it stands. ``proof/rules/test_xpath_reading.py`` holds the
port to Core's own parser, through the runner's ``xpathParse``.

On those tokens, the shapes the rules ask about are read exactly, never
guessed from the text:

- ``plain_path``: an absolute path whose every step names a child by an
  unprefixed name, the last perhaps an attribute (``/data/a/@b``), spelled
  with nothing between its tokens. Core's parser builds it as one
  ``XPathPathExpr`` from the root whose steps are named child steps and a
  named attribute step; such a path names the same nodes in any context,
  and two of them name one node only where they are one text.
- ``node_free``: a value that reads no node: a string literal, a number
  literal (negated or not), or a call of ``now()``, ``today()`` or
  ``uuid()`` with no argument, which Core builds as ``XPathNowFunc``,
  ``XPathTodayFunc`` and ``XPathUuidFunc``.
- ``calls``: the functions an expression calls: each name followed by
  ``(``, which Core's parser always builds as that function's call
  (``Parser.parseFuncCalls``), and whether an argument follows the ``(``.
"""

from __future__ import annotations

from dataclasses import dataclass

_WHITESPACE = " \n\t\f\r"
# The tokens after which Core's lexer reads an operator (Lexer.LEX_CONTEXT_OP); after any other it reads a value.
_ENDS_A_VALUE = frozenset(
    {"WILDCARD", "NSWILDCARD", "QNAME", "VAR", "NUM", "STR", "RBRACK", "RPAREN", "DOT", "DBL_DOT"}
)
# Core's operator words, read only where an operator may stand.
_OPERATOR_WORDS = (("and", "AND"), ("or", "OR"), ("div", "DIV"), ("mod", "MOD"))
_SINGLE = {"=": "EQ", "+": "PLUS", "|": "UNION", "[": "LBRACK", "]": "RBRACK", "(": "LPAREN", ")": "RPAREN"}
_SINGLE.update({"@": "AT", ",": "COMMA"})
# The calls whose value reads no node: Core's clock and its id function, with no argument.
NODE_FREE_CALLS = frozenset({"now", "today", "uuid"})


@dataclass(frozen=True)
class Token:
    """One token of Core's lexer: its ``Token`` constant's name, and the characters it was read from."""

    kind: str
    text: str


class _Unread(Exception):
    """The lexer refuses the text (Core's ``badParse``), or the text holds a character this port does not read."""


def _ascii_letter(c):
    return ("a" <= c <= "z") or ("A" <= c <= "Z")


def _ascii_digit(c):
    return "0" <= c <= "9"


def _char(text, i):
    """The character at ``i``, or ``""`` past the end (Core's ``getChar`` answers -1 there)."""
    if i >= len(text):
        return ""
    if not text[i].isascii():
        raise _Unread
    return text[i]


def _numeric(text, i):
    """How many characters from ``i`` Core's ``matchNumeric`` reads: digits and one decimal point."""
    start, seen_point = i, False
    while i < len(text):
        c = _char(text, i)
        if not (_ascii_digit(c) or (not seen_point and c == ".")):
            break
        seen_point = seen_point or c == "."
        i += 1
    return i - start


def _ncname(text, i):
    """How many characters from ``i`` Core's ``matchNCName`` reads."""
    start = i
    while i < len(text):
        c = _char(text, i)
        if not (_ascii_letter(c) or c == "_" or (i > start and (_ascii_digit(c) or c in ".-"))):
            break
        i += 1
    return i - start


def _qname(text, i):
    """How many characters from ``i`` Core's ``matchQName`` reads: a name, and a second after one colon."""
    length = _ncname(text, i)
    if length > 0 and _char(text, i + length) == ":":
        second = _ncname(text, i + length + 1)
        if second > 0:
            length += second + 1
    return length


def _next(text, i, reading_value):
    """The token at ``i`` and how many characters it takes; None for whitespace, which Core skips."""
    c = _char(text, i)
    # The character after it, compared only with ASCII ones; a string literal's first character may be any.
    d = text[i + 1] if i + 1 < len(text) else ""
    if c in _WHITESPACE:
        return None, 1
    if c in _SINGLE:
        return _SINGLE[c], 1
    if c == "!" and d == "=":
        return "NEQ", 2
    if c in "<>":
        kind = "LT" if c == "<" else "GT"
        return (kind + "E", 2) if d == "=" else (kind, 1)
    if c == "-":
        return ("UMINUS" if reading_value else "MINUS"), 1
    if c == "*":
        return ("WILDCARD" if reading_value else "MULT"), 1
    if c == "/":
        return ("DBL_SLASH", 2) if d == "/" else ("SLASH", 1)
    if c == ".":
        if d == ".":
            return "DBL_DOT", 2
        if d and not d.isascii():
            raise _Unread
        if d and _ascii_digit(d):
            return "NUM", _numeric(text, i)
        return "DOT", 1
    if c == ":" and d == ":":
        return "DBL_COLON", 2
    if not reading_value:
        for word, kind in _OPERATOR_WORDS:
            if text[i : i + len(word)] == word:
                return kind, len(word)
    if c == "$":
        length = _qname(text, i + 1)
        if length == 0:
            raise _Unread
        return "VAR", length + 1
    if c in "'\"":
        end = text.find(c, i + 1)
        if end == -1:
            raise _Unread
        return "STR", end - i + 1
    if _ascii_digit(c):
        return "NUM", _numeric(text, i)
    if reading_value and (_ascii_letter(c) or c == "_"):
        length = _qname(text, i)
        name = text[i : i + length]
        if ":" not in name and _char(text, i + length) == ":" and _char(text, i + length + 1) == "*":
            return "NSWILDCARD", length + 2
        return "QNAME", length
    raise _Unread


def tokens(text):
    """Core's tokens for ``text`` (``Lexer.lex``), or None where Core's lexer refuses it or this port does not read
    a character of it."""
    if not isinstance(text, str):
        return None
    found, i, reading_value = [], 0, True
    try:
        while i < len(text):
            kind, length = _next(text, i, reading_value)
            if kind is not None:
                found.append(Token(kind, text[i : i + length]))
                reading_value = kind not in _ENDS_A_VALUE
            i += length
    except _Unread:
        return None
    return tuple(found)


def plain_path(text):
    """Whether ``text`` is an absolute path of named child steps, the last perhaps a named attribute, with no
    prefix on any name and nothing between its tokens (the module's docstring)."""
    found = tokens(text)
    if not found or "".join(token.text for token in found) != text:
        return False
    kinds = [token.kind for token in found]
    # A last step ``@name`` reads as a named step; ``@*`` or ``@`` before anything but a name does not.
    if kinds[-2:] == ["AT", "QNAME"]:
        kinds = kinds[:-2] + ["QNAME"]
    named = all(token.kind != "QNAME" or ":" not in token.text for token in found)
    return kinds == ["SLASH", "QNAME"] * (len(kinds) // 2) and named


def node_free(text):
    """Whether ``text`` is a value that reads no node (the module's docstring)."""
    found = tokens(text)
    if not found:
        return False
    kinds = [token.kind for token in found]
    if kinds in (["STR"], ["NUM"], ["UMINUS", "NUM"]):
        return True
    return kinds == ["QNAME", "LPAREN", "RPAREN"] and found[0].text in NODE_FREE_CALLS


def calls(text):
    """Each call ``text`` holds, in order, as ``(name, whether an argument follows its "(")``; None where this port
    does not read the text, which may then call anything."""
    found = tokens(text)
    if found is None:
        return None
    return [
        (token.text, index + 2 < len(found) and found[index + 2].kind != "RPAREN")
        for index, token in enumerate(found[:-1])
        if token.kind == "QNAME" and found[index + 1].kind == "LPAREN"
    ]
