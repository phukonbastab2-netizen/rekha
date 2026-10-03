package in.rekha.global;
import android.app.Activity;
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
  private static final String HOST="appassets.androidplatform.net";
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    web=new WebView(this);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(false);
    web.getSettings().setAllowFileAccess(false);
    web.getSettings().setAllowContentAccess(false);
    web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.setWebChromeClient(new WebChromeClient());
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
  @Override public void onDestroy(){web.destroy();super.onDestroy();}
}
