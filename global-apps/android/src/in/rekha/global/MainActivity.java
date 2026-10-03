package in.rekha.global;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JsPromptResult;
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
import java.util.UUID;
import org.json.JSONObject;

/** Customer builds stay on their service; the owner build can open the twelve private inboxes. */
public final class MainActivity extends Activity {
  private static final int MEDIA_PERMISSION = 41;
  private static final int FILE_PICKER = 42;
  private static final String AUDIO_BRIDGE = "rekha-global-audio/1";
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
  private RoutingSession callAudio;
  private boolean foreground;
  private boolean destroyed;

  // BEGIN TESTABLE AUDIO CORE. These classes run unchanged in the JVM verification harness.
  interface AudioPort {
    int mode();
    void mode(int value);
    boolean speaker();
    void legacySpeaker(boolean enabled);
    boolean modern();
    boolean selectSpeaker();
    void clearSelection();
    boolean requestFocus();
    void abandonFocus();
  }

  static final class AudioReply {
    final boolean ok, active, speaker;
    final String nonce, error;
    AudioReply(boolean ok, boolean active, boolean speaker, String nonce, String error) {
      this.ok=ok;this.active=active;this.speaker=speaker;this.nonce=nonce;this.error=error;
    }
  }

  static final class RoutingSession {
    private static final int COMMUNICATION_MODE = 3;
    private static final int PHONE_CALL_MODE = 2, CALL_SCREENING_MODE = 4;
    private final AudioPort audio;
    private String pageOrigin, nonce, callId;
    private boolean active, saved, priorSpeaker, changedMode, changedRoute, requestedFocus;
    private int priorMode;
    RoutingSession(AudioPort audio) { this.audio=audio; }
    String nonce() { return nonce; }
    String callId() { return callId; }
    boolean active() { return active; }
    void newPage(String pageOrigin) { end();this.pageOrigin=pageOrigin;nonce=UUID.randomUUID().toString(); }
    private AudioReply reply(boolean ok, String error, boolean capability) {
      boolean speaker=false;try { if(active) speaker=audio.speaker(); } catch(RuntimeException ignored) {}
      return new AudioReply(ok,active,speaker,capability?nonce:null,error);
    }
    AudioReply request(String sourceOrigin,String currentOrigin,String command,String suppliedNonce,String id,Boolean value,boolean permission,boolean foreground) {
      if(pageOrigin==null||!pageOrigin.equals(sourceOrigin)||!pageOrigin.equals(currentOrigin)) return reply(false,"Open call controls from this app's current page.",false);
      if("capabilities".equals(command)) return reply(true,null,true);
      if(nonce==null||!nonce.equals(suppliedNonce)||id==null||!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")||value==null) return reply(false,"The call controls are out of date. Reopen the call.",false);
      if("onCallState".equals(command)) {
        if(!value) {
          if(active&&!id.equals(callId)) return reply(false,"This call is no longer current.",false);
          end();return reply(true,null,false);
        }
        if(active&&!id.equals(callId)) return reply(false,"Another call is current.",false);
        if(!permission||!foreground) { end();return reply(false,"Allow microphone access and keep this app open.",false); }
        if(active) return reply(true,null,false);
        try {
          priorMode=audio.mode();
          if(priorMode==PHONE_CALL_MODE||priorMode==CALL_SCREENING_MODE) return reply(false,"Phone audio is busy with another call. Try again when it ends.",false);
          priorSpeaker=audio.speaker();saved=true;requestedFocus=true;
          if(!audio.requestFocus()) { end();return reply(false,"Phone audio is busy. Try the call audio control again.",false); }
          if(priorMode!=COMMUNICATION_MODE) { changedMode=true;audio.mode(COMMUNICATION_MODE); }
          callId=id;active=true;return reply(true,null,false);
        } catch(RuntimeException ignored) { end();return reply(false,"Phone call audio could not start.",false); }
      }
      if(!"setSpeakerphone".equals(command)) return reply(false,"Unsupported call audio command.",false);
      if(!active||!id.equals(callId)) return reply(false,"Answer the current call before changing phone audio.",false);
      if(!permission||!foreground) { end();return reply(false,"Allow microphone access and keep this app open.",false); }
      try {
        if(audio.modern()) {
          if(value) { changedRoute=true;if(!audio.selectSpeaker()) return reply(false,"Speaker is unavailable on this phone.",false); }
          else { audio.clearSelection();changedRoute=false; }
        } else { changedRoute=true;audio.legacySpeaker(value); }
        if(value&&!audio.speaker()) return reply(false,"Speaker routing was not accepted by this phone.",false);
        return reply(true,null,false);
      } catch(RuntimeException ignored) { return reply(false,"Phone audio could not change. Try again.",false); }
    }
    void end() {
      active=false;callId=null;
      // Clear only this app's request. Platform routing resumes, including an existing headset.
      if(saved) {
        try { if(changedRoute) { if(audio.modern()) audio.clearSelection();else if(audio.mode()==COMMUNICATION_MODE) audio.legacySpeaker(priorSpeaker); } } catch(RuntimeException ignored) {}
        try { if(changedMode&&audio.mode()==COMMUNICATION_MODE) audio.mode(priorMode); } catch(RuntimeException ignored) {}
      }
      if(requestedFocus) { try { audio.abandonFocus(); } catch(RuntimeException ignored) {} }
      saved=changedMode=changedRoute=requestedFocus=false;
    }
  }
  // END TESTABLE AUDIO CORE.

