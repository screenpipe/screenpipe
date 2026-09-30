// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

/** Validate certificate chains and hostnames without credentials or signing. */
public final class SigningTlsProbe {
    public static void main(String[] args) throws Exception {
        if (args.length == 0) throw new IllegalArgumentException("Expected HTTPS endpoints");
        for (String endpoint : args) {
            HttpsURLConnection connection = (HttpsURLConnection) new URL(endpoint).openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("HEAD");
            try {
                // A 401/404/405 is fine: only TLS is tested, not authentication.
                int status = connection.getResponseCode();
                System.out.println("TLS verified: " + endpoint + " (HTTP " + status + ")");
            } finally {
                connection.disconnect();
            }
        }
    }
}
