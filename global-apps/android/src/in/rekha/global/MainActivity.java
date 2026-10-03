package in.rekha.global;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** Customer builds stay on their service; the owner build can open the twelve private inboxes. */
public final class MainActivity extends Activity {
  private static final int MEDIA_PERMISSION = 41;
  private static final int FILE_PICKER = 42;
  private static final String HOST = Uri.parse(BuildConfig.LIVE_URL).getHost();
  private static final Set<String> OWNER_HOSTS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
      "rekhaastrology.in",
      "rekha-luna-harbor.phukonbastab2.workers.dev",
      "rekha-willow-moon.phukonbastab2.workers.dev",
      "rekha-southern-star.phukonbastab2.workers.dev",
      "rekha-siam-dao.phukonbastab2.workers.dev",
      "rekha-nyota-path.phukonbastab2.workers.dev",
      "rekha-tala-guide.phukonbastab2.workers.dev",
      "rekha-orion-naija.phukonbastab2.workers.dev",
      "rekha-byeol-saju.phukonbastab2.workers.dev",
      "rekha-serendib-stars.phukonbastab2.workers.dev",
      "rekha-hoshi-note.phukonbastab2.workers.dev",
      "rekha-xing-light.phukonbastab2.workers.dev",
      "rekha-csillag-ut.phukonbastab2.workers.dev")));

  private WebView web;
  private PermissionRequest pendingPermission;
  private ValueCallback<Uri[]> fileCallback;
  private String fileOrigin;

  private static boolean allowedUrl(Uri uri) {
    if (uri == null || !"https".equals(uri.getScheme()) || uri.getUserInfo() != null
        || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
    String host = uri.getHost();
    return host != null && (BuildConfig.IS_OWNER ? OWNER_HOSTS.contains(host) : HOST.equals(host));
  }

  private static String origin(Uri uri) {
    return allowedUrl(uri) ? "https://" + uri.getHost() : null;
  }

  private String currentOrigin() {
    return web.getUrl() == null ? null : origin(Uri.parse(web.getUrl()));
  }

  private boolean permissionOriginAllowed(PermissionRequest request) {
    String requestedOrigin = origin(request.getOrigin());
    return requestedOrigin != null && requestedOrigin.equals(currentOrigin());
  }

  private void completePermission() {
    PermissionRequest request = pendingPermission;
    pendingPermission = null;
    if (request == null) return;
    if (!permissionOriginAllowed(request)) { request.deny(); return; }
    ArrayList<String> allowed = new ArrayList<>();
    for (String resource : request.getResources()) {
      if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
          && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) allowed.add(resource);
      if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
          && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) allowed.add(resource);
    }
    // Grant only recognized resources; a future WebView capability is never implicitly approved.
    if (allowed.size() == request.getResources().length) request.grant(allowed.toArray(new String[0]));
    else request.deny();
  }

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    web = new WebView(this);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(false);
    web.getSettings().setAllowFileAccess(false);
    web.getSettings().setAllowContentAccess(false);
    web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.getSettings().setMediaPlaybackRequiresUserGesture(false);
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(PermissionRequest request) {
        runOnUiThread(() -> {
          if (!permissionOriginAllowed(request) || pendingPermission != null) { request.deny(); return; }
          pendingPermission = request;
          ArrayList<String> needed = new ArrayList<>();
          for (String resource : request.getResources()) {
            String permission = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) ? Manifest.permission.RECORD_AUDIO
                : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) ? Manifest.permission.CAMERA : null;
            if (permission == null) { pendingPermission = null; request.deny(); return; }
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) needed.add(permission);
          }
          if (needed.isEmpty()) completePermission();
          else requestPermissions(needed.toArray(new String[0]), MEDIA_PERMISSION);
        });
      }

      @Override public void onPermissionRequestCanceled(PermissionRequest request) {
        if (pendingPermission == request) pendingPermission = null;
      }

      @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = null;
        fileOrigin = currentOrigin();
        if (fileOrigin == null) { callback.onReceiveValue(null); return true; }
        fileCallback = callback;
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        picker.addCategory(Intent.CATEGORY_OPENABLE);
        picker.setType("*/*");
        picker.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"image/*", "audio/*", "video/*", "application/pdf"});
        try { startActivityForResult(picker, FILE_PICKER); }
        catch (Exception error) { fileCallback.onReceiveValue(null); fileCallback = null; fileOrigin = null; }
        return true;
      }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return !allowedUrl(request.getUrl());
      }

      @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); }

      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (!allowedUrl(request.getUrl())) return error();
        if (!"appassets.androidplatform.net".equals(HOST)) return null;
        String name = request.getUrl().getPath();
        if (name == null || !name.startsWith("/assets/") || name.contains("..") || name.contains("\\")) return error();
        name = name.substring(8);
        if (name.isEmpty()) name = "index.html";
        String mime = name.endsWith(".html") ? "text/html" : name.endsWith(".js") ? "text/javascript"
            : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml"
            : name.endsWith(".webmanifest") ? "application/manifest+json" : "text/plain";
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        try { return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, getAssets().open(name)); }
        catch (Exception ignored) { return error(); }
      }

      private WebResourceResponse error() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
      }
    });
    if (BuildConfig.IS_OWNER) {
      LinearLayout screen = new LinearLayout(this);
      screen.setOrientation(LinearLayout.VERTICAL);
      LinearLayout toolbar = new LinearLayout(this);
      toolbar.setPadding(12, 2, 12, 2);
      toolbar.setGravity(android.view.Gravity.CENTER_VERTICAL);
      toolbar.setBackgroundColor(Color.rgb(22, 33, 40));
      TextView title = new TextView(this);
      title.setText("Rekha Global Admin");
      title.setTextColor(Color.WHITE);
      title.setTextSize(16);
      toolbar.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
      Button apps = new Button(this);
      apps.setText("Apps");
      apps.setContentDescription("Return to the twelve app list");
      apps.setOnClickListener(button -> web.loadUrl(BuildConfig.LIVE_URL));
      toolbar.addView(apps);
      screen.addView(toolbar);
      screen.addView(web, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
      setContentView(screen);
    } else setContentView(web);
    web.loadUrl(BuildConfig.LIVE_URL);
  }

  @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }

  @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(code, permissions, results);
    if (code == MEDIA_PERMISSION) completePermission();
  }

  @Override protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == FILE_PICKER && fileCallback != null) {
      Uri selected = result == RESULT_OK && data != null ? data.getData() : null;
      boolean samePage = fileOrigin != null && fileOrigin.equals(currentOrigin());
      fileCallback.onReceiveValue(samePage && selected != null && "content".equals(selected.getScheme()) ? new Uri[] {selected} : null);
      fileCallback = null;
      fileOrigin = null;
    }
  }

  @Override public void onDestroy() {
    if (pendingPermission != null) pendingPermission.deny();
    if (fileCallback != null) fileCallback.onReceiveValue(null);
    web.destroy();
    super.onDestroy();
  }
}