  private final class AndroidAudioPort implements AudioPort {
    private final AudioManager manager=(AudioManager)getSystemService(AUDIO_SERVICE);
    private AudioFocusRequest focus;
    private long focusGeneration;
    public int mode() { return manager.getMode(); }
    public void mode(int value) { manager.setMode(value); }
    public boolean modern() { return Build.VERSION.SDK_INT>=31; }
    public boolean speaker() {
      if(!modern()) return manager.isSpeakerphoneOn();
      AudioDeviceInfo device=manager.getCommunicationDevice();
      return device!=null&&device.getType()==AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
    }
    public void legacySpeaker(boolean enabled) { manager.setSpeakerphoneOn(enabled); }
    public boolean selectSpeaker() {
      for(AudioDeviceInfo device:manager.getAvailableCommunicationDevices()) {
        if(device.isSink()&&device.getType()==AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return manager.setCommunicationDevice(device);
      }
      return false;
    }
    public void clearSelection() { manager.clearCommunicationDevice(); }
    public boolean requestFocus() {
      final long generation=++focusGeneration;
      focus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
          .setAcceptsDelayedFocusGain(false).setOnAudioFocusChangeListener(change->{
            if(generation==focusGeneration&&(change==AudioManager.AUDIOFOCUS_LOSS||change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT||change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)) interruptCallAudio();
          },new Handler(Looper.getMainLooper())).build();
      return manager.requestAudioFocus(focus)==AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }
    public void abandonFocus() { focusGeneration++;if(focus!=null) { AudioFocusRequest previous=focus;focus=null;manager.abandonAudioFocusRequest(previous); } }
  }

  private String audioOrigin(Uri uri) {
    String result=origin(uri);
    return result!=null&&OWNER_HOSTS.contains(uri.getHost())&&!"rekhaastrology.in".equals(uri.getHost())?result:null;
  }

  private String audioReply(AudioReply reply) {
    JSONObject data=new JSONObject();
    try { data.put("ok",reply.ok);data.put("active",reply.active);data.put("speaker",reply.speaker);if(reply.nonce!=null)data.put("nonce",reply.nonce);if(reply.error!=null)data.put("error",reply.error); }
    catch(Exception ignored) { return "{\"ok\":false}"; }
    return data.toString();
  }

  private void interruptCallAudio() {
    if(callAudio==null||!callAudio.active()) return;
    String nonce=callAudio.nonce(),id=callAudio.callId(),page=currentOrigin();callAudio.end();
    if(destroyed||page==null) return;
    JSONObject detail=new JSONObject();
    try { detail.put("nonce",nonce);detail.put("callId",id);detail.put("active",false);detail.put("speaker",false);detail.put("error","Call audio was interrupted. Tap Phone audio or Speaker to resume."); }
    catch(Exception ignored) { return; }
    web.evaluateJavascript("if(location.origin==="+JSONObject.quote(page)+")document.dispatchEvent(new CustomEvent('rekha-native-audio',{detail:"+detail+"}));",null);
  }

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
    return web == null || web.getUrl() == null ? null : origin(Uri.parse(web.getUrl()));
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
    else { request.deny();interruptCallAudio(); }
  }

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    callAudio=new RoutingSession(new AndroidAudioPort());
    web = new WebView(this);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setUserAgentString(web.getSettings().getUserAgentString()+" "+AUDIO_BRIDGE);
    web.getSettings().setDomStorageEnabled(false);
    web.getSettings().setAllowFileAccess(false);
    web.getSettings().setAllowContentAccess(false);
    web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.getSettings().setMediaPlaybackRequiresUserGesture(false);
    web.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onJsPrompt(WebView view,String url,String message,String value,JsPromptResult result) {
        if(!AUDIO_BRIDGE.equals(message)) return false;
        AudioReply reply;
        try {
          if(destroyed||view!=web||value==null||value.length()>512) throw new IllegalArgumentException();
          String source=audioOrigin(Uri.parse(url)),current=web.getUrl()==null?null:audioOrigin(Uri.parse(web.getUrl()));
          JSONObject data=new JSONObject(value);
          Object command=data.opt("command"),nonce=data.opt("nonce"),id=data.opt("callId");
          if(!(command instanceof String)) throw new IllegalArgumentException();
          Object flag=data.opt("onCallState".equals(command)?"active":"speaker");
          reply=callAudio.request(source,current,(String)command,nonce instanceof String?(String)nonce:null,id instanceof String?(String)id:null,flag instanceof Boolean?(Boolean)flag:null,checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED,foreground);
        } catch(Exception ignored) { reply=new AudioReply(false,false,false,null,"Invalid call audio request."); }
        result.confirm(audioReply(reply));return true;
      }

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
        if (pendingPermission == request) { pendingPermission = null;interruptCallAudio(); }
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
      @Override public void onPageStarted(WebView view,String url,Bitmap favicon) {
        callAudio.newPage(audioOrigin(Uri.parse(url)));
        if(pendingPermission!=null) { pendingPermission.deny();pendingPermission=null; }
        super.onPageStarted(view,url,favicon);
      }
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

  @Override protected void onResume() { super.onResume();foreground=true; }

  @Override protected void onStop() { foreground=false;interruptCallAudio();super.onStop(); }

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
    destroyed=true;foreground=false;
    if(callAudio!=null)callAudio.end();
    if (pendingPermission != null) pendingPermission.deny();
    if (fileCallback != null) fileCallback.onReceiveValue(null);
    web.destroy();
    super.onDestroy();
  }
}
