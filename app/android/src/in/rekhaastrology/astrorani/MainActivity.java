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
import org.json.JSONObject;

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
  private int permissionPromptCode;
  private String nativeRequestId;
  private String nativeFeature;
  private String[] nativePermissions;
  private boolean destroyed;
  private long lastInteraction;
  private long captureApprovalUntil;
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
    settings.setUserAgentString(settings.getUserAgentString()+" Rekha"+(OWNER?"Admin":"Astrology")+"Android/0.7.0");
    CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);WebView.setWebContentsDebuggingEnabled(false);
    web.addJavascriptInterface(new DeviceOptions(),"RekhaDevice");
    web.setWebViewClient(new WebViewClient(){
      @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap favicon){cancelPagePermissions();super.onPageStarted(view,url,favicon);}
      @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){Uri uri=request.getUrl();if(trusted(uri.toString())&&(OWNER||!uri.getPath().startsWith("/admin")))return false;if(request.isForMainFrame()&&"https".equals(uri.getScheme()))try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception ignored){}return true;}
      @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame())showOffline("Please check your connection and try again.");}
      @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error){handler.cancel();showOffline("A secure connection could not be established. Please try again later.");}
      @Override public void onPageFinished(WebView view,String url){CookieManager.getInstance().flush();if(trusted(url))MessageAlerts.checkpoint(MainActivity.this,OWNER);}
    });
    web.setWebChromeClient(new WebChromeClient(){
      @Override public void onGeolocationPermissionsShowPrompt(String origin,GeolocationPermissions.Callback callback){
        if(!trusted(origin)||!trusted(web.getUrl())||!recentInteraction()){callback.invoke(origin,false,false);return;}
        if(checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED){callback.invoke(origin,true,false);return;}
        if(permissionPromptCode!=0||locationCallback!=null){callback.invoke(origin,false,false);return;}
        locationCallback=callback;locationOrigin=origin;startPermissionPrompt(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION},49);
      }
      @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams parameters){
        if(!trusted(web.getUrl()))return false;if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;
        Intent picker=new Intent(Intent.ACTION_OPEN_DOCUMENT);picker.addCategory(Intent.CATEGORY_OPENABLE);picker.setType("*/*");ArrayList<String> types=new ArrayList<>();
        for(String type:parameters.getAcceptTypes())if(type.matches("(?:image|video|audio)/[A-Za-z0-9.+*-]+")||"application/pdf".equals(type))types.add(type);
        if(types.isEmpty()){types.add("image/*");types.add("video/*");types.add("audio/*");types.add("application/pdf");}
        picker.putExtra(Intent.EXTRA_MIME_TYPES,types.toArray(new String[0]));picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,parameters.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
        try{startActivityForResult(picker,51);}catch(Exception e){fileCallback.onReceiveValue(null);fileCallback=null;}return true;
      }
      @Override public void onPermissionRequest(PermissionRequest request){runOnUiThread(()->{
        String[] permissions=PermissionPolicy.forResources(request.getResources());
        if(destroyed||!trusted(request.getOrigin().toString())||!trusted(web.getUrl())||permissions==null||mediaRequest!=null||!recentInteraction()&&SystemClock.elapsedRealtime()>captureApprovalUntil){request.deny();return;}
        String[] missing=missingPermissions(permissions);
        if(missing.length==0){mediaRequest=request;grantMedia();return;}
        if(permissionPromptCode!=0){request.deny();return;}
        for(String permission:missing)if(blocked(permission)){request.deny();return;}
        mediaRequest=request;startPermissionPrompt(missing,50);
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
  private void grantMedia(){
    if(mediaRequest==null)return;PermissionRequest request=mediaRequest;mediaRequest=null;
    String[] permissions=PermissionPolicy.forResources(request.getResources());
    if(destroyed||!trusted(web.getUrl())||!trusted(request.getOrigin().toString())||permissions==null||missingPermissions(permissions).length!=0){request.deny();return;}
    ArrayList<String> granted=new ArrayList<>();for(String resource:request.getResources())if(PermissionPolicy.permissionForResource(resource)!=null)granted.add(resource);
    request.grant(granted.toArray(new String[0]));
  }
  private boolean recentInteraction(){return lastInteraction>0&&SystemClock.elapsedRealtime()-lastInteraction<60000;}
  @Override public void onUserInteraction(){super.onUserInteraction();lastInteraction=SystemClock.elapsedRealtime();}
  private String[] missingPermissions(String[] permissions){ArrayList<String> missing=new ArrayList<>();for(String permission:permissions)if(checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED)missing.add(permission);return missing.toArray(new String[0]);}
  private boolean blocked(String permission){return checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED&&getSharedPreferences("permissions",MODE_PRIVATE).getBoolean(permission,false)&&!shouldShowRequestPermissionRationale(permission);}
  private void startPermissionPrompt(String[] permissions,int code){
    permissionPromptCode=code;for(String permission:permissions)getSharedPreferences("permissions",MODE_PRIVATE).edit().putBoolean(permission,true).apply();
    try{requestPermissions(permissions,code);}catch(Exception ignored){permissionPromptCode=0;if(code==50)grantMedia();else if(code==54)finishFeature("denied");else if(code==49&&locationCallback!=null){locationCallback.invoke(locationOrigin,false,false);locationCallback=null;locationOrigin=null;}else if(code==52)alertsRequested=false;}
  }
  private void permissionEvent(String id,String feature,String status){
    if(destroyed||!trusted(web.getUrl()))return;
    String script="window.dispatchEvent(new CustomEvent('rekha:native-permission',{detail:{requestId:"+JSONObject.quote(id)+",feature:"+JSONObject.quote(feature)+",status:"+JSONObject.quote(status)+"}}));";
    web.evaluateJavascript(script,null);
  }
  private void finishFeature(String status){
    String id=nativeRequestId,feature=nativeFeature;nativeRequestId=null;nativeFeature=null;nativePermissions=null;
    if(id==null)return;if("granted".equals(status)){if("notifications".equals(feature))enableAlerts();else captureApprovalUntil=SystemClock.elapsedRealtime()+60000;}
    permissionEvent(id,feature,status);
  }
  private void requestFeature(String id,String feature){
    if(!PermissionPolicy.validRequestId(id)||feature==null||destroyed||!trusted(web.getUrl()))return;
    String[] permissions=PermissionPolicy.forFeature(feature,Build.VERSION.SDK_INT);
    if(permissions==null){permissionEvent(id,feature,"denied");return;}
    if(permissionPromptCode!=0||nativeRequestId!=null){permissionEvent(id,feature,"busy");return;}
    if(!recentInteraction()){permissionEvent(id,feature,"denied");return;}
    String[] missing=missingPermissions(permissions);
    if(missing.length==0){if("notifications".equals(feature)){if(!((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).areNotificationsEnabled()){permissionEvent(id,feature,"blocked");return;}enableAlerts();}else captureApprovalUntil=SystemClock.elapsedRealtime()+60000;permissionEvent(id,feature,"granted");return;}
    for(String permission:missing)if(blocked(permission)){permissionEvent(id,feature,"blocked");return;}
    nativeRequestId=id;nativeFeature=feature;nativePermissions=permissions;startPermissionPrompt(missing,54);
  }
  private void cancelPagePermissions(){
    if(mediaRequest!=null){mediaRequest.deny();mediaRequest=null;}
    if(locationCallback!=null){locationCallback.invoke(locationOrigin,false,false);locationCallback=null;locationOrigin=null;}
    nativeRequestId=null;nativeFeature=null;nativePermissions=null;alertsRequested=false;
    captureApprovalUntil=0;
  }
  private void hideFullScreen(){if(fullScreen==null)return;root.removeView(fullScreen);fullScreen=null;web.setVisibility(View.VISIBLE);if(fullScreenCallback!=null)fullScreenCallback.onCustomViewHidden();fullScreenCallback=null;}
  private void showOffline(String message){if(offline!=null)root.removeView(offline);offline=new LinearLayout(this);offline.setOrientation(LinearLayout.VERTICAL);offline.setGravity(Gravity.CENTER);offline.setPadding(36,40,36,40);offline.setBackgroundColor(Color.rgb(239,234,226));TextView title=new TextView(this);title.setText(OWNER?"Rekha Admin":"Rekha Astrology");title.setTextSize(30);title.setGravity(Gravity.CENTER);offline.addView(title);TextView text=new TextView(this);text.setText(message);text.setTextSize(16);text.setGravity(Gravity.CENTER);text.setPadding(0,28,0,28);offline.addView(text);Button retry=new Button(this);retry.setText("Try again");retry.setOnClickListener(v->{root.removeView(offline);offline=null;web.loadUrl(HOME);});offline.addView(retry);root.addView(offline,new FrameLayout.LayoutParams(-1,-1));}
  public final class DeviceOptions {
    @JavascriptInterface public int permissionBridgeVersion(){return 1;}
    @JavascriptInterface public void requestPermissionsForFeature(String requestId,String feature){runOnUiThread(()->requestFeature(requestId,feature));}
    @JavascriptInterface public void openPermissionSettings(){runOnUiThread(()->{
      if(destroyed||!trusted(web.getUrl())||!recentInteraction())return;
      try{startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())));}catch(Exception ignored){Toast.makeText(MainActivity.this,"Android settings could not be opened.",Toast.LENGTH_SHORT).show();}
    });}
    @JavascriptInterface public void saveChatExport(String text){runOnUiThread(()->{if(!trusted(web.getUrl())||text==null||text.length()>2*1024*1024)return;saveText=text.getBytes(StandardCharsets.UTF_8);saveUrl=null;chooseSave("text/plain","Rekha-chat.txt");});}
    @JavascriptInterface public void showAlertSettings(){runOnUiThread(()->{if(!trusted(web.getUrl()))return;boolean enabled=getSharedPreferences("alerts",MODE_PRIVATE).getBoolean("enabled",false);
      new AlertDialog.Builder(MainActivity.this).setTitle("Message alerts").setMessage("Optional background checks can notify you about new messages. Android runs these periodically, usually 15 minutes or longer. Open the app for live chat and calls. Message text stays out of notifications.")
        .setPositiveButton(enabled?"Turn off":"Enable",(d,w)->{if(enabled){getSharedPreferences("alerts",MODE_PRIVATE).edit().putBoolean("enabled",false).apply();((JobScheduler)getSystemService(JOB_SCHEDULER_SERVICE)).cancel(49);}else{if(permissionPromptCode!=0){Toast.makeText(MainActivity.this,"Finish the current permission request first.",Toast.LENGTH_SHORT).show();return;}alertsRequested=true;if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){if(blocked(Manifest.permission.POST_NOTIFICATIONS)){alertsRequested=false;Toast.makeText(MainActivity.this,"Notifications are turned off. You can change them from App permissions.",Toast.LENGTH_LONG).show();}else startPermissionPrompt(new String[]{Manifest.permission.POST_NOTIFICATIONS},52);}else enableAlerts();}}).setNegativeButton("Cancel",null).show();
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
  @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){
    super.onRequestPermissionsResult(code,permissions,results);if(permissionPromptCode!=code)return;permissionPromptCode=0;
    if(code==49&&locationCallback!=null){locationCallback.invoke(locationOrigin,trusted(web.getUrl())&&results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED,false);locationCallback=null;locationOrigin=null;}
    if(code==50)grantMedia();
    if(code==52){if(alertsRequested&&trusted(web.getUrl())&&results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED)enableAlerts();else alertsRequested=false;}
    if(code==54&&nativePermissions!=null){String status="granted";for(String permission:nativePermissions)if(checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED){if(results.length!=0&&blocked(permission))status="blocked";else if(!"blocked".equals(status))status="denied";}finishFeature(status);}
  }
  @Override public void onBackPressed(){if(fullScreen!=null)hideFullScreen();else if(web.canGoBack())web.goBack();else super.onBackPressed();}
  @Override protected void onPause(){CookieManager.getInstance().flush();web.onPause();super.onPause();}
  @Override protected void onResume(){super.onResume();if(web!=null){web.onResume();MessageAlerts.checkpoint(this,OWNER);}}
  @Override protected void onDestroy(){destroyed=true;cancelPagePermissions();if(fileCallback!=null)fileCallback.onReceiveValue(null);if(web!=null){web.removeJavascriptInterface("RekhaDevice");web.destroy();}super.onDestroy();}
}
