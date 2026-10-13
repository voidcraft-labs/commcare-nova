package nova.proof.formplayer;

import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.web.context.WebServerInitializedEvent;
import org.springframework.context.ApplicationEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * What Formplayer's own start tells the runner: the port its web server bound and its application context.
 *
 * The runner starts Formplayer through org.commcare.formplayer.Application.main,
 * which keeps the context to itself. Spring Boot offers every application
 * listener named in a META-INF/spring.factories on the classpath the events of
 * the application it starts, so the runner's names this class (the client
 * writes that file beside the runner's classes) and learns both from
 * Formplayer's own start, with nothing of Formplayer's replaced.
 */
public final class Started implements ApplicationListener<ApplicationEvent> {
    private static volatile int port = -1;
    private static volatile ConfigurableApplicationContext context;

    @Override
    public void onApplicationEvent(ApplicationEvent event) {
        if (event instanceof WebServerInitializedEvent) {
            WebServerInitializedEvent initialized = (WebServerInitializedEvent)event;
            // Formplayer's own server, not a management server's child context.
            if (initialized.getApplicationContext().getServerNamespace() == null) {
                port = initialized.getWebServer().getPort();
            }
        } else if (event instanceof ApplicationReadyEvent) {
            context = ((ApplicationReadyEvent)event).getApplicationContext();
        }
    }

    static int port() {
        return port;
    }

    static ConfigurableApplicationContext context() {
        return context;
    }
}
