package in.rekhaastrology.admin;

import android.Manifest;
import android.app.*;
import android.app.job.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.CookieManager;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

/** Opt-in periodic checks; this does not promise instant push delivery. */
public final class MessageAlerts extends JobService {
  private volatile boolean stopped;
  private static boolean checkpointRunning;
  private static long lastCheckpointAt=-60000;
  static synchronized void checkpoint(Context context,boolean owner){
    if(!context.getSharedPreferences("alerts",MODE_PRIVATE).getBoolean("enabled",false)||checkpointRunning||android.os.SystemClock.elapsedRealtime()-lastCheckpointAt<60000)return;
    checkpointRunning=true;lastCheckpointAt=android.os.SystemClock.elapsedRealtime();Context app=context.getApplicationContext();
    new Thread(()->{try{long current=latest(owner);if(current>=0)app.getSharedPreferences("alerts",MODE_PRIVATE).edit().putLong("cursor",current).apply();}catch(Exception ignored){}finally{synchronized(MessageAlerts.class){checkpointRunning=false;}}},"rekha-alert-checkpoint").start();
  }
  private static long latest(boolean owner)throws Exception{
    String origin="https://"+MainActivity.HOST,cookie=CookieManager.getInstance().getCookie(origin);if(cookie==null)return -1;
    HttpURLConnection connection=(HttpURLConnection)new URL(origin+(owner?"/api/admin/conversations":"/api/chat")).openConnection();connection.setConnectTimeout(15000);connection.setReadTimeout(15000);connection.setInstanceFollowRedirects(false);connection.setRequestProperty("Cookie",cookie);
    try{if(connection.getResponseCode()!=200)return -1;ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int count;InputStream input=connection.getInputStream();while((count=input.read(buffer))!=-1){if(output.size()+count>2*1024*1024)return -1;output.write(buffer,0,count);}String json=new String(output.toByteArray(),StandardCharsets.UTF_8);long latest=0;
      JSONArray entries=owner?new JSONArray(json):new JSONObject(json).getJSONArray("messages");for(int i=0;i<entries.length();i++){JSONObject entry=entries.getJSONObject(i);if(owner)latest=Math.max(latest,entry.optLong("latestUserMessageId",0));else if("assistant".equals(entry.optString("role")))latest=Math.max(latest,entry.optLong("id",0));}return latest;
    }finally{connection.disconnect();}
  }
  @Override public boolean onStartJob(JobParameters parameters){stopped=false;new Thread(()->{try{if(!getSharedPreferences("alerts",MODE_PRIVATE).getBoolean("enabled",false))return;long next=latest(MainActivity.OWNER),previous=getSharedPreferences("alerts",MODE_PRIVATE).getLong("cursor",-1);if(next<0||stopped)return;getSharedPreferences("alerts",MODE_PRIVATE).edit().putLong("cursor",next).apply();if(previous<0||next<=previous||Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)return;
      NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);manager.createNotificationChannel(new NotificationChannel("messages","Message alerts",NotificationManager.IMPORTANCE_DEFAULT));PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);Notification note=new Notification.Builder(this,"messages").setSmallIcon(android.R.drawable.ic_dialog_email).setContentTitle(MainActivity.OWNER?"Rekha Admin":"Rekha Astrology").setContentText(MainActivity.OWNER?"You have a new customer message.":"You have a new message from Rekha.").setContentIntent(open).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).build();manager.notify(49,note);
    }catch(Exception ignored){}finally{jobFinished(parameters,false);}},"rekha-message-alerts").start();return true;}
  @Override public boolean onStopJob(JobParameters parameters){stopped=true;return false;}
}
