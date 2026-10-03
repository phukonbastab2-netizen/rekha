package in.rekhaastrology.admin;

import java.util.Arrays;

/** Run with javac/java; no emulator, user data, Android SDK or third party library required. */
public final class PermissionPolicyTest {
  private static int checks;
  private static void check(boolean valid,String description) {
    if(!valid)throw new AssertionError(description);
    checks++;
  }
  public static void main(String[] args) {
    check(Arrays.equals(PermissionPolicy.forFeature("microphone",35),new String[]{"android.permission.RECORD_AUDIO"}),"Voice button requests only microphone");
    check(Arrays.equals(PermissionPolicy.forFeature("camera",35),new String[]{"android.permission.CAMERA"}),"Photo button requests only camera");
    check(PermissionPolicy.forFeature("video-call",35).length==2,"Video call needs camera and microphone");
    check(PermissionPolicy.forFeature("notifications",32).length==0,"Older Android has no runtime notifications prompt");
    check(Arrays.equals(PermissionPolicy.forFeature("notifications",33),new String[]{"android.permission.POST_NOTIFICATIONS"}),"Android 13+ requests notification permission");
    for(String forbidden:new String[]{"everything","all","sms","gallery","contacts","files","passwords","location",null})
      check(PermissionPolicy.forFeature(forbidden,35)==null,"Unsupported categories cannot be requested");
    String audio="android.webkit.resource.AUDIO_CAPTURE",video="android.webkit.resource.VIDEO_CAPTURE";
    check(Arrays.equals(PermissionPolicy.forResources(new String[]{audio}),new String[]{"android.permission.RECORD_AUDIO"}),"Known WebView audio maps to microphone");
    check(PermissionPolicy.forResources(new String[]{audio,video}).length==2,"Known WebView capture maps to the two required permissions");
    check(PermissionPolicy.forResources(new String[]{audio,audio}).length==1,"Duplicate resources do not duplicate native prompts");
    check(PermissionPolicy.forResources(new String[]{audio,"android.webkit.resource.MIDI_SYSEX"})==null,"Unknown resource mixed with audio denies the entire request");
    check(PermissionPolicy.forResources(new String[]{"android.webkit.resource.PROTECTED_MEDIA_ID"})==null,"Protected media identity is not granted");
    check(PermissionPolicy.forResources(new String[]{"android.webkit.resource.NEW_FUTURE_PERMISSION"})==null,"Future WebView resources are denied by default");
    check(PermissionPolicy.forResources(new String[0])==null,"Empty WebView request is denied");
    check(PermissionPolicy.forResources(null)==null,"Missing WebView request is denied");
    check(PermissionPolicy.validRequestId("mic_123-abc"),"Supported callback ID");
    for(String invalid:new String[]{"",null,"<script>","a b","x".repeat(81)})
      check(!PermissionPolicy.validRequestId(invalid),"Unsafe or excessive callback ID is ignored");
    String mic="android.permission.RECORD_AUDIO",cam="android.permission.CAMERA";
    check(PermissionPolicy.covers(new String[]{mic,cam},new String[]{cam}),"Video consent covers its camera resource");
    check(!PermissionPolicy.covers(new String[]{mic},new String[]{cam}),"A completed microphone prompt cannot approve camera access");
    check(!PermissionPolicy.covers(null,new String[]{mic}),"No completed prompt supplies capture approval");
    check(!PermissionPolicy.covers(new String[]{mic},new String[0]),"Empty capture requests remain invalid");
    check("granted".equals(PermissionPolicy.resultStatus(new String[]{mic},new String[]{mic},new int[]{0},new boolean[]{true},new boolean[]{false})),"Actual Android grant completes the feature request");
    check("denied".equals(PermissionPolicy.resultStatus(new String[]{mic},new String[]{mic},new int[]{-1},new boolean[]{false},new boolean[]{true})),"First denial stays retryable when Android permits another prompt");
    check("blocked".equals(PermissionPolicy.resultStatus(new String[]{mic},new String[]{mic},new int[]{-1},new boolean[]{false},new boolean[]{false})),"Confirmed denial without rationale identifies Android blocking");
    check("denied".equals(PermissionPolicy.resultStatus(new String[]{mic},new String[0],new int[0],new boolean[]{false},new boolean[]{false})),"Dismissed or cancelled prompt never records permanent denial");
    check("denied".equals(PermissionPolicy.resultStatus(new String[]{mic},new String[]{cam},new int[]{-1},new boolean[]{false},new boolean[]{false})),"Unrelated callback cannot mark microphone permanently denied");
    check("denied".equals(PermissionPolicy.resultStatus(new String[]{mic},new String[]{mic},new int[]{0},new boolean[]{false},new boolean[]{false})),"Revoked or auto-reset permission stays retryable without a fresh denial");
    check("blocked".equals(PermissionPolicy.resultStatus(new String[]{mic,cam},new String[]{cam,mic},new int[]{-1,0},new boolean[]{true,false},new boolean[]{false,false})),"Video call requires both grants and maps reordered callback results safely");
    check("denied".equals(PermissionPolicy.resultStatus(new String[]{mic},new String[]{mic},new int[0],new boolean[]{false},new boolean[]{false})),"Truncated result cannot record permanent denial");
    System.out.println("Permission policy: "+checks+" checks passed.");
  }
}

