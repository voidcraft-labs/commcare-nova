package nova.proof.surface;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Kotlin sources read as tokens. No Kotlin parser is in the image, so the few Kotlin reads the
 * surface follows (a call's arguments, a `const val`'s string, a comparison) are read from Kotlin's
 * lexical grammar: identifiers (backquoted ones included), string literals (a template's `$` makes
 * the string not constant), numbers, comments (block comments nest), and operators. Nothing is
 * matched with a regular expression.
 */
final class Kotlin {
    enum Kind { IDENT, STRING, NUMBER, CHAR, OP }

    static final class Token {
        final Kind kind;
        /** An identifier's name, an operator, or a string's value (null when it holds a template). */
        final String text;
        final int line;
        /** A template string's literal text around each `$` it interpolates (one more than the holes). */
        final List<String> parts;

        Token(Kind kind, String text, int line) {
            this(kind, text, line, null);
        }

        Token(Kind kind, String text, int line, List<String> parts) {
            this.kind = kind;
            this.text = text;
            this.line = line;
            this.parts = parts;
        }

        boolean is(String operatorOrName) {
            return (kind == Kind.OP || kind == Kind.IDENT) && operatorOrName.equals(text);
        }

        @Override
        public String toString() {
            return kind == Kind.STRING ? "\"" + text + "\"" : text;
        }
    }

    /** One Kotlin file: its path relative to its repository, its platform and its tokens. */
    static final class Unit {
        final String relative;
        final String platform;
        final List<Token> tokens;

        Unit(String relative, String platform, List<Token> tokens) {
            this.relative = relative;
            this.platform = platform;
            this.tokens = tokens;
        }
    }

    private static final java.util.Set<String> VISIBILITY = java.util.Set.of("private", "protected", "public", "internal");

    private static final String[] OPERATORS = {"===", "!==", "?.", "?:", "!!", "==", "!=", "<=", ">=", "&&", "||",
            "->", "::", "..", "+=", "-=", "*=", "/=", "++", "--"};

    private Kotlin() {
    }

    static List<Unit> load(String repository, Path base, String platform, String... directories) throws IOException {
        List<Unit> units = new ArrayList<>();
        for (String directory : directories) {
            List<Path> files;
            try (Stream<Path> walk = Files.walk(base.resolve(directory))) {
                files = walk.filter(p -> p.toString().endsWith(".kt")).sorted().collect(Collectors.toList());
            }
            for (Path file : files) {
                String relative = repository + "/" + base.relativize(file).toString().replace('\\', '/');
                units.add(new Unit(relative, platform, lex(Files.readString(file, StandardCharsets.UTF_8), relative)));
            }
        }
        return units;
    }

