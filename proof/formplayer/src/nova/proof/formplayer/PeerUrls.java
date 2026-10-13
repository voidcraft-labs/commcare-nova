package nova.proof.formplayer;

import java.io.IOException;
import java.net.MalformedURLException;
import java.net.Proxy;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;

import org.apache.catalina.webresources.TomcatURLStreamHandlerFactory;

/**
 * Every http and https URL connection Formplayer's JVM opens, sent where
 * Formplayer's own replace-host mode sends its RestTemplate's requests
 * (RewriteHostRequestInterceptor): a URL that does not start with
 * commcarehq.host goes to that scheme, host and port, its path and query kept.
 *
 * Formplayer reaches HQ through a URL connection in one place its
 * RestTemplate does not cover: Core's JavaHttpReference, which an install
 * reads a resource from at its remote location (HQ's profile names one after
 * each local location, under the build's own address) when the archive's own
 * copy cannot be installed. Without this, that request left for the address
 * HQ's settings name (BASE_ADDRESS), over the network, and a hosted run waited
 * on it until the request's deadline; with it, the lane's own HQ answers it,
 * as production's HQ answers its Formplayer.
 *
 * A URL that already starts with commcarehq.host, and every other protocol,
 * is opened as the JDK opens it (or as Tomcat does, for its own protocols).
 */
final class PeerUrls {
    private PeerUrls() {
    }

    static void install(String commcareHost) throws MalformedURLException {
        // URLs made before the factory is set hold the JDK's own handlers, which a URL made against one of them
        // inherits for the same protocol.
        URL http = new URL("http://localhost/");
        URL https = new URL("https://localhost/");
        URL host = new URL(commcareHost);
        URL hostContext = "https".equals(host.getProtocol()) ? https : http;
        String hostOrigin = host.getProtocol() + "://" + host.getHost()
                + (host.getPort() == -1 ? "" : ":" + host.getPort());
        // Formplayer's embedded Tomcat owns the JVM's one URL handler factory and consults the factories added to it
        // (TomcatURLStreamHandlerFactory.addUserFactory); adding this one first registers Tomcat's, before any URL
        // over http or https is made, so no handler the JDK caches bypasses it.
        TomcatURLStreamHandlerFactory.getInstance().addUserFactory(protocol -> {
            if (!"http".equals(protocol) && !"https".equals(protocol)) {
                return null;
            }
            URL own = "http".equals(protocol) ? http : https;
            return new URLStreamHandler() {
                @Override
                protected URLConnection openConnection(URL url) throws IOException {
                    return target(url).openConnection();
                }

                @Override
                protected URLConnection openConnection(URL url, Proxy proxy) throws IOException {
                    return target(url).openConnection(proxy);
                }

                private URL target(URL url) throws MalformedURLException {
                    String spec = url.toExternalForm();
                    if (spec.startsWith(commcareHost)) {
                        return new URL(own, spec);
                    }
                    return new URL(hostContext, hostOrigin + url.getFile());
                }
            };
        });
    }
}
