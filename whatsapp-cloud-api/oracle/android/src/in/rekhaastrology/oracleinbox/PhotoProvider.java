package in.rekhaastrology.oracleinbox;
import android.content.*;import android.database.Cursor;import android.database.MatrixCursor;import android.net.Uri;import android.os.ParcelFileDescriptor;import android.provider.OpenableColumns;import java.io.*;
public class PhotoProvider extends ContentProvider {
 public boolean onCreate(){return true;}
 private File file(Uri uri)throws FileNotFoundException{String n=uri.getLastPathSegment();if(n==null||!n.matches("capture-[a-f0-9-]+\\.jpg"))throw new FileNotFoundException();return new File(getContext().getCacheDir(),n);}
 public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{return ParcelFileDescriptor.open(file(uri),mode.equals("r")?ParcelFileDescriptor.MODE_READ_ONLY:ParcelFileDescriptor.MODE_CREATE|ParcelFileDescriptor.MODE_WRITE_ONLY|ParcelFileDescriptor.MODE_TRUNCATE);}
 public String getType(Uri uri){return "image/jpeg";}
 public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){try{File f=file(uri);MatrixCursor c=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});c.addRow(new Object[]{f.getName(),f.length()});return c;}catch(Exception e){return null;}}
 public Uri insert(Uri uri,ContentValues v){throw new UnsupportedOperationException();}public int delete(Uri uri,String s,String[] a){throw new UnsupportedOperationException();}public int update(Uri uri,ContentValues v,String s,String[] a){throw new UnsupportedOperationException();}
}
