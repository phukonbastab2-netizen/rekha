package in.rekhaastrology.admin;

import java.util.LinkedHashSet;

/** Only permissions for visible app features. Shared with the local policy checks. */
final class PermissionPolicy {
  private PermissionPolicy() {}
  static String[] forFeature(String feature, int sdk) {
    if ("microphone".equals(feature)) return new String[]{"android.permission.RECORD_AUDIO"};
    if ("camera".equals(feature)) return new String[]{"android.permission.CAMERA"};
    if ("video-call".equals(feature)) return new String[]{"android.permission.RECORD_AUDIO","android.permission.CAMERA"};
    if ("notifications".equals(feature)) return sdk >= 33 ? new String[]{"android.permission.POST_NOTIFICATIONS"} : new String[0];
    return null;
  }
  static String permissionForResource(String resource) {
    if ("android.webkit.resource.AUDIO_CAPTURE".equals(resource)) return "android.permission.RECORD_AUDIO";
    if ("android.webkit.resource.VIDEO_CAPTURE".equals(resource)) return "android.permission.CAMERA";
    return null;
  }
  static String[] forResources(String[] resources) {
    if (resources == null || resources.length == 0) return null;
    LinkedHashSet<String> permissions = new LinkedHashSet<>();
    for (String resource : resources) {
      String permission = permissionForResource(resource);
      if (permission == null) return null;
      permissions.add(permission);
    }
    return permissions.toArray(new String[0]);
  }
  static boolean validRequestId(String id) {
    return id != null && id.matches("[A-Za-z0-9_-]{1,80}");
  }
  static boolean covers(String[] approved,String[] required) {
    if(approved==null||required==null||required.length==0)return false;
    for(String permission:required){boolean found=false;for(String allowed:approved)if(permission.equals(allowed)){found=true;break;}if(!found)return false;}
    return true;
  }
  // Android can revoke a previously granted permission or dismiss a prompt.
  // Only a matching, explicit denial in this result can identify a blocked request.
  static String resultStatus(String[] required,String[] returned,int[] results,boolean[] granted,boolean[] rationale) {
    if(required==null||returned==null||results==null||granted==null||rationale==null||granted.length!=required.length||rationale.length!=required.length)return "denied";
    String status="granted";
    for(int i=0;i<required.length;i++)if(!granted[i]){
      if(!"blocked".equals(status))status="denied";
      for(int j=0;j<returned.length&&j<results.length;j++)if(required[i].equals(returned[j])&&results[j]==-1&&!rationale[i])status="blocked";
    }
    return status;
  }
}

