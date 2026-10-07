package nova.proof.formplayer;

import org.commcare.suite.model.Text;
import org.javarosa.core.model.utils.DateUtils;
import org.javarosa.xpath.expr.XPathNowFunc;
import org.javarosa.xpath.expr.XPathTodayFunc;

import java.net.URISyntaxException;
import java.nio.file.Path;
import java.util.Date;
import java.util.List;

/**
 * The clock every clock read an app's logic reaches in Formplayer's Core reads in this runner.
 *
 * Formplayer evaluates an app's logic with the Core it vendors (libs/commcare),
 * and that Core reads the wall clock, with new Date(), in three places an
 * app's logic reaches: XPathNowFunc.evalBody (now()), XPathTodayFunc.evalBody
 * (today()) and Text.evaluate (the dow() suite texts get). The client compiles
 * those three classes from the vendored Core's own source with that one
 * expression changed to ProofClock.now(), and puts them ahead of Formplayer's
 * libraries on the classpath (proof/formplayer/client.py), exactly as the Core
 * runner does (proof/core/src/nova/proof/core/ProofClock.java says why no other
 * clock read of Core's reaches what an app shows or stores). Every other line
 * of each class is Core's, and every class of Formplayer's is Formplayer's.
 *
 * Formplayer's own clock reads are left real: they date its sessions, its
 * locks and a user's last sync (RestoreFactory.setLastSyncTime), none of which
 * an app's logic reads. What they put in a response (a session's dates) the
 * client masks by name (proof/formplayer/canonical.py).
 */
public final class ProofClock {
    /** Core's classes whose clock read the runner replaces, as the client recompiles them. */
    static final List<Class<?>> READERS = List.of(XPathNowFunc.class, XPathTodayFunc.class, Text.class);

    private static volatile long frozen = DateUtils.parseDateTime("2026-01-15T10:30:00.000Z").getTime();

    private ProofClock() {
    }

    public static Date now() {
        return new Date(frozen);
    }

    static void set(String instant) {
        Date parsed;
        try {
            parsed = DateUtils.parseDateTime(instant);
        } catch (RuntimeException e) {
            parsed = null;
        }
        if (parsed == null || instant.indexOf('T') < 0) {
            throw new RequestException("The clock must be an ISO 8601 date-time such as"
                    + " 2026-01-15T10:30:00.000Z; it was \"" + instant + "\".");
        }
        frozen = parsed.getTime();
    }

    /**
     * Refuses to run when the JVM loaded one of Core's own clock-reading classes
     * rather than the runner's, since then it would read the wall clock.
     */
    static void requireInstalled() {
        Path runner = location(ProofClock.class);
        for (Class<?> clockReader : READERS) {
            Path loaded = location(clockReader);
            if (!runner.equals(loaded)) {
                throw new IllegalStateException("Core's " + clockReader.getSimpleName() + " was loaded from "
                        + loaded + " rather than from the runner's classes at " + runner + ", so it would read"
                        + " the wall clock. Put the runner's classes first on the classpath.");
            }
        }
    }

    private static Path location(Class<?> type) {
        try {
            return Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI());
        } catch (URISyntaxException | NullPointerException e) {
            throw new IllegalStateException("The runner could not tell where " + type.getName()
                    + " was loaded from: " + e, e);
        }
    }
}
