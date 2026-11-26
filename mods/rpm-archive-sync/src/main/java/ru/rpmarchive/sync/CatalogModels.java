package ru.rpmarchive.sync;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;

final class CatalogModels {
    private static final Map<String, Set<Integer>> MODELS = load();

    private static Map<String, Set<Integer>> load() {
        try (var reader = new InputStreamReader(CatalogModels.class.getResourceAsStream("/rpm-model-index.json"),
                StandardCharsets.UTF_8)) {
            return new Gson().fromJson(reader, new TypeToken<Map<String, Set<Integer>>>() {}.getType());
        } catch (java.io.IOException e) {
            throw new IllegalStateException("Cannot load RPM model index", e);
        }
    }

    static boolean contains(String material, int cmd) {
        var ids = MODELS.get(material);
        return ids != null && ids.contains(cmd);
    }
}
