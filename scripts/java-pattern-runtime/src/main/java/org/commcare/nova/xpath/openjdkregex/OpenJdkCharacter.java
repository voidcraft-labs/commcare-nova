package org.commcare.nova.xpath.openjdkregex;

import java.util.Locale;

final class OpenJdkCharacter {
    static final int MIN_CODE_POINT = Character.MIN_CODE_POINT;
    static final int MAX_CODE_POINT = Character.MAX_CODE_POINT;
    static final int MIN_SUPPLEMENTARY_CODE_POINT = Character.MIN_SUPPLEMENTARY_CODE_POINT;
    static final char MIN_HIGH_SURROGATE = Character.MIN_HIGH_SURROGATE;
    static final char MAX_LOW_SURROGATE = Character.MAX_LOW_SURROGATE;

    static final byte UNASSIGNED = Character.UNASSIGNED;
    static final byte UPPERCASE_LETTER = Character.UPPERCASE_LETTER;
    static final byte LOWERCASE_LETTER = Character.LOWERCASE_LETTER;
    static final byte TITLECASE_LETTER = Character.TITLECASE_LETTER;
    static final byte MODIFIER_LETTER = Character.MODIFIER_LETTER;
    static final byte OTHER_LETTER = Character.OTHER_LETTER;
    static final byte NON_SPACING_MARK = Character.NON_SPACING_MARK;
    static final byte ENCLOSING_MARK = Character.ENCLOSING_MARK;
    static final byte COMBINING_SPACING_MARK = Character.COMBINING_SPACING_MARK;
    static final byte DECIMAL_DIGIT_NUMBER = Character.DECIMAL_DIGIT_NUMBER;
    static final byte LETTER_NUMBER = Character.LETTER_NUMBER;
    static final byte OTHER_NUMBER = Character.OTHER_NUMBER;
    static final byte SPACE_SEPARATOR = Character.SPACE_SEPARATOR;
    static final byte LINE_SEPARATOR = Character.LINE_SEPARATOR;
    static final byte PARAGRAPH_SEPARATOR = Character.PARAGRAPH_SEPARATOR;
    static final byte CONTROL = Character.CONTROL;
    static final byte FORMAT = Character.FORMAT;
    static final byte PRIVATE_USE = Character.PRIVATE_USE;
    static final byte SURROGATE = Character.SURROGATE;
    static final byte DASH_PUNCTUATION = Character.DASH_PUNCTUATION;
    static final byte START_PUNCTUATION = Character.START_PUNCTUATION;
    static final byte END_PUNCTUATION = Character.END_PUNCTUATION;
    static final byte CONNECTOR_PUNCTUATION = Character.CONNECTOR_PUNCTUATION;
    static final byte OTHER_PUNCTUATION = Character.OTHER_PUNCTUATION;
    static final byte MATH_SYMBOL = Character.MATH_SYMBOL;
    static final byte CURRENCY_SYMBOL = Character.CURRENCY_SYMBOL;
    static final byte MODIFIER_SYMBOL = Character.MODIFIER_SYMBOL;
    static final byte OTHER_SYMBOL = Character.OTHER_SYMBOL;
    static final byte INITIAL_QUOTE_PUNCTUATION = Character.INITIAL_QUOTE_PUNCTUATION;
    static final byte FINAL_QUOTE_PUNCTUATION = Character.FINAL_QUOTE_PUNCTUATION;

    private OpenJdkCharacter() {}

    static int getType(int cp) { return transition(OpenJdkCharacterData.TYPES, cp); }
    static int toUpperCase(int cp) { return mapped(OpenJdkCharacterData.UPPER, cp); }
    static int toLowerCase(int cp) { return mapped(OpenJdkCharacterData.LOWER, cp); }
    static boolean isAlphabetic(int cp) { return property(cp, 0); }
    static boolean isDefined(int cp) { return property(cp, 1); }
    static boolean isDigit(int cp) { return property(cp, 2); }
    static boolean isIdentifierIgnorable(int cp) { return property(cp, 3); }
    static boolean isIdeographic(int cp) { return property(cp, 4); }
    static boolean isISOControl(int cp) { return property(cp, 5); }
    static boolean isJavaIdentifierPart(int cp) { return property(cp, 6); }
    static boolean isJavaIdentifierStart(int cp) { return property(cp, 7); }
    static boolean isLetter(int cp) { return property(cp, 8); }
    static boolean isLetterOrDigit(int cp) { return property(cp, 9); }
    static boolean isLowerCase(int cp) { return property(cp, 10); }
    static boolean isMirrored(int cp) { return property(cp, 11); }
    static boolean isSpaceChar(int cp) { return property(cp, 12); }
    static boolean isTitleCase(int cp) { return property(cp, 13); }
    static boolean isUnicodeIdentifierPart(int cp) { return property(cp, 14); }
    static boolean isUnicodeIdentifierStart(int cp) { return property(cp, 15); }
    static boolean isUpperCase(int cp) { return property(cp, 16); }
    static boolean isWhitespace(int cp) { return property(cp, 17); }

