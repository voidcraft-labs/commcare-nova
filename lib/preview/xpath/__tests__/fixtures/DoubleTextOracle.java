// Regenerate with OpenJDK 17: java DoubleTextOracle.java > double-text-openjdk17.json
// Exact raw IEEE-754 bits avoid either JavaScript's formatter or decimal parser
// becoming the oracle's input transformation. This is a finite regression corpus.
import java.util.LinkedHashSet;
import java.util.Random;

class DoubleTextOracle {
    public static void main(String[] args) {
        if (Runtime.version().feature() != 17) throw new IllegalStateException("OpenJDK 17 required");
        var bits = new LinkedHashSet<Long>();
        for (long boundary : new long[] {0L, 1L, 0x000fffffffffffffL, 0x0010000000000000L,
                Double.doubleToRawLongBits(1e-3), Double.doubleToRawLongBits(1e7),
                Double.doubleToRawLongBits(1e23), 0x7fefffffffffffffL}) {
            for (long offset : new long[] {-1L, 0L, 1L}) {
                bits.add(boundary + offset);
                bits.add((boundary + offset) ^ Long.MIN_VALUE);
            }
        }
        var random = new Random(0x4e4f5641L);
        for (int i = 0; i < 256; i++) bits.add(random.nextLong());
        System.out.println("[");
        int i = 0;
        for (long value : bits) {
            System.out.printf("  [\"%016x\", \"%s\"]%s%n", value,
                Double.toString(Double.longBitsToDouble(value)), ++i < bits.size() ? "," : "");
        }
        System.out.println("]");
    }
}
