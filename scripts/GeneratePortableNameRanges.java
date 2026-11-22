import java.util.ArrayList;
import java.util.List;
import java.util.function.IntPredicate;

/** Run with the proof lane's JDK 17:
 * java scripts/GeneratePortableNameRanges.java > lib/domain/portableNameRanges.json
 * Core's Lexer.matchNCName tests one UTF-16 code unit at a time. */
class GeneratePortableNameRanges {
    private static List<Integer> ranges(IntPredicate admitted) {
        List<Integer> boundaries = new ArrayList<>();
        for (int unit = 0; unit <= Character.MAX_VALUE; unit++) {
            if (!admitted.test(unit)) continue;
            boundaries.add(unit);
            while (unit < Character.MAX_VALUE && admitted.test(unit + 1)) unit++;
            boundaries.add(unit);
        }
        return boundaries;
    }

    public static void main(String[] args) {
        if (Runtime.version().feature() != 17) {
            throw new IllegalStateException("Use JDK 17 to reproduce the worker character table.");
        }
        var initial = ranges(c -> c == '_' || Character.isLowerCase((char)c) || Character.isUpperCase((char)c));
        var continuationOnly = ranges(c -> c == '.' || c == '-' || Character.isDigit((char)c));
        System.out.println("{\n\t\"initial\": " + initial + ",\n\t\"continuationOnly\": " + continuationOnly + "\n}");
    }
}
