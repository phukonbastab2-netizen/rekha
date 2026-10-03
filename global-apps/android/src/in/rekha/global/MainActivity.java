package in.rekha.global;
import android.app.Activity;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import java.util.ArrayList;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebChromeClient;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import java.io.ByteArrayInputStream;
import java.util.Map;
import java.util.HashMap;
import java.util.Collections;

/** Each country APK serves its own bundled preview from a secure virtual origin. */
public final class MainActivity extends Activity {
  private WebView web;
  private PermissionRequest pendingPermission;
  private ValueCallback<Uri[]> fileCallback;
  private void completePermission(){
    PermissionRequest request=pendingPermission;pendingPermission=null;if(request==null)return;
    ArrayList<String> allowed=new ArrayList<>();
    for(String resource:request.getResources()){
      if(PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)&&checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED)allowed.add(resource);
      if(PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)&&checkSelfPermission(Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED)allowed.add(resource);
    }
    if(allowed.size()==request.getResources().length)request.grant(allowed.toArray(new String[0]));else request.deny();
  }
  private static final String HOST="appassets.androidplatform.net";
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    web=new WebView(this);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(false);
    web.getSettings().setAllowFileAccess(false);
    web.getSettings().setAllowContentAccess(false);
    web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.setWebChromeClient(new WebChromeClient(){
      @Override public void onPermissionRequest(PermissionRequest request){runOnUiThread(()->{
        if(!("https://"+HOST).equals(request.getOrigin().toString().replaceAll("/$",""))||pendingPermission!=null){request.deny();return;}
        pendingPermission=request;ArrayList<String> needed=new ArrayList<>();
        for(String resource:request.getResources()){
          String permission=PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)?Manifest.permission.RECORD_AUDIO:PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)?Manifest.permission.CAMERA:null;
          if(permission==null){pendingPermission=null;request.deny();return;}
          if(checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED)needed.add(permission);
        }
        if(needed.isEmpty())completePermission();else requestPermissions(needed.toArray(new String[0]),41);
      });}
      @Override public void onPermissionRequestCanceled(PermissionRequest request){if(pendingPermission==request)pendingPermission=null;}
      @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
        if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;
        Intent picker=new Intent(Intent.ACTION_OPEN_DOCUMENT);picker.addCategory(Intent.CATEGORY_OPENABLE);picker.setType("*/*");picker.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/*","audio/*","video/*","application/pdf"});
        try{startActivityForResult(picker,42);}catch(Exception error){fileCallback.onReceiveValue(null);fileCallback=null;}return true;
      }
    });
    web.setWebViewClient(new WebViewClient(){
      @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
        return !"https".equals(request.getUrl().getScheme())||!HOST.equals(request.getUrl().getHost());
      }
      @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error){handler.cancel();}
      @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
        if(!"https".equals(request.getUrl().getScheme())||!HOST.equals(request.getUrl().getHost()))return error();
        String name=request.getUrl().getPath();
        if(name==null||!name.startsWith("/assets/")||name.contains("..")||name.contains("\\"))return error();
        name=name.substring(8);if(name.isEmpty())name="index.html";
        String mime=name.endsWith(".html")?"text/html":name.endsWith(".js")?"text/javascript":name.endsWith(".css")?"text/css":name.endsWith(".svg")?"image/svg+xml":name.endsWith(".webmanifest")?"application/manifest+json":"text/plain";
        Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");headers.put("X-Content-Type-Options","nosniff");
        try{return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,getAssets().open(name));}
        catch(Exception ignored){return error();}
      }
      private WebResourceResponse error(){return new WebResourceResponse("text/plain","UTF-8",404,"Not found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
    });
    setContentView(web);web.loadUrl("https://"+HOST+"/assets/index.html");
  }
  @Override public void onBackPressed(){if(web.canGoBack())web.goBack();else super.onBackPressed();}
  @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){super.onRequestPermissionsResult(code,permissions,results);if(code==41)completePermission();}
  @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==42&&fileCallback!=null){fileCallback.onReceiveValue(result==RESULT_OK&&data!=null&&data.getData()!=null?new Uri[]{data.getData()}:null);fileCallback=null;}}
  @Override public void onDestroy(){if(pendingPermission!=null)pendingPermission.deny();if(fileCallback!=null)fileCallback.onReceiveValue(null);web.destroy();super.onDestroy();}
}
