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
    System.out.println("Permission policy: "+checks+" checks passed.");
  }
}

