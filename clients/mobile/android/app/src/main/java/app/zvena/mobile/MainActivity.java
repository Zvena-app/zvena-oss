package app.zvena.mobile;

import android.content.Intent;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * The zvena web app in Capacitor's WebView, plus what Android hands the app:
 * "Share to zvena" (text or a link) opens the web app's Save to zvena
 * screen, filled in; zvena:// links and App Links open their page here.
 * Anything off the app's origin is ignored (Links).
 */
public class MainActivity extends BridgeActivity {
    private static final String HANDLED = "app.zvena.mobile.handled";

    // BridgeActivity.onCreate hands the launch intent here too.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent == null || bridge == null || intent.getBooleanExtra(HANDLED, false)) return;
        String target = targetOf(intent);
        if (target == null) return;
        // Once: a recreated activity must not open the shared item again.
        intent.putExtra(HANDLED, true);
        WebView web = bridge.getWebView();
        web.post(() -> web.loadUrl(target));
    }

    private String targetOf(Intent intent) {
        String app = bridge.getServerUrl();
        if (app == null) return null;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            String type = intent.getType();
            if (type == null || !type.startsWith("text/")) return null;
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            if (text == null && subject == null) return null;
            return Links.clipUrl(text == null ? null : text.toString(), subject, app);
        }
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            return Links.resolve(intent.getDataString(), app);
        }
        return null;
    }
}
