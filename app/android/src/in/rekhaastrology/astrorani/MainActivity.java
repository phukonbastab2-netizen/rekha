package in.rekhaastrology.astrorani;

import android.Manifest;
import android.app.*;
import android.app.job.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.util.ArrayList;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
  static final String HOST="astrorani.rekhaastrology.in";
  static final boolean OWNER=false;
  static final String HOME="https://"+HOST+(OWNER?"/admin":"/");
  private FrameLayout root;
  private WebView web;
  private LinearLayout offline;
  private GeolocationPermissions.Callback locationCallback;
  private String locationOrigin;
  private PermissionRequest mediaRequest;
  private ValueCallback<Uri[]> fileCallback;
  private View fullScreen;
  private WebChromeClient.CustomViewCallback fullScreenCallback;
  private boolean alertsRequested;
  private String saveUrl;
  private byte[] saveText;
  private boolean trusted(String value){if(value==null)return false;Uri uri=Uri.parse(value);return "https".equals(uri.getScheme())&&HOST.equals(uri.getHost())&&(uri.getPort()==-1||uri.getPort()==443);}
  @Override public void onCreate(Bundle state){
    super.onCreate(state);root=new FrameLayout(this);root.setBackgroundColor(Color.rgb(239,234,226));setContentView(root);
    root.setOnApplyWindowInsetsListener((view,insets)->{view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
    web=new WebView(this);web.setBackgroundColor(Color.rgb(239,234,226));WebSettings settings=web.getSettings();
    settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setAllowFileAccess(false);settings.setAllowContentAccess(true);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setSafeBrowsingEnabled(true);settings.setGeolocationEnabled(true);settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setUserAgentString(settings.getUserAgentString()+" Rekha"+(OWNER?"Admin":"Astrology")+"Android/0.5.0");
    CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);WebView.setWebContentsDebuggingEnabled(false);
    web.addJavascriptInterface(new DeviceOptions(),"RekhaDevice");
    web.setWebViewClient(new WebViewClient(){
      @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){Uri uri=request.getUrl();if(trusted(uri.toString())&&(OWNER||!uri.getPath().startsWith("/admin")))return false;if(request.isForMainFrame()&&"https".equals(uri.getScheme()))try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception ignored){}return true;}
      @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame())showOffline("Please check your connection and try again.");}
      @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error){handler.cancel();showOffline("A secure connection could not be established. Please try again later.");}
      @Override public void onPageFinished(WebView view,String url){CookieManager.getInstance().flush();if(trusted(url))MessageAlerts.checkpoint(MainActivity.this,OWNER);}
    });
    web.setWebChromeClient(new WebChromeClient(){
      @Override public void onGeolocationPermissionsShowPrompt(String origin,GeolocationPermissions.Callback callback){if(!trusted(origin)){callback.invoke(origin,false,false);return;}if(checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED){callback.invoke(origin,true,false);return;}if(locationCallback!=null)locationCallback.invoke(locationOrigin,false,false);locationCallback=callback;locationOrigin=origin;requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION},49);}
      @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams parameters){
        if(!trusted(web.getUrl()))return false;if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;
        Intent picker=new Intent(Intent.ACTION_OPEN_DOCUMENT);picker.addCategory(Intent.CATEGORY_OPENABLE);picker.setType("*/*");ArrayList<String> types=new ArrayList<>();
        for(String type:parameters.getAcceptTypes())if(type.matches("(?:image|video|audio)/[A-Za-z0-9.+*-]+")||"application/pdf".equals(type))types.add(type);
        if(types.isEmpty()){types.add("image/*");types.add("video/*");types.add("audio/*");types.add("application/pdf");}
        picker.putExtra(Intent.EXTRA_MIME_TYPES,types.toArray(new String[0]));picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,parameters.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
        try{startActivityForResult(picker,51);}catch(Exception e){fileCallback.onReceiveValue(null);fileCallback=null;}return true;
      }
      @Override public void onPermissionRequest(PermissionRequest request){runOnUiThread(()->{
        if(!trusted(request.getOrigin().toString())||!trusted(web.getUrl())||mediaRequest!=null){request.deny();return;}ArrayList<String> missing=new ArrayList<>();
        for(String resource:request.getResources()){String permission=PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)?Manifest.permission.RECORD_AUDIO:PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)?Manifest.permission.CAMERA:null;if(permission==null){request.deny();return;}if(checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED)missing.add(permission);}
        mediaRequest=request;if(missing.isEmpty())grantMedia();else requestPermissions(missing.toArray(new String[0]),50);
      });}
      @Override public void onPermissionRequestCanceled(PermissionRequest request){if(mediaRequest==request)mediaRequest=null;}
      @Override public void onShowCustomView(View view,CustomViewCallback callback){if(fullScreen!=null){callback.onCustomViewHidden();return;}fullScreen=view;fullScreenCallback=callback;web.setVisibility(View.GONE);root.addView(view,new FrameLayout.LayoutParams(-1,-1));}
      @Override public void onHideCustomView(){hideFullScreen();}
    });
    web.setDownloadListener((url,userAgent,disposition,mime,length)->{
      if(trusted(url)&&!mime.equals("application/vnd.android.package-archive")){if(length>25*1024*1024){Toast.makeText(this,"File is too large.",Toast.LENGTH_LONG).show();return;}saveUrl=url;saveText=null;chooseSave(mime,"Rekha attachment"+(mime.equals("application/pdf")?".pdf":mime.startsWith("image/")?".jpg":mime.startsWith("audio/")?".audio":mime.startsWith("video/")?".mp4":".txt"));}
      else if(url.startsWith("https://"))try{startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)));}catch(Exception ignored){}
    });
    root.addView(web,new FrameLayout.LayoutParams(-1,-1));web.loadUrl(HOME);
  }
  private void grantMedia(){if(mediaRequest==null)return;PermissionRequest request=mediaRequest;mediaRequest=null;if(!trusted(web.getUrl())||!trusted(request.getOrigin().toString())){request.deny();return;}ArrayList<String> granted=new ArrayList<>();for(String resource:request.getResources()){String permission=PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)?Manifest.permission.RECORD_AUDIO:PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)?Manifest.permission.CAMERA:null;if(permission!=null&&checkSelfPermission(permission)==PackageManager.PERMISSION_GRANTED)granted.add(resource);}if(granted.size()!=request.getResources().length)request.deny();else request.grant(granted.toArray(new String[0]));}
  private void hideFullScreen(){if(fullScreen==null)return;root.removeView(fullScreen);fullScreen=null;web.setVisibility(View.VISIBLE);if(fullScreenCallback!=null)fullScreenCallback.onCustomViewHidden();fullScreenCallback=null;}
  private void showOffline(String message){if(offline!=null)root.removeView(offline);offline=new LinearLayout(this);offline.setOrientation(LinearLayout.VERTICAL);offline.setGravity(Gravity.CENTER);offline.setPadding(36,40,36,40);offline.setBackgroundColor(Color.rgb(239,234,226));TextView title=new TextView(this);title.setText(OWNER?"Rekha Admin":"Rekha Astrology");title.setTextSize(30);title.setGravity(Gravity.CENTER);offline.addView(title);TextView text=new TextView(this);text.setText(message);text.setTextSize(16);text.setGravity(Gravity.CENTER);text.setPadding(0,28,0,28);offline.addView(text);Button retry=new Button(this);retry.setText("Try again");retry.setOnClickListener(v->{root.removeView(offline);offline=null;web.loadUrl(HOME);});offline.addView(retry);root.addView(offline,new FrameLayout.LayoutParams(-1,-1));}
  public final class DeviceOptions {
    @JavascriptInterface public void saveChatExport(String text){runOnUiThread(()->{if(!trusted(web.getUrl())||text==null||text.length()>2*1024*1024)return;saveText=text.getBytes(StandardCharsets.UTF_8);saveUrl=null;chooseSave("text/plain","Rekha-chat.txt");});}
    @JavascriptInterface public void showAlertSettings(){runOnUiThread(()->{if(!trusted(web.getUrl()))return;boolean enabled=getSharedPreferences("alerts",MODE_PRIVATE).getBoolean("enabled",false);
      new AlertDialog.Builder(MainActivity.this).setTitle("Message alerts").setMessage("Optional background checks can notify you about new messages. Android runs these periodically, usually 15 minutes or longer. Open the app for live chat and calls. Message text stays out of notifications.")
        .setPositiveButton(enabled?"Turn off":"Enable",(d,w)->{if(enabled){getSharedPreferences("alerts",MODE_PRIVATE).edit().putBoolean("enabled",false).apply();((JobScheduler)getSystemService(JOB_SCHEDULER_SERVICE)).cancel(49);}else{alertsRequested=true;if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},52);else enableAlerts();}}).setNegativeButton("Cancel",null).show();
    });}
  }
  private void enableAlerts(){alertsRequested=false;getSharedPreferences("alerts",MODE_PRIVATE).edit().putBoolean("enabled",true).apply();MessageAlerts.checkpoint(this,OWNER);JobInfo job=new JobInfo.Builder(49,new ComponentName(this,MessageAlerts.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(15*60*1000L).build();((JobScheduler)getSystemService(JOB_SCHEDULER_SERVICE)).schedule(job);}
  private void chooseSave(String mime,String name){Intent picker=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE,name);try{startActivityForResult(picker,53);}catch(Exception ignored){saveUrl=null;saveText=null;Toast.makeText(this,"No file picker available.",Toast.LENGTH_LONG).show();}}
  private void saveSelection(Uri destination){final String url=saveUrl;final byte[] text=saveText;saveUrl=null;saveText=null;if(destination==null)return;
    new Thread(()->{try(OutputStream output=getContentResolver().openOutputStream(destination)){
      if(text!=null)output.write(text);else if(url!=null&&trusted(url)){
        HttpURLConnection connection=(HttpURLConnection)new URL(url).openConnection();connection.setConnectTimeout(15000);connection.setReadTimeout(30000);connection.setInstanceFollowRedirects(false);String cookie=CookieManager.getInstance().getCookie("https://"+HOST);if(cookie!=null)connection.setRequestProperty("Cookie",cookie);
        try{if(connection.getResponseCode()!=200)throw new IOException();try(InputStream input=connection.getInputStream()){byte[] buffer=new byte[8192];int count,total=0;while((count=input.read(buffer))!=-1){total+=count;if(total>25*1024*1024)throw new IOException();output.write(buffer,0,count);}}}finally{connection.disconnect();}
      }else throw new IOException();runOnUiThread(()->Toast.makeText(this,"Saved to your selected location.",Toast.LENGTH_SHORT).show());
    }catch(Exception ignored){runOnUiThread(()->Toast.makeText(this,"Could not save this file. Please try again.",Toast.LENGTH_LONG).show());}},"rekha-file-save").start();
  }
  @Override protected void onActivityResult(int code,int result,Intent data){super.onActivityResult(code,result,data);if(code==51&&fileCallback!=null){fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result,data));fileCallback=null;}if(code==53){if(result==RESULT_OK&&data!=null)saveSelection(data.getData());else{saveUrl=null;saveText=null;}}}
  @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){super.onRequestPermissionsResult(code,permissions,results);if(code==49&&locationCallback!=null){locationCallback.invoke(locationOrigin,results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED,false);locationCallback=null;locationOrigin=null;}if(code==50)grantMedia();if(code==52){if(alertsRequested&&results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED)enableAlerts();else alertsRequested=false;}}
  @Override public void onBackPressed(){if(fullScreen!=null)hideFullScreen();else if(web.canGoBack())web.goBack();else super.onBackPressed();}
  @Override protected void onPause(){CookieManager.getInstance().flush();web.onPause();super.onPause();}
  @Override protected void onResume(){super.onResume();if(web!=null){web.onResume();MessageAlerts.checkpoint(this,OWNER);}}
  @Override protected void onDestroy(){if(mediaRequest!=null)mediaRequest.deny();if(fileCallback!=null)fileCallback.onReceiveValue(null);if(web!=null)web.destroy();super.onDestroy();}
}