    static int charCount(int cp) { return Character.charCount(cp); }
    static int codePointAt(CharSequence value, int index) { return Character.codePointAt(value, index); }
    static int codePointAt(char[] value, int index) { return Character.codePointAt(value, index); }
    static int codePointBefore(CharSequence value, int index) { return Character.codePointBefore(value, index); }
    static boolean isHighSurrogate(char value) { return Character.isHighSurrogate(value); }
    static boolean isLowSurrogate(char value) { return Character.isLowSurrogate(value); }
    static boolean isSupplementaryCodePoint(int cp) { return Character.isSupplementaryCodePoint(cp); }
    static boolean isSurrogate(char value) { return Character.isSurrogate(value); }
    static boolean isSurrogatePair(char high, char low) { return Character.isSurrogatePair(high, low); }
    static int toCodePoint(char high, char low) { return Character.toCodePoint(high, low); }

    static int codePointOf(String name) {
        throw new IllegalArgumentException(name);
    }

    static final class UnicodeScript {
        private static final UnicodeScript[] VALUES = values(OpenJdkCharacterData.SCRIPT_NAMES.length);
        private final int index;
        private UnicodeScript(int index) { this.index = index; }
        static UnicodeScript of(int cp) { return VALUES[transition(OpenJdkCharacterData.SCRIPTS, cp)]; }
        static UnicodeScript forName(String name) {
            String normalized = name.toUpperCase(Locale.ENGLISH);
            for (int i = 0; i < OpenJdkCharacterData.SCRIPT_ALIASES.length; i++) {
                if (OpenJdkCharacterData.SCRIPT_ALIASES[i].equals(normalized)) return VALUES[OpenJdkCharacterData.SCRIPT_ALIAS_VALUES[i]];
            }
            for (int i = 0; i < OpenJdkCharacterData.SCRIPT_NAMES.length; i++) {
                if (OpenJdkCharacterData.SCRIPT_NAMES[i].equals(normalized)) return VALUES[i];
            }
            throw new IllegalArgumentException(name);
        }
        private static UnicodeScript[] values(int count) {
            UnicodeScript[] values = new UnicodeScript[count];
            for (int i = 0; i < count; i++) values[i] = new UnicodeScript(i);
            return values;
        }
    }

    static final class UnicodeBlock {
        private static final UnicodeBlock[] VALUES = values(OpenJdkCharacterData.BLOCK_NAMES.length);
        private final int index;
        private UnicodeBlock(int index) { this.index = index; }
        static UnicodeBlock of(int cp) { int value = transition(OpenJdkCharacterData.BLOCKS, cp); return value == 0 ? null : VALUES[value]; }
        static UnicodeBlock forName(String name) {
            String normalized = name.toUpperCase(Locale.ENGLISH);
            for (int i = 0; i < OpenJdkCharacterData.BLOCK_ALIASES.length; i++) {
                if (OpenJdkCharacterData.BLOCK_ALIASES[i].equals(normalized)) return VALUES[OpenJdkCharacterData.BLOCK_ALIAS_VALUES[i]];
            }
            throw new IllegalArgumentException(name);
        }
        private static UnicodeBlock[] values(int count) {
            UnicodeBlock[] values = new UnicodeBlock[count];
            for (int i = 0; i < count; i++) values[i] = new UnicodeBlock(i);
            return values;
        }
    }

    private static boolean property(int cp, int bit) {
        return (transition(OpenJdkCharacterData.PROPERTIES, cp) & (1 << bit)) != 0;
    }

    private static int transition(int[] data, int cp) {
        int low = 0;
        int high = data.length / 2 - 1;
        while (low <= high) {
            int mid = (low + high) >>> 1;
            int start = data[mid * 2];
            if (start <= cp) low = mid + 1; else high = mid - 1;
        }
        return data[Math.max(0, high) * 2 + 1];
    }

    private static int mapped(int[] data, int cp) {
        int low = 0;
        int high = data.length / 3 - 1;
        while (low <= high) {
            int mid = (low + high) >>> 1;
            int start = data[mid * 3];
            int end = data[mid * 3 + 1];
            if (cp < start) high = mid - 1;
            else if (cp > end) low = mid + 1;
            else return cp + data[mid * 3 + 2];
        }
        return cp;
    }
}
