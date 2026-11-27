"""Whether two texts of a form's expression are one expression, for the stored-app comparison
(``proof.checks.xform_parts``).

Nova prints every expression of a form from its own typed tree, so a first publish writes an expression a form
made in CommCare HQ held in Nova's spelling: its other quote mark, no parentheses its operators' order already
gives, a number without a trailing point, a question's default read from the question itself
(``current()/../a``), a lookup table's instance under the id Nova names it by. Each is the same expression to
every reader. ``tree`` reads a text into the tree Core's parser builds of it, over Core's own tokens
(``proof.rules._xpath.tokens``, the port of ``Lexer.lex``), with the precedence of
``org/javarosa/xpath/parser/Parser.java`` (``or``, ``and``, equality, relation, sum, product, unary minus,
union, path), and ``same`` holds two texts to one tree where each is read in its own form: a string by its
value, a number by its value, a run of ``and`` or of ``or`` as one list of operands (each operator reads its
operands in order and stops at the first that decides), ``instance('<id>')`` as the source its form declares
for that id, and a path that starts at ``current()``, outside every predicate, as the path from the root of the
node the expression is about (inside a predicate Core reads the two against different nodes: ``_resolved``).
A numeric read of the companion lookup count inside the exact singleton guard can read its first node
or the whole nodeset, since the guarded branch has exactly one node. A text either reading does not read
is never the same as another.

Pure: it reads the texts it is given and imports neither HQ nor Django.
"""

from __future__ import annotations

from functools import cache
from math import isfinite

from proof.rules import _xpath


class _Unread(Exception):
    """The tokens are no expression this reading builds."""


# Each binary level of Core's parser, loosest first, with the token kinds of its operators.
LEVELS = (
    ("OR",),
    ("AND",),
    ("EQ", "NEQ"),
    ("LT", "LTE", "GT", "GTE"),
    ("PLUS", "MINUS"),
    ("MULT", "DIV", "MOD"),
)
# The operators whose runs read as one list of operands.
FLATTENED = frozenset({"OR", "AND", "UNION"})


class _Reader:
    def __init__(self, found):
        self.found = found
        self.i = 0

    def peek(self, offset=0):
        at = self.i + offset
        return self.found[at] if at < len(self.found) else None

    def kind(self, offset=0):
        token = self.peek(offset)
        return None if token is None else token.kind

    def take(self, kind=None):
        token = self.peek()
        if token is None or (kind is not None and token.kind != kind):
            raise _Unread
        self.i += 1
        return token

    def expression(self, level=0):
        if level == len(LEVELS):
            return self.unary()
        left = self.expression(level + 1)
        while self.kind() in LEVELS[level]:
            operator = self.take().kind
            right = self.expression(level + 1)
            left = _joined(operator, left, right)
        return left

    def unary(self):
        if self.kind() == "UMINUS":
            self.take()
            return ("neg", self.unary())
        left = self.path()
        while self.kind() == "UNION":
            self.take()
            left = _joined("UNION", left, self.path())
        return left

    def path(self):
        kind = self.kind()
        if kind in ("SLASH", "DBL_SLASH"):
            self.take()
            steps = [] if kind == "SLASH" and not self._starts_step() else self.steps()
            return ("path", kind, None, tuple(steps))
        if self._starts_step():
            return ("path", None, None, tuple(self.steps()))
        start = self.filtered()
        if self.kind() in ("SLASH", "DBL_SLASH"):
            separator = self.take().kind
            return ("path", separator, start, tuple(self.steps()))
        return start

    def _starts_step(self):
        kind = self.kind()
        if kind in ("DOT", "DBL_DOT", "AT", "WILDCARD", "NSWILDCARD"):
            return True
        # A name is a step unless a call: Core's parser builds every ``name(`` as a call (``parseFuncCalls``).
        return kind == "QNAME" and self.kind(1) != "LPAREN"

    def steps(self):
        found = [self.step()]
        while self.kind() in ("SLASH", "DBL_SLASH"):
            if self.take().kind == "DBL_SLASH":
                found.append(("step", "descendant-or-self", "node()", ()))
            found.append(self.step())
        return found

    def step(self):
        kind = self.kind()
        if kind == "DOT":
            self.take()
            return ("step", "self", "node()", ())
        if kind == "DBL_DOT":
            self.take()
            return ("step", "parent", "node()", ())
        axis = "child"
        if kind == "AT":
            self.take()
            axis = "attribute"
        elif kind == "QNAME" and self.kind(1) == "DBL_COLON":
            axis = self.take().text
            self.take()
        test = self.take()
        if test.kind not in ("QNAME", "WILDCARD", "NSWILDCARD"):
            raise _Unread
        name = test.text
        if test.kind == "QNAME" and self.kind() == "LPAREN":
            self.take()
            self.take("RPAREN")
            name = f"{name}()"
        return ("step", axis, name, tuple(self.predicates()))

    def predicates(self):
        found = []
        while self.kind() == "LBRACK":
            self.take()
            found.append(self.expression())
            self.take("RBRACK")
        return found

    def filtered(self):
        primary = self.primary()
        predicates = self.predicates()
        return ("filter", primary, tuple(predicates)) if predicates else primary

    def primary(self):
        token = self.take()
        if token.kind == "STR":
            return ("str", _xpath.string_value(token))
        if token.kind == "NUM":
            return ("num", float(token.text))
        if token.kind == "VAR":
            return ("var", token.text[1:])
        if token.kind == "LPAREN":
            inner = self.expression()
            self.take("RPAREN")
            return inner
        if token.kind == "QNAME" and self.kind() == "LPAREN":
            self.take()
            arguments = []
            if self.kind() != "RPAREN":
                arguments.append(self.expression())
                while self.kind() == "COMMA":
                    self.take()
                    arguments.append(self.expression())
            self.take("RPAREN")
            return ("call", token.text, tuple(arguments))
        raise _Unread


