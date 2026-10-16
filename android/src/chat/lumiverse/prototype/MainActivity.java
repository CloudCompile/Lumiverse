package chat.lumiverse.prototype;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Minimal APK runtime host. No WebView/native JavaScript bridge is exposed. */
public final class MainActivity extends Activity {
    private RuntimeHost runtime;
    private volatile boolean destroyed;
    private WebView web;
    private TextView status;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(20, 19, 29));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            WindowInsets.Builder remaining = new WindowInsets.Builder(insets);
            if (Build.VERSION.SDK_INT >= 30) {
                int types = WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout();
                Insets bars = insets.getInsets(types);
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                remaining.setInsets(types, Insets.NONE).setInsetsIgnoringVisibility(types, Insets.NONE);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                remaining.setSystemWindowInsets(Insets.NONE).setStableInsets(Insets.NONE);
            }
            return remaining.setDisplayCutout(null).build();
        });
        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setPadding(20, 12, 20, 12);
        root.addView(status);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(20, 19, 29));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())) return false;
                if (request.isForMainFrame() && request.hasGesture() && "https".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) { }
                }
                return true;
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
        root.requestApplyInsets();
        update("Opening Lumiverse…");
        runtime = new RuntimeHost(this, "java", new RuntimeHost.Listener() {
            @Override public void ready(String url) { runOnUiThread(() -> {
                if (destroyed) return;
                status.setVisibility(View.GONE);
                web.loadUrl(url);
            }); }
            @Override public void failed(String message) { update(message); }
        });
        runtime.start();
    }

    private void update(String message) {
        runOnUiThread(() -> { if (!destroyed) { status.setVisibility(View.VISIBLE); status.setText(message); } });
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override public void onDestroy() {
        synchronized (this) { destroyed = true; if (runtime != null) runtime.stop(); }
        web.destroy();
        super.onDestroy();
    }
}
