import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Base64;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.IntPredicate;
import java.util.function.IntUnaryOperator;

public final class GenerateOpenJdkCharacterData {
    private static final int MAX = Character.MAX_CODE_POINT;

    public static void main(String[] args) throws Exception {
        System.out.println("package org.commcare.nova.xpath.openjdkregex;");
        System.out.println();
        System.out.println("final class OpenJdkCharacterData {");
        emitTransitions("TYPES", Character::getType);
        emitTransitions("PROPERTIES", GenerateOpenJdkCharacterData::propertyMask);
        emitMappings("UPPER", Character::toUpperCase);
        emitMappings("LOWER", Character::toLowerCase);
        emitScripts();
        emitBlocks();
        System.out.println("    private static int[] decode(String[] chunks) {");
        System.out.println("        StringBuilder encoded = new StringBuilder();");
        System.out.println("        for (String chunk : chunks) encoded.append(chunk);");
        System.out.println("        byte[] bytes = java.util.Base64.getDecoder().decode(encoded.toString());");
        System.out.println("        int[] values = new int[bytes.length / 4];");
        System.out.println("        for (int i = 0; i < values.length; i++) {");
        System.out.println("            int offset = i * 4;");
        System.out.println("            values[i] = (bytes[offset] & 255) << 24 | (bytes[offset + 1] & 255) << 16 | (bytes[offset + 2] & 255) << 8 | (bytes[offset + 3] & 255);");
        System.out.println("        }");
        System.out.println("        return values;");
        System.out.println("    }");
        System.out.println("    private OpenJdkCharacterData() {}");
        System.out.println("}");
    }

    private static int propertyMask(int cp) {
        int value = 0;
        value |= bit(0, Character.isAlphabetic(cp));
        value |= bit(1, Character.isDefined(cp));
        value |= bit(2, Character.isDigit(cp));
        value |= bit(3, Character.isIdentifierIgnorable(cp));
        value |= bit(4, Character.isIdeographic(cp));
        value |= bit(5, Character.isISOControl(cp));
        value |= bit(6, Character.isJavaIdentifierPart(cp));
        value |= bit(7, Character.isJavaIdentifierStart(cp));
        value |= bit(8, Character.isLetter(cp));
        value |= bit(9, Character.isLetterOrDigit(cp));
        value |= bit(10, Character.isLowerCase(cp));
        value |= bit(11, Character.isMirrored(cp));
        value |= bit(12, Character.isSpaceChar(cp));
        value |= bit(13, Character.isTitleCase(cp));
        value |= bit(14, Character.isUnicodeIdentifierPart(cp));
        value |= bit(15, Character.isUnicodeIdentifierStart(cp));
        value |= bit(16, Character.isUpperCase(cp));
        value |= bit(17, Character.isWhitespace(cp));
        return value;
    }

    private static int bit(int bit, boolean enabled) {
        return enabled ? 1 << bit : 0;
    }

    private static void emitTransitions(String name, IntUnaryOperator valueAt) {
        List<Integer> data = new ArrayList<>();
        int previous = Integer.MIN_VALUE;
        for (int cp = 0; cp <= MAX; cp++) {
            int value = valueAt.applyAsInt(cp);
            if (value != previous) {
                data.add(cp);
                data.add(value);
                previous = value;
            }
        }
        emitIntArray(name, data);
    }

    private static void emitMappings(String name, IntUnaryOperator mapping) {
        List<Integer> data = new ArrayList<>();
        int start = -1;
        int end = -1;
        int delta = 0;
        for (int cp = 0; cp <= MAX; cp++) {
            int nextDelta = mapping.applyAsInt(cp) - cp;
            if (nextDelta == 0) {
                if (start >= 0) {
                    data.add(start); data.add(end); data.add(delta);
                    start = -1;
                }
            } else if (start >= 0 && nextDelta == delta && cp == end + 1) {
                end = cp;
            } else {
                if (start >= 0) {
                    data.add(start); data.add(end); data.add(delta);
                }
                start = end = cp;
                delta = nextDelta;
            }
        }
        if (start >= 0) {
            data.add(start); data.add(end); data.add(delta);
        }
        emitIntArray(name, data);
    }

