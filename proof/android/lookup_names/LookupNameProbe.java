import java.lang.reflect.Method;
import org.javarosa.xpath.parser.Lexer;

/** Emit the complete BMP ranges consumed by the pinned Core lexer on this runtime. */
public final class LookupNameProbe {
    private static String ranges(Method lexer, boolean continuationOnly) throws Exception {
        StringBuilder ranges = new StringBuilder("[");
        int start = -1;
        for (int unit = 0; unit <= 0x10000; unit++) {
            boolean accepted = false;
            if (unit <= Character.MAX_VALUE) {
                String segment = String.valueOf((char) unit);
                boolean initial = (int) lexer.invoke(null, segment, 0) == 1;
                accepted = continuationOnly ? !initial && (int) lexer.invoke(null, "A" + segment, 0) == 2 : initial;
            }
            if (accepted && start < 0) {
                start = unit;
            } else if (!accepted && start >= 0) {
                if (ranges.length() > 1) ranges.append(',');
                ranges.append(start).append(',').append(unit - 1);
                start = -1;
            }
        }
        return ranges.append(']').toString();
    }

    public static void main(String[] args) throws Exception {
        Method lexer = Lexer.class.getDeclaredMethod("matchNCName", String.class, int.class);
        lexer.setAccessible(true);
        System.out.println("{\"initial\":" + ranges(lexer, false)
                + ",\"continuationOnly\":" + ranges(lexer, true) + "}");
    }
}
