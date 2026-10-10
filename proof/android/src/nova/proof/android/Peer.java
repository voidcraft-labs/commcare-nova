package nova.proof.android;

import org.commcare.core.network.CommCareNetworkServiceGenerator;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

import okhttp3.tls.HandshakeCertificates;

/**
 * Where the device's network goes: the reader's loopback proxy (proof/android/peer.py), whose every request the
 * lane answers with HQ's own views over the state it serves (proof/android/hq.py).
 *
 * The app's own HTTP client (Core's CommCareNetworkServiceGenerator, which every request of the app's requester
 * and data pull goes through) is given the proxy, as a device on a network with a proxy is: a plain request is
 * sent to it whole, and an https one through a tunnel it opens with CONNECT, inside which the proxy speaks TLS
 * for the host the app named with a certificate of its own authority, which the client is given to trust
 * ({@link #AUTHORITY}). So every address the app names reaches the proxy, and the request the proxy reads is the
 * one the app wrote. Nothing else of the client changes: its interceptors (its credentials, its refusal to send a
 * password in clear, its redirect check, its clock drift reading) and the app's own configuration
 * (OkHttpBuilderCustomConfig, applied first) stay; only whom it trusts is the proxy's authority.
 *
 * The reader also tells the harness where a device's session begins ({@link #run}) and where it goes back to the
 * state every session starts from ({@link #base}), on a connection of its own that bypasses the proxy, so each
 * session meets HQ as the state's fork leaves it.
 */
final class Peer {
    static final String ADDRESS = "nova.proof.android.peer";
    static final String AUTHORITY = "nova.proof.android.peerAuthority";
    private static final String CONTROL = "/_proof/";

    private Peer() {
    }

    /** Whether the device has a network: the reader was given a proxy to send it through. */
    static boolean on() {
        String address = System.getProperty(ADDRESS);
        return address != null && !address.isEmpty();
    }

    private static InetSocketAddress address() {
        String address = System.getProperty(ADDRESS);
        int colon = address.lastIndexOf(':');
        return new InetSocketAddress(address.substring(0, colon), Integer.parseInt(address.substring(colon + 1)));
    }

    /** The app's own HTTP client, given the proxy and the proxy's authority to trust. */
    static void route() {
        try {
            X509Certificate authority;
            try (InputStream in = new FileInputStream(System.getProperty(AUTHORITY))) {
                authority = (X509Certificate)CertificateFactory.getInstance("X.509").generateCertificate(in);
            }
            HandshakeCertificates trusted = new HandshakeCertificates.Builder()
                    .addTrustedCertificate(authority).build();
            Proxy proxy = new Proxy(Proxy.Type.HTTP, address());
            CommCareNetworkServiceGenerator.customizeRetrofitSetup(builder -> builder
                    .proxy(proxy)
                    .sslSocketFactory(trusted.sslSocketFactory(), trusted.trustManager()));
        } catch (Exception raised) {
            throw new IllegalStateException("The reader could not route the device's network to its proxy.", raised);
        }
    }

    /**
     * A session of the device begins, named {@code name}: HQ meets it as the served state stands, in a fork of
     * its own that the next session's beginning, or {@link #base}, puts back. Nothing where the device has no
     * network.
     */
    static void run(String name) {
        if (on()) {
            control("run", name);
            seed("walk|" + name);
        }
    }

    /** The device goes back to the state every session starts from, where it logs in again. */
    static void base(String name) {
        if (on()) {
            control("base", name);
            seed("base|" + name);
        }
    }

    /**
     * Core's random source (MathUtils.getRand, which every id an app's logic or the device draws comes from:
     * uuid(), a new case's id, a form's instance id) replaced by one seeded from {@code name}, as the Core and
     * Formplayer runners seed it: what the device sends HQ (a form's instance id, the cases it makes) is then the
     * same on every run, and HQ, which keeps them, answers the same.
     */
    static void seed(String name) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(name.getBytes(StandardCharsets.UTF_8));
            long seed = java.nio.ByteBuffer.wrap(digest).getLong();
            java.lang.reflect.Field field = org.javarosa.core.util.MathUtils.class.getDeclaredField("r");
            field.setAccessible(true);
            field.set(null, new java.util.Random(seed));
        } catch (ReflectiveOperationException | java.security.NoSuchAlgorithmException raised) {
            throw new IllegalStateException("The reader could not seed Core's random source, so the ids the device"
                    + " sends HQ would differ between runs.", raised);
        }
    }

    /**
     * Tells the harness something of the reader's own ({@code what}, with {@code name}); an answer other than 200
     * raises, since the harness refuses only what the reader asked wrongly.
     */
    private static void control(String what, String name) {
        try {
            InetSocketAddress peer = address();
            URL url = new URL("http", peer.getHostString(), peer.getPort(), CONTROL + what + "?name="
                    + URLEncoder.encode(name == null ? "" : name, "UTF-8"));
            HttpURLConnection connection = (HttpURLConnection)url.openConnection(Proxy.NO_PROXY);
            connection.setConnectTimeout(60_000);
            connection.setReadTimeout(600_000);
            int status = connection.getResponseCode();
            InputStream in = status < 400 ? connection.getInputStream() : connection.getErrorStream();
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            if (in != null) {
                byte[] buffer = new byte[8192];
                for (int read; (read = in.read(buffer)) != -1; ) {
                    body.write(buffer, 0, read);
                }
                in.close();
            }
            connection.disconnect();
            if (status != 200) {
                throw new IllegalStateException("The harness answered the reader's " + what + " with " + status
                        + ": " + new String(body.toByteArray(), StandardCharsets.UTF_8));
            }
        } catch (java.io.IOException raised) {
            throw new IllegalStateException("The reader could not reach the harness for " + what + ".", raised);
        }
    }
}