    private static void emitScripts() {
        Character.UnicodeScript[] values = Character.UnicodeScript.values();
        List<String> names = new ArrayList<>();
        for (Character.UnicodeScript value : values) names.add(value.name());
        emitStringArray("SCRIPT_NAMES", names);
        Map<String, Integer> aliases = new LinkedHashMap<>();
        try {
            Field field = Character.UnicodeScript.class.getDeclaredField("aliases");
            field.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<String, Character.UnicodeScript> reflected =
                    (Map<String, Character.UnicodeScript>) field.get(null);
            for (Map.Entry<String, Character.UnicodeScript> entry : reflected.entrySet()) {
                aliases.put(entry.getKey(), entry.getValue().ordinal());
            }
        } catch (ReflectiveOperationException exception) {
            throw new IllegalStateException(exception);
        }
        emitStringArray("SCRIPT_ALIASES", new ArrayList<>(aliases.keySet()));
        emitIntArray("SCRIPT_ALIAS_VALUES", new ArrayList<>(aliases.values()));
        emitTransitions("SCRIPTS", cp -> Character.UnicodeScript.of(cp).ordinal());
    }

    private static void emitBlocks() throws Exception {
        IdentityHashMap<Character.UnicodeBlock, Integer> indexes = new IdentityHashMap<>();
        List<String> canonicalNames = new ArrayList<>();
        canonicalNames.add("");
        for (Field field : Character.UnicodeBlock.class.getFields()) {
            if (!Modifier.isStatic(field.getModifiers()) || field.getType() != Character.UnicodeBlock.class) continue;
            Character.UnicodeBlock block = (Character.UnicodeBlock) field.get(null);
            indexes.computeIfAbsent(block, ignored -> {
                canonicalNames.add(block.toString());
                return canonicalNames.size() - 1;
            });
        }
        Field mapField = Character.UnicodeBlock.class.getDeclaredField("map");
        mapField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, Character.UnicodeBlock> reflected =
                (Map<String, Character.UnicodeBlock>) mapField.get(null);
        Map<String, Integer> aliases = new LinkedHashMap<>();
        for (Map.Entry<String, Character.UnicodeBlock> entry : reflected.entrySet()) {
            aliases.put(entry.getKey(), indexes.get(entry.getValue()));
        }
        emitStringArray("BLOCK_NAMES", canonicalNames);
        emitStringArray("BLOCK_ALIASES", new ArrayList<>(aliases.keySet()));
        emitIntArray("BLOCK_ALIAS_VALUES", new ArrayList<>(aliases.values()));
        emitTransitions("BLOCKS", cp -> {
            Character.UnicodeBlock block = Character.UnicodeBlock.of(cp);
            return block == null ? 0 : indexes.get(block);
        });
    }

    private static void emitIntArray(String name, List<Integer> data) {
        byte[] bytes = new byte[data.size() * 4];
        for (int i = 0; i < data.size(); i++) {
            int value = data.get(i);
            int offset = i * 4;
            bytes[offset] = (byte) (value >>> 24);
            bytes[offset + 1] = (byte) (value >>> 16);
            bytes[offset + 2] = (byte) (value >>> 8);
            bytes[offset + 3] = (byte) value;
        }
        String encoded = Base64.getEncoder().encodeToString(bytes);
        System.out.println("    static final int[] " + name + " = decode(new String[] {");
        for (int i = 0; i < encoded.length(); i += 16000) {
            System.out.println("        \"" + encoded.substring(i, Math.min(encoded.length(), i + 16000)) + "\",");
        }
        System.out.println("    });");
    }

    private static void emitStringArray(String name, List<String> data) {
        System.out.println("    static final String[] " + name + " = {");
        for (String value : data) {
            System.out.println("        \"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\",");
        }
        System.out.println("    };");
    }

    static {
        // Emitted after the arrays by main; this block intentionally empty.
    }
}