    static List<Token> lex(String source, String where) {
        List<Token> tokens = new ArrayList<>();
        int i = 0;
        int line = 1;
        int length = source.length();
        while (i < length) {
            char c = source.charAt(i);
            if (c == '\n') {
                line++;
                i++;
            } else if (Character.isWhitespace(c)) {
                i++;
            } else if (c == '/' && i + 1 < length && source.charAt(i + 1) == '/') {
                while (i < length && source.charAt(i) != '\n') {
                    i++;
                }
            } else if (c == '/' && i + 1 < length && source.charAt(i + 1) == '*') {
                int depth = 0;
                do {
                    if (source.startsWith("/*", i)) {
                        depth++;
                        i += 2;
                    } else if (source.startsWith("*/", i)) {
                        depth--;
                        i += 2;
                    } else {
                        if (source.charAt(i) == '\n') {
                            line++;
                        }
                        i++;
                    }
                } while (depth > 0 && i < length);
            } else if (source.startsWith("\"\"\"", i)) {
                int end = source.indexOf("\"\"\"", i + 3);
                if (end < 0) {
                    throw new IllegalStateException("An unterminated raw string in " + where + " at line " + line + ".");
                }
                while (end + 3 < length && source.charAt(end + 3) == '"') {
                    end++;
                }
                String raw = source.substring(i + 3, end);
                tokens.add(raw.indexOf('$') >= 0 ? new Token(Kind.STRING, null, line, List.of("", ""))
                        : new Token(Kind.STRING, raw, line));
                line += Math.toIntExact(raw.chars().filter(ch -> ch == '\n').count());
                i = end + 3;
            } else if (c == '"') {
                StringBuilder value = new StringBuilder();
                List<String> parts = new ArrayList<>();
                boolean template = false;
                i++;
                while (i < length && source.charAt(i) != '"') {
                    char d = source.charAt(i);
                    if (d == '\\') {
                        char escaped = source.charAt(i + 1);
                        if (escaped == 'u') {
                            value.append((char) Integer.parseInt(source.substring(i + 2, i + 6), 16));
                            i += 6;
                            continue;
                        }
                        value.append(switch (escaped) {
                            case 'n' -> '\n';
                            case 't' -> '\t';
                            case 'r' -> '\r';
                            case 'b' -> '\b';
                            default -> escaped;
                        });
                        i += 2;
                    } else if (d == '$' && i + 1 < length
                            && (source.charAt(i + 1) == '{' || Character.isJavaIdentifierStart(source.charAt(i + 1)))) {
                        template = true;
                        parts.add(value.toString());
                        value.setLength(0);
                        if (source.charAt(i + 1) == '{') {
                            // From the `{` after the `$` to its matching `}`.
                            i++;
                            int depth = 0;
                            do {
                                if (source.charAt(i) == '{') {
                                    depth++;
                                } else if (source.charAt(i) == '}') {
                                    depth--;
                                }
                                i++;
                            } while (depth > 0 && i < length);
                        } else {
                            // `$name`: the identifier after the `$`.
                            i++;
                            while (i < length && Character.isJavaIdentifierPart(source.charAt(i))) {
                                i++;
                            }
                        }
                    } else {
                        value.append(d);
                        i++;
                    }
                }
                if (template) {
                    parts.add(value.toString());
                    tokens.add(new Token(Kind.STRING, null, line, parts));
                } else {
                    tokens.add(new Token(Kind.STRING, value.toString(), line));
                }
                i++;
            } else if (c == '\'') {
                int end = source.indexOf('\'', i + (source.charAt(i + 1) == '\\' ? 3 : 2));
                tokens.add(new Token(Kind.CHAR, source.substring(i + 1, end), line));
                i = end + 1;
            } else if (c == '`') {
                int end = source.indexOf('`', i + 1);
                tokens.add(new Token(Kind.IDENT, source.substring(i + 1, end), line));
                i = end + 1;
            } else if (Character.isJavaIdentifierStart(c)) {
                int start = i;
                while (i < length && Character.isJavaIdentifierPart(source.charAt(i))) {
                    i++;
                }
                tokens.add(new Token(Kind.IDENT, source.substring(start, i), line));
            } else if (Character.isDigit(c)) {
                int start = i;
                while (i < length && (Character.isLetterOrDigit(source.charAt(i)) || source.charAt(i) == '.'
                        || source.charAt(i) == '_')) {
                    i++;
                }
                tokens.add(new Token(Kind.NUMBER, source.substring(start, i), line));
            } else {
                String operator = String.valueOf(c);
                for (String candidate : OPERATORS) {
                    if (source.startsWith(candidate, i)) {
                        operator = candidate;
                        break;
                    }
                }
                tokens.add(new Token(Kind.OP, operator, line));
                i += operator.length();
            }
        }
        return tokens;
    }

    /** The arguments of the call whose `(` is at `open`: the tokens between top-level commas. */
    static List<List<Token>> arguments(List<Token> tokens, int open) {
        List<List<Token>> out = new ArrayList<>();
        int close = closing(tokens, open);
        List<Token> current = new ArrayList<>();
        int depth = 0;
        for (int i = open + 1; i < close; i++) {
            Token token = tokens.get(i);
            if (token.is("(") || token.is("[") || token.is("{")) {
                depth++;
            } else if (token.is(")") || token.is("]") || token.is("}")) {
                depth--;
            }
            if (depth == 0 && token.is(",")) {
                out.add(current);
                current = new ArrayList<>();
            } else {
                current.add(token);
            }
        }
        if (!current.isEmpty()) {
            out.add(current);
        }
        return out;
    }

    /** The string a file's `const val <name> = "..."` holds, or null. */
    static String constant(Unit unit, String name) {
        List<Token> tokens = unit.tokens;
        for (int i = 0; i + 4 < tokens.size(); i++) {
            if (tokens.get(i).is("const") && tokens.get(i + 1).is("val") && tokens.get(i + 2).is(name)
                    && tokens.get(i + 3).is("=") && tokens.get(i + 4).kind == Kind.STRING) {
                return tokens.get(i + 4).text;
            }
        }
        return null;
    }

    /** The type the nearest `<name>: <Type>` (a parameter or a property) before token `before` declares, or null. */
    static String declaredType(Unit unit, String name, int before) {
        List<Token> tokens = unit.tokens;
        for (int i = Math.min(before, tokens.size() - 3); i >= 0; i--) {
            if (tokens.get(i).kind == Kind.IDENT && tokens.get(i).text.equals(name) && tokens.get(i + 1).is(":")
                    && tokens.get(i + 2).kind == Kind.IDENT) {
                return tokens.get(i + 2).text;
            }
        }
        return null;
    }

