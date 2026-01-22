package com.jevon.pocket8;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Permission")
public class PermissionPlugin extends Plugin {

    @PluginMethod
    public void check(PluginCall call) {
        JSObject ret = new JSObject();
        boolean granted = true;
        
        // Android 11+ (R) requires special permission
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            granted = Environment.isExternalStorageManager();
        }
        
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void request(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                intent.addCategory("android.intent.category.DEFAULT");
                Uri uri = Uri.fromParts("package", getContext().getPackageName(), null);
                intent.setData(uri);
                getActivity().startActivity(intent);
                call.resolve();
            } catch (Exception e) {
                // Fallback
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                    getActivity().startActivity(intent);
                    call.resolve();
                } catch (Exception e2) {
                    call.reject("Failed to open permission settings", e2);
                }
            }
        } else {
            // Not needed for < Android 11
            call.resolve();
        }
    }
}
