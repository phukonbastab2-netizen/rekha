package in.rekhaastrology.whatsappadmin;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import android.widget.*;
import java.io.*;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
  private static final String HOST="rekha-openwa-funnel.phukonbastab2.workers.dev";
  private static final String HOME="https://"+HOST+"/admin";
  private WebView web;
  private String downloadUrl;
  private final ExecutorService downloads=Executors.newSingleThreadExecutor();
  private boolean privateUrl(Uri uri){return "https".equals(uri.getScheme())&&HOST.equals(uri.getHost())&&uri.getPort()==-1&&(uri.getPath().equals("/admin")||uri.getPath().startsWith("/admin/"));}
  @Override public void onCreate(Bundle state){
    super.onCreate(state);getWindow().setStatusBarColor(Color.rgb(18,91,72));getWindow().setNavigationBarColor(Color.WHITE);
    LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(Color.rgb(18,91,72));
    web=new WebView(this);root.addView(web,new LinearLayout.LayoutParams(-1,-1));setContentView(root);
    if(android.os.Build.VERSION.SDK_INT>=30){root.setOnApplyWindowInsetsListener((v,insets)->{android.graphics.Insets bars=insets.getInsets(android.view.WindowInsets.Type.systemBars());v.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;});}
    WebView.setWebContentsDebuggingEnabled(false);
    WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setSafeBrowsingEnabled(true);s.setMediaPlaybackRequiresUserGesture(true);
    CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
    web.setWebChromeClient(new WebChromeClient(){@Override public boolean onJsConfirm(WebView view,String url,String message,JsResult result){new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("Confirm",(d,w)->result.confirm()).setNegativeButton("Cancel",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;}});
    web.setWebViewClient(new WebViewClient(){
      @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){Uri u=request.getUrl();if(privateUrl(u))return false;if("https".equals(u.getScheme())&&("pub-e67cd25c4ce94bc38f1077c04b6cfd17.r2.dev".equals(u.getHost())||"dash.cloudflare.com".equals(u.getHost()))){try{startActivity(new Intent(Intent.ACTION_VIEW,u));}catch(Exception ignored){}}return true;}
      @Override public void onReceivedSslError(WebView view,android.webkit.SslErrorHandler handler,android.net.http.SslError error){handler.cancel();Toast.makeText(MainActivity.this,"Secure connection failed. Check your internet and phone date.",Toast.LENGTH_LONG).show();}
      @Override public void onPageFinished(WebView view,String url){CookieManager.getInstance().flush();}
    });
    web.setDownloadListener((url,userAgent,contentDisposition,mime,length)->{Uri uri=Uri.parse(url);if(!privateUrl(uri)||!uri.getPath().matches("/admin/api/media/[a-f0-9]{64}"))return;downloadUrl=url;Intent save=new Intent(Intent.ACTION_CREATE_DOCUMENT);save.setType(mime==null?"application/octet-stream":mime);save.addCategory(Intent.CATEGORY_OPENABLE);save.putExtra(Intent.EXTRA_TITLE,"customer-attachment");try{startActivityForResult(save,40);}catch(Exception e){Toast.makeText(this,"No file picker available",Toast.LENGTH_LONG).show();}});
    web.loadUrl(HOME);
  }
  @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request!=40||result!=RESULT_OK||data==null||downloadUrl==null)return;final String url=downloadUrl;downloadUrl=null;final Uri target=data.getData();final String cookies=CookieManager.getInstance().getCookie(url);downloads.execute(()->{HttpsURLConnection connection=null;try{connection=(HttpsURLConnection)new URL(url).openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(30000);if(cookies!=null)connection.setRequestProperty("Cookie",cookies);if(connection.getResponseCode()!=200)throw new IOException();try(InputStream in=connection.getInputStream();OutputStream out=getContentResolver().openOutputStream(target)){byte[] buffer=new byte[32768];int n,total=0;while((n=in.read(buffer))!=-1){total+=n;if(total>25*1024*1024)throw new IOException();out.write(buffer,0,n);}}runOnUiThread(()->Toast.makeText(this,"Attachment saved",Toast.LENGTH_LONG).show());}catch(Exception e){runOnUiThread(()->Toast.makeText(this,"Could not save attachment. Sign in and try again.",Toast.LENGTH_LONG).show());}finally{if(connection!=null)connection.disconnect();}});}
  @Override public void onBackPressed(){if(web.canGoBack())web.goBack();else super.onBackPressed();}
  @Override protected void onPause(){CookieManager.getInstance().flush();super.onPause();}
  @Override protected void onDestroy(){downloads.shutdownNow();web.destroy();super.onDestroy();}
}