    /**
     * Each class or interface the file declares, by name, with the names of the types it extends
     * (`class A<T>(x: Int) : B<T>(), C` gives `A -> [B, C]`).
     */
    static java.util.Map<String, List<String>> supertypes(Unit unit) {
        java.util.Map<String, List<String>> out = new java.util.TreeMap<>();
        List<Token> tokens = unit.tokens;
        for (int i = 0; i + 1 < tokens.size(); i++) {
            if (!(tokens.get(i).is("class") || tokens.get(i).is("interface")) || tokens.get(i + 1).kind != Kind.IDENT
                    || (i > 0 && tokens.get(i - 1).is("::"))) {
                continue;
            }
            String name = tokens.get(i + 1).text;
            int j = i + 2;
            j = skipBalanced(tokens, j, "<", ">");
            // A primary constructor's modifiers and annotations (`private constructor(`, `@Inject constructor(`).
            for (int k = j; k < tokens.size(); ) {
                Token token = tokens.get(k);
                if (token.is("constructor")) {
                    j = k + 1;
                    break;
                }
                if (token.is("@")) {
                    k++;
                    if (k < tokens.size() && tokens.get(k).kind == Kind.IDENT) {
                        k++;
                    }
                    if (k < tokens.size() && tokens.get(k).is("(")) {
                        k = closing(tokens, k) + 1;
                    }
                } else if (token.kind == Kind.IDENT && VISIBILITY.contains(token.text)) {
                    k++;
                } else {
                    break;
                }
            }
            if (j < tokens.size() && tokens.get(j).is("(")) {
                j = closing(tokens, j) + 1;
            }
            List<String> parents = new ArrayList<>();
            if (j < tokens.size() && tokens.get(j).is(":")) {
                j++;
                while (j < tokens.size() && tokens.get(j).kind == Kind.IDENT) {
                    int last = j;
                    while (last + 2 < tokens.size() && tokens.get(last + 1).is(".") && tokens.get(last + 2).kind == Kind.IDENT) {
                        last += 2;
                    }
                    parents.add(tokens.get(last).text);
                    j = skipBalanced(tokens, last + 1, "<", ">");
                    if (j < tokens.size() && tokens.get(j).is("(")) {
                        j = closing(tokens, j) + 1;
                    }
                    if (j < tokens.size() && tokens.get(j).is(",")) {
                        j++;
                    } else {
                        break;
                    }
                }
            }
            out.computeIfAbsent(name, k -> new ArrayList<>()).addAll(parents);
        }
        return out;
    }

    /** The index after a balanced `open`...`close` run starting at `at`, or `at` when none starts there. */
    private static int skipBalanced(List<Token> tokens, int at, String open, String close) {
        if (at >= tokens.size() || !tokens.get(at).is(open)) {
            return at;
        }
        int depth = 0;
        for (int i = at; i < tokens.size(); i++) {
            if (tokens.get(i).is(open)) {
                depth++;
            } else if (tokens.get(i).is(close)) {
                depth--;
                if (depth == 0) {
                    return i + 1;
                }
            }
        }
        return tokens.size();
    }

    /** The index of the `)` closing the `(` at `open`. */
    static int closing(List<Token> tokens, int open) {
        int depth = 0;
        for (int i = open; i < tokens.size(); i++) {
            if (tokens.get(i).is("(")) {
                depth++;
            } else if (tokens.get(i).is(")")) {
                depth--;
                if (depth == 0) {
                    return i;
                }
            }
        }
        throw new IllegalStateException("An unbalanced parenthesis in Kotlin tokens.");
    }

    /** `<file>::<Class>.<function>` for the class and function a token stands inside. */
    static String where(Unit unit, int index) {
        List<String[]> blocks = new ArrayList<>();
        String pendingType = null;
        String pendingFunction = null;
        for (int i = 0; i <= index && i < unit.tokens.size(); i++) {
            Token token = unit.tokens.get(i);
            if (token.is("class") || token.is("object") || token.is("interface")) {
                Token next = i + 1 < unit.tokens.size() ? unit.tokens.get(i + 1) : null;
                pendingType = next != null && next.kind == Kind.IDENT ? next.text : token.text;
            } else if (token.is("fun") && i + 1 < unit.tokens.size()) {
                pendingFunction = unit.tokens.get(i + 1).text;
            } else if (token.is("{")) {
                blocks.add(new String[]{pendingType, pendingFunction});
                pendingType = null;
                pendingFunction = null;
            } else if (token.is("}") && !blocks.isEmpty()) {
                blocks.remove(blocks.size() - 1);
            }
        }
        String type = null;
        String function = pendingFunction;
        for (String[] block : blocks) {
            if (block[0] != null && !block[0].equals("object")) {
                type = block[0];
            }
            if (block[1] != null) {
                function = block[1];
            }
        }
        if (pendingFunction != null) {
            function = pendingFunction;
        }
        return unit.relative + "::" + (type == null ? "?" : type) + (function == null ? "" : "." + function);
    }
}
