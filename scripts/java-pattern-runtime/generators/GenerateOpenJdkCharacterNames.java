import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class GenerateOpenJdkCharacterNames {
    private record Entry(String name, int codePoint) {}
    private record PrefixRange(int start, int end, String prefix) {}

    public static void main(String[] args) {
        List<Entry> explicit = new ArrayList<>();
        List<PrefixRange> ranges = new ArrayList<>();
        int rangeStart = -1;
        int rangeEnd = -1;
        String rangePrefix = null;
        for (int cp = 0; cp <= Character.MAX_CODE_POINT; cp++) {
            String name = Character.getName(cp);
            String hex = Integer.toHexString(cp).toUpperCase(Locale.ROOT);
            String suffix = " " + hex;
            String prefix = name != null && name.endsWith(suffix)
                    ? name.substring(0, name.length() - hex.length())
                    : null;
            if (prefix != null && prefix.equals(rangePrefix) && cp == rangeEnd + 1) {
                rangeEnd = cp;
            } else {
                if (rangePrefix != null) ranges.add(new PrefixRange(rangeStart, rangeEnd, rangePrefix));
                rangeStart = rangeEnd = prefix == null ? -1 : cp;
                rangePrefix = prefix;
            }
            if (name != null && prefix == null) explicit.add(new Entry(name, cp));
        }
        if (rangePrefix != null) ranges.add(new PrefixRange(rangeStart, rangeEnd, rangePrefix));
        explicit.sort(Comparator.comparing(Entry::name));

        List<Byte> bytes = new ArrayList<>();
        String previous = "";
        for (Entry entry : explicit) {
            int common = commonPrefix(previous, entry.name());
            byte[] suffix = entry.name().substring(common).getBytes(StandardCharsets.US_ASCII);
            bytes.add((byte) common);
            bytes.add((byte) suffix.length);
            for (byte value : suffix) bytes.add(value);
            bytes.add((byte) (entry.codePoint() >>> 16));
            bytes.add((byte) (entry.codePoint() >>> 8));
            bytes.add((byte) entry.codePoint());
            previous = entry.name();
        }
        byte[] packed = new byte[bytes.size()];
        for (int i = 0; i < bytes.size(); i++) packed[i] = bytes.get(i);
        String encoded = Base64.getEncoder().encodeToString(packed);

        System.out.println("/* Generated from Eclipse Temurin OpenJDK 17.0.20+8. */");
        System.out.println("const NAME_COUNT = " + explicit.size() + ";");
        System.out.println("const NAME_DATA = [");
        for (int i = 0; i < encoded.length(); i += 16000) {
            System.out.println("\t\"" + encoded.substring(i, Math.min(encoded.length(), i + 16000)) + "\",");
        }
        System.out.println("] as const;");
        Map<String, Integer> prefixes = new LinkedHashMap<>();
        for (PrefixRange range : ranges) prefixes.computeIfAbsent(range.prefix(), ignored -> prefixes.size());
        System.out.println("const PREFIXES: readonly string[] = [");
        for (String prefix : prefixes.keySet()) System.out.println("\t\"" + prefix + "\",");
        System.out.println("];");
        System.out.println("const PREFIX_RANGES: readonly number[] = [");
        for (PrefixRange range : ranges) {
            System.out.println("\t" + range.start() + ", " + range.end() + ", " + prefixes.get(range.prefix()) + ",");
        }
        System.out.println("];");
        System.out.println("let decoded: { names: string[]; codePoints: number[] } | undefined;");
        System.out.println("export function openJdk17CodePointOf(value: string): number | undefined {");
        System.out.println("\tconst name = value.toUpperCase();");
        System.out.println("\tconst split = name.lastIndexOf(' ');");
        System.out.println("\tif (split > 0 && /^[0-9A-F]+$/.test(name.slice(split + 1))) {");
        System.out.println("\t\tconst cp = Number.parseInt(name.slice(split + 1), 16);");
        System.out.println("\t\tif (cp <= 0x10ffff) {");
        System.out.println("\t\t\tlet low = 0;");
        System.out.println("\t\t\tlet high = PREFIX_RANGES.length / 3 - 1;");
        System.out.println("\t\t\twhile (low <= high) {");
        System.out.println("\t\t\t\tconst mid = (low + high) >>> 1;");
        System.out.println("\t\t\t\tconst offset = mid * 3;");
        System.out.println("\t\t\t\tif (cp < PREFIX_RANGES[offset]!) high = mid - 1;");
        System.out.println("\t\t\t\telse if (cp > PREFIX_RANGES[offset + 1]!) low = mid + 1;");
        System.out.println("\t\t\t\telse return name.slice(0, split + 1) === PREFIXES[PREFIX_RANGES[offset + 2]!] ? cp : undefined;");
        System.out.println("\t\t\t}");
        System.out.println("\t\t}");
        System.out.println("\t}");
        System.out.println("\tconst table = decoded ??= decodeNames();");
        System.out.println("\tlet low = 0;");
        System.out.println("\tlet high = table.names.length - 1;");
        System.out.println("\twhile (low <= high) {");
        System.out.println("\t\tconst mid = (low + high) >>> 1;");
        System.out.println("\t\tconst candidate = table.names[mid]!;");
        System.out.println("\t\tif (name === candidate) return table.codePoints[mid];");
        System.out.println("\t\tif (name < candidate) high = mid - 1; else low = mid + 1;");
        System.out.println("\t}");
        System.out.println("\treturn undefined;");
        System.out.println("}");
        System.out.println("function decodeNames(): { names: string[]; codePoints: number[] } {");
        System.out.println("\tconst binary = atob(NAME_DATA.join(''));");
        System.out.println("\tconst names: string[] = [];");
        System.out.println("\tconst codePoints: number[] = [];");
        System.out.println("\tlet offset = 0;");
        System.out.println("\tlet previous = '';");
        System.out.println("\tfor (let index = 0; index < NAME_COUNT; index++) {");
        System.out.println("\t\tconst common = binary.charCodeAt(offset++);");
        System.out.println("\t\tconst length = binary.charCodeAt(offset++);");
        System.out.println("\t\tconst name = previous.slice(0, common) + binary.slice(offset, offset + length);");
        System.out.println("\t\toffset += length;");
        System.out.println("\t\tconst cp = binary.charCodeAt(offset++) << 16 | binary.charCodeAt(offset++) << 8 | binary.charCodeAt(offset++);");
        System.out.println("\t\tnames.push(name);");
        System.out.println("\t\tcodePoints.push(cp);");
        System.out.println("\t\tprevious = name;");
        System.out.println("\t}");
        System.out.println("\treturn { names, codePoints };");
        System.out.println("}");
    }

    private static int commonPrefix(String left, String right) {
        int limit = Math.min(left.length(), right.length());
        int index = 0;
        while (index < limit && left.charAt(index) == right.charAt(index)) index++;
        return index;
    }
}
