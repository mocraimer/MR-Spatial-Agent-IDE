package local.spatial.workspace;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** App-private ciphertext. The non-exportable AES key stays in Android Keystore. */
public final class PairingVault {
    private static final String ALIAS = "spatial-owner-pairing-v1";
    private static AtomicFile file(Context context) {
        return new AtomicFile(new File(context.getNoBackupFilesDir(), "pairing-v1.enc"));
    }
    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build());
            generator.generateKey();
        }
        return (SecretKey)store.getKey(ALIAS, null);
    }
    public static synchronized void save(Context context, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] record = ByteBuffer.allocate(1 + iv.length + encrypted.length).put((byte)iv.length).put(iv).put(encrypted).array();
        AtomicFile output = file(context);
        FileOutputStream stream = null;
        try { stream = output.startWrite(); stream.write(record); output.finishWrite(stream); }
        catch (Exception error) { if (stream != null) output.failWrite(stream); throw error; }
    }
    public static synchronized String load(Context context) throws Exception {
        AtomicFile input = file(context);
        if (!input.getBaseFile().exists()) return null;
        byte[] record = input.readFully();
        if (record.length < 30 || record.length > 16384) throw new SecurityException("Invalid private pairing record");
        ByteBuffer buffer = ByteBuffer.wrap(record);
        int size = buffer.get() & 255;
        if (size != 12 || buffer.remaining() <= size + 16) throw new SecurityException("Invalid pairing IV");
        byte[] iv = new byte[size]; buffer.get(iv);
        byte[] encrypted = new byte[buffer.remaining()]; buffer.get(encrypted);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }
    public static synchronized void clear(Context context) throws Exception {
        file(context).delete();
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS);
    }
}
