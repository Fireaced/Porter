package io.github.fireaced.porter;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.view.Window;
import androidx.activity.result.ActivityResult;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayDeque;
import java.util.Locale;

/**
 * Acceso de Porter a carpetas del móvil elegidas por el usuario (Storage Access Framework),
 * sin pedir permiso de "todos los archivos", y modo pantalla completa.
 */
@CapacitorPlugin(name = "PorterFiles")
public class PorterFilesPlugin extends Plugin {

    private static final String[] BOOK_EXT = { ".cbz", ".zip", ".cbr", ".rar", ".pdf" };

    private static long num(PluginCall call, String name, long def) {
        Object v = call.getData().opt(name);
        if (v instanceof Number) return ((Number) v).longValue();
        return def;
    }

    // ---------- Elegir carpeta ----------
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("Cancelado", "CANCELLED");
            return;
        }
        Uri tree = data.getData();
        ContentResolver cr = getContext().getContentResolver();
        boolean writable = true;
        try {
            cr.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception e) {
            writable = false;
            try {
                cr.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {}
        }
        JSObject r = new JSObject();
        r.put("uri", tree.toString());
        r.put("name", treeName(tree));
        r.put("writable", writable);
        call.resolve(r);
    }

    private String treeName(Uri tree) {
        try {
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            Cursor c = getContext().getContentResolver().query(doc, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null);
            if (c != null) {
                try {
                    if (c.moveToFirst()) return c.getString(0);
                } finally {
                    c.close();
                }
            }
        } catch (Exception ignored) {}
        return tree.getLastPathSegment();
    }

    // Comprueba que seguimos teniendo permiso sobre la carpeta
    @PluginMethod
    public void check(PluginCall call) {
        String uri = call.getString("uri");
        boolean ok = false;
        try {
            Uri tree = Uri.parse(uri);
            for (android.content.UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
                if (p.getUri().equals(tree) && p.isReadPermission()) ok = true;
            }
        } catch (Exception ignored) {}
        JSObject r = new JSObject();
        r.put("ok", ok);
        call.resolve(r);
    }

    // ---------- Listar los libros de una carpeta (recursivo) ----------
    @PluginMethod
    public void list(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("Falta la carpeta");
            return;
        }
        try {
            Uri tree = Uri.parse(uri);
            ContentResolver cr = getContext().getContentResolver();
            JSArray out = new JSArray();
            ArrayDeque<String[]> stack = new ArrayDeque<>();
            stack.push(new String[] { DocumentsContract.getTreeDocumentId(tree), "", "0" });
            String[] proj = new String[] {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
            };
            while (!stack.isEmpty()) {
                String[] item = stack.pop();
                int depth = Integer.parseInt(item[2]);
                Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, item[0]);
                Cursor c = cr.query(children, proj, null, null, null);
                if (c == null) continue;
                try {
                    while (c.moveToNext()) {
                        String id = c.getString(0);
                        String name = c.getString(1);
                        String mime = c.getString(2);
                        if (name == null || name.startsWith(".")) continue;
                        if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                            if (depth < 12) stack.push(new String[] { id, item[1].isEmpty() ? name : item[1] + "/" + name, String.valueOf(depth + 1) });
                            continue;
                        }
                        String lower = name.toLowerCase(Locale.ROOT);
                        boolean book = false;
                        for (String e : BOOK_EXT) if (lower.endsWith(e)) book = true;
                        if (!book) continue;
                        JSObject f = new JSObject();
                        f.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                        f.put("name", name);
                        f.put("dir", item[1]);
                        f.put("size", c.isNull(3) ? 0L : c.getLong(3));
                        f.put("mtime", c.isNull(4) ? 0L : c.getLong(4));
                        out.put(f);
                    }
                } finally {
                    c.close();
                }
            }
            JSObject r = new JSObject();
            r.put("files", out);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("No se pudo leer la carpeta: " + e.getMessage());
        }
    }

    // ---------- Leer un trozo de un archivo (devuelve base64) ----------
    @PluginMethod
    public void read(PluginCall call) {
        String uri = call.getString("uri");
        long offset = num(call, "offset", 0);
        long length = num(call, "length", 0);
        if (uri == null || length < 0 || length > 16L * 1024 * 1024) {
            call.reject("Lectura no válida");
            return;
        }
        ParcelFileDescriptor pfd = null;
        FileInputStream fis = null;
        try {
            pfd = getContext().getContentResolver().openFileDescriptor(Uri.parse(uri), "r");
            if (pfd == null) throw new Exception("no se pudo abrir");
            fis = new FileInputStream(pfd.getFileDescriptor());
            FileChannel ch = fis.getChannel();
            long size = ch.size();
            long len = Math.max(0, Math.min(length, size - offset));
            ByteBuffer buf = ByteBuffer.allocate((int) len);
            ch.position(offset);
            while (buf.hasRemaining()) {
                if (ch.read(buf) < 0) break;
            }
            byte[] bytes = new byte[buf.position()];
            buf.flip();
            buf.get(bytes);
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            r.put("size", size);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("No se pudo leer el archivo: " + e.getMessage());
        } finally {
            try { if (fis != null) fis.close(); } catch (Exception ignored) {}
            try { if (pfd != null) pfd.close(); } catch (Exception ignored) {}
        }
    }

    // ---------- Crear un archivo dentro de la carpeta (creando subcarpetas) ----------
    @PluginMethod
    public void createFile(PluginCall call) {
        String uri = call.getString("tree");
        String dir = call.getString("dir", "");
        String name = call.getString("name");
        String mime = call.getString("mime", "application/octet-stream");
        if (uri == null || name == null) {
            call.reject("Faltan datos");
            return;
        }
        try {
            Uri tree = Uri.parse(uri);
            ContentResolver cr = getContext().getContentResolver();
            String parentId = DocumentsContract.getTreeDocumentId(tree);
            if (dir != null && !dir.isEmpty()) {
                for (String seg : dir.split("/")) {
                    if (seg.isEmpty()) continue;
                    String found = findChild(cr, tree, parentId, seg, true);
                    if (found == null) {
                        Uri created = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, parentId), DocumentsContract.Document.MIME_TYPE_DIR, seg);
                        if (created == null) throw new Exception("no se pudo crear la carpeta " + seg);
                        found = DocumentsContract.getDocumentId(created);
                    }
                    parentId = found;
                }
            }
            String existing = findChild(cr, tree, parentId, name, false);
            Uri file;
            if (existing != null) {
                file = DocumentsContract.buildDocumentUriUsingTree(tree, existing);
            } else {
                file = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, parentId), mime, name);
            }
            if (file == null) throw new Exception("no se pudo crear el archivo");
            JSObject r = new JSObject();
            r.put("uri", file.toString());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("No se pudo guardar en la carpeta: " + e.getMessage());
        }
    }

    private String findChild(ContentResolver cr, Uri tree, String parentId, String name, boolean dir) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        Cursor c = cr.query(children, new String[] {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        }, null, null, null);
        if (c == null) return null;
        try {
            while (c.moveToNext()) {
                boolean isDir = DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2));
                if (name.equals(c.getString(1)) && isDir == dir) return c.getString(0);
            }
        } finally {
            c.close();
        }
        return null;
    }

    // ---------- Escribir (añadir) datos a un archivo ----------
    @PluginMethod
    public void write(PluginCall call) {
        String uri = call.getString("uri");
        String data = call.getString("data", "");
        boolean append = Boolean.TRUE.equals(call.getBoolean("append", false));
        OutputStream os = null;
        try {
            os = getContext().getContentResolver().openOutputStream(Uri.parse(uri), append ? "wa" : "wt");
            if (os == null) throw new Exception("no se pudo abrir");
            os.write(Base64.decode(data, Base64.DEFAULT));
            os.flush();
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo escribir: " + e.getMessage());
        } finally {
            try { if (os != null) os.close(); } catch (Exception ignored) {}
        }
    }

    @PluginMethod
    public void delete(PluginCall call) {
        try {
            DocumentsContract.deleteDocument(getContext().getContentResolver(), Uri.parse(call.getString("uri")));
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo borrar: " + e.getMessage());
        }
    }

    // ---------- Pantalla completa (oculta las barras del sistema) ----------
    @PluginMethod
    public void immersive(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        final Activity act = getActivity();
        act.runOnUiThread(() -> {
            try {
                Window w = act.getWindow();
                WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
                if (on) {
                    c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    c.hide(WindowInsetsCompat.Type.systemBars());
                } else {
                    c.show(WindowInsetsCompat.Type.systemBars());
                }
                JSObject r = new JSObject();
                r.put("on", on);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("No se pudo cambiar la pantalla completa: " + e.getMessage());
            }
        });
    }
}