def _joined(operator, left, right):
    if operator in FLATTENED:
        operands = []
        for one in (left, right):
            operands.extend(one[1] if one[0] == operator else (one,))
        return (operator, tuple(operands))
    return (operator, left, right)


def tree(text):
    """The tree Core's parser builds of ``text`` (the module's docstring), or None where it reads none."""
    found = _xpath.tokens(text)
    if not found:
        return None
    reader = _Reader(found)
    try:
        built = reader.expression()
    except _Unread:
        return None
    return built if reader.i == len(found) else None


SESSION_SOURCE = "jr://instance/session"


@cache
def _lookup_count_guard(indexed):
    path = f"instance('{SESSION_SOURCE}')/session/data/fingerprintquery"
    read = f"{path}[1]" if indexed else path
    return tree(f"if(count({path}) = 1, number({read}), '')")


def _resolved(node, instances, context, inside=False):
    """``node`` with each ``instance('<id>')`` read as the source ``instances`` gives the id, and a path that
    starts at ``current()`` read from the root through ``context`` (the steps of the node the expression is
    about), its parent steps taken against the named steps before them, only where ``inside`` is false: outside
    every predicate. Core reads an absolute path of the main instance against the node it is evaluated at
    (``XPathPathExpr.evalRaw``, ``TreeReference.contextualize``), which is the slot's own node only outside a
    predicate; inside one that filters another instance's rows it reads the path unbound (every repeat entry's
    answer), and inside one that filters the main instance it reads it against the row being tested, while
    ``current()`` is read against the slot's node in both. So there the two spellings are two expressions."""
    if not isinstance(node, tuple) or not node:
        return node
    if node[0] == "call" and node[1] == "instance" and len(node[2]) == 1 and node[2][0][0] == "str":
        identity = node[2][0][1]
        return ("call", "instance", (("str", instances.get(identity, identity)),))
    if node[0] == "step":
        return (*node[:3], tuple(_resolved(one, instances, context, True) for one in node[3]))
    if node[0] == "filter":
        return (
            "filter",
            _resolved(node[1], instances, context, inside),
            tuple(_resolved(one, instances, context, True) for one in node[2]),
        )
    if (
        node[0] == "path"
        and node[2] == ("call", "current", ())
        and node[1] == "SLASH"
        and context is not None
        and not inside
    ):
        steps = [("step", "child", step, ()) for step in context]
        for step in node[3]:
            if step[:2] == ("step", "parent") and steps and steps[-1][1] == "child" and not steps[-1][3]:
                steps.pop()
            else:
                steps.append(_resolved(step, instances, context, inside))
        return ("path", "SLASH", None, tuple(steps))
    resolved = tuple(_resolved(part, instances, context, inside) for part in node)
    # The counted branch can read the whole nodeset only when there is one node.
    # Both guards give the same scalar even when the session supplies zero or several
    # counts (SessionContextRuntimeTest). Require the actual session instance.
    if node[:2] == ("call", "if") and SESSION_SOURCE in instances.values() and resolved == _lookup_count_guard(True):
        return _lookup_count_guard(False)
    return resolved


def _fixture_itemset_path(node, instances):
    """The sole predicate of a declared lookup fixture's row step, and its source."""
    match node:
        case ("path", "SLASH", ("call", "instance", (("str", identity),)), (
            ("step", "child", root, ()), ("step", "child", row, (predicate,)),
        )):
            source = instances.get(identity)
            if source == f"jr://fixture/item-list:{row}" and root == f"{row}_list":
                return (source, predicate)
    return None


def fixture_itemset_number(text, instances):
    """A numeric fixture row predicate and its supported nonnegative Java-int ordinal, if any."""
    shape = _fixture_itemset_path(tree(text), instances)
    if shape is None or shape[1][0] != "num":
        return None
    source, (_, number) = shape
    tokens = _xpath.tokens(text)
    if isfinite(number) and number >= 0 and [one.kind for one in tokens[-3:]] == ["LBRACK", "NUM", "RBRACK"]:
        return source, number, min(int(number), 2_147_483_647)
    return source, number, None


def fixture_itemset_ordinal_spelling(before, after, instances):
    """A single literal fixture ordinal written as the same row predicate's position check."""
    numeric = fixture_itemset_number(before, instances[0])
    if numeric is None or numeric[2] is None:
        return False
    source, _, ordinal = numeric
    return _fixture_itemset_path(tree(after), instances[1]) == (
        source, ("EQ", ("call", "position", ()), ("num", ordinal)),
    )


def same(before, after, *, instances=({}, {}), context=None) -> bool:
    """Whether two texts of one expression slot are one expression (the module's docstring): ``instances`` is each
    form's sources by instance id, ``context`` the steps of the node the slot is about."""
    first, second = tree(before), tree(after)
    if first is None or second is None:
        return False
    return _resolved(first, instances[0], context) == _resolved(second, instances[1], context)
