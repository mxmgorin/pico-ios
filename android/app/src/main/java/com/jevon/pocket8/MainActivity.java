package com.jevon.pocket8;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // cold start
        handleDeepLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // warm resume
        setIntent(intent);
        handleDeepLink(intent);
    }

    private void handleDeepLink(Intent intent) {
        Uri data = intent.getData();

        if (data != null && "pocket8".equals(data.getScheme())) {
            String url = data.toString();
            System.out.println("[MainActivity] Deep Link detected: " + url);

            // poll for Vue
            pulseInject(url, 0);
        }
    }

    private void pulseInject(String url, int attempt) {
        if (attempt > 20) { // try for 10 seconds
            System.out.println("[MainActivity] Gave up injecting after 10s");
            return;
        }

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (getBridge() == null) {
                System.out.println("[MainActivity] Bridge is null, retrying...");
                pulseInject(url, attempt + 1);
                return;
            }

            if (getBridge().getWebView() == null) {
                System.out.println("[MainActivity] WebView is null, retrying...");
                pulseInject(url, attempt + 1);
                return;
            }

            // JavaScript to check if function exists before calling
            String js = "if (window.handleOpenUrl) { window.handleOpenUrl('" + url + "'); } else { console.log('⚡️ [Native] Vue not ready...'); }";

            System.out.println("[MainActivity] Pulse #" + (attempt + 1) + " firing...");
            getBridge().getWebView().evaluateJavascript(js, null);

            // keep pulsing for a bit just in case
            if (attempt < 5) {
                pulseInject(url, attempt + 1);
            }
        }, 500);
    }
}