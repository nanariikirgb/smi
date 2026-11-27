package ru.rpmarchive.export;

import com.google.gson.*;
import net.minecraft.nbt.*;
import java.util.TreeSet;

final class TagJson {
    static JsonObject encode(NbtElement tag) {
        JsonObject result = new JsonObject();
        result.addProperty("type", tag.getNbtType().getCrashReportName());
        if (tag instanceof NbtCompound obj) {
            JsonObject fields = new JsonObject();
            for (String key : new TreeSet<>(obj.getKeys())) fields.add(key, encode(obj.get(key)));
            result.add("value", fields);
        } else if (tag instanceof AbstractNbtList<?> list) {
            JsonArray values = new JsonArray();
            for (var child : list) values.add(encode(child));
            result.add("value", values);
        } else if (tag instanceof AbstractNbtNumber n) {
            // Decimal strings also preserve long precision and non-finite floating point values in JSON readers.
            result.addProperty("value", n.numberValue().toString());
        } else result.addProperty("value", tag.asString());
        return result;
    }
}
