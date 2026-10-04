package nova.compatibility;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Where the proof harness keeps each family's artifacts.
 *
 * The harness (proof/native) writes every family's producer output and HQ
 * regeneration under one directory, a subdirectory per family, and names that
 * directory in the {@code nova.proof.native} system property of the test JVM
 * (proof/native/core/native-proof.init.gradle). Tests that hand an artifact
 * back to HQ, or read one by file path rather than from the classpath, use the
 * family's directory here.
 */
final class NativeProof {
    private NativeProof() {}

    static Path familyDirectory(String family) {
        String root = System.getProperty("nova.proof.native");
        if (root == null || root.isEmpty()) {
            throw new IllegalStateException(
                "The native proofs read and write their artifacts under the directory the harness names in the "
                    + "nova.proof.native system property, and this JVM has none. Run them through the proof harness "
                    + "(npm run proof -- proof/native), which sets it.");
        }
        Path directory = Path.of(root, family);
        if (!Files.isDirectory(directory)) {
            throw new IllegalStateException(
                "The native proofs expected the " + family + " family's artifacts in " + directory
                    + ", and that directory does not exist. Its producer runs before Core in the harness; check the "
                    + "producer's output in the pytest report.");
        }
        return directory;
    }
}
