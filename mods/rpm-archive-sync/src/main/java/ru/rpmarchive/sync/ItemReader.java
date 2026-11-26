package ru.rpmarchive.sync;

import com.google.gson.*;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.*;
import net.minecraft.registry.Registries;
import java.util.Set;
import java.util.regex.*;

final class ItemReader {
    private static final Set<String> RARITIES = Set.of("Event","Rare","Uncommon","Epic","RPMPass","Common","Legendary","Season","Secret","Limited","Ultra","Collab","Collection");
    private static final Pattern PRICE = Pattern.compile("(?iu)^(?:стандартная )?цена\\s*:\\s*([0-9]{1,13}|[0-9]{1,3}(?:[ .,_\\u00a0][0-9]{3}){1,4})\\s*\\$?$");
    private static final Pattern COLLECTION = Pattern.compile("(?iu)^коллекция(?:\\s*[:—-]\\s*|\\s+)[«\"“]?([^«»\"“”]+?)[»\"”]?$");
    private static final Pattern COLLECTION_LABEL = Pattern.compile("[\\p{L}\\p{M}\\p{N} ☠&'’_-]{1,64}");
    static String collectionLabel(String line) {
        Matcher match = COLLECTION.matcher(line);
        if (!match.matches()) return "";
        String label = match.group(1).strip();
        return !label.isEmpty() && COLLECTION_LABEL.matcher(label).matches() && !PRIVATE.matcher(label).find() ? label : "";
    }
    private static final Pattern PRIVATE = Pattern.compile("(?iu)[\\p{C}§@]|https?://|www\\.|discord\\.gg|t\\.me/|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|\\d{7,}|(?:владелец|владелица|игрок|ник|owner|player)\\s*[:=]");
    private static final Pattern FORMAT = Pattern.compile("(?i)§[0-9a-fklmnorx]");
    private static final Set<String> LITERAL_FIELDS = Set.of("text", "extra", "color", "bold", "italic",
            "underlined", "strikethrough", "obfuscated", "font");
    private static final class Literal {
        final StringBuilder value = new StringBuilder();
        boolean styled;
        void append(JsonElement part, int depth) {
            if (depth > 12 || value.length() > 256) throw new IllegalArgumentException();
            if (part.isJsonArray()) {
                for (JsonElement child : part.getAsJsonArray()) append(child, depth + 1);
            } else if (part.isJsonPrimitive() && part.getAsJsonPrimitive().isString()) {
                value.append(part.getAsString());
            } else {
                JsonObject obj = part.getAsJsonObject();
                for (String key : obj.keySet()) {
                    if (!LITERAL_FIELDS.contains(key))
                        throw new IllegalArgumentException();
                }
                styled |= obj.has("color") || obj.has("font") || (obj.has("bold") && obj.get("bold").getAsBoolean())
                        || (obj.has("italic") && !obj.get("italic").getAsBoolean());
                if (obj.has("text")) append(obj.get("text"), depth + 1);
                if (obj.has("extra")) append(obj.get("extra"), depth + 1);
            }
        }
    }
    private static String literal(String json, boolean requireStyle) {
        if (json.length() > 2048) return "";
        try {
            Literal text = new Literal();
            text.append(JsonParser.parseString(json), 0);
            String raw = text.value.toString();
            if (requireStyle && !text.styled && !FORMAT.matcher(raw).find()) return "";
            return FORMAT.matcher(raw).replaceAll("").strip();
        } catch (RuntimeException ignored) {
            return "";
        }
    }
    static ArchiveItem read(ItemStack stack) {
        NbtCompound tag = stack.getNbt();
        if (stack.getItem() instanceof net.minecraft.item.BlockItem || stack.isEmpty() || tag == null || !tag.contains("CustomModelData", NbtElement.NUMBER_TYPE)) return null;
        var id = Registries.ITEM.getId(stack.getItem());
        int cmd = tag.getInt("CustomModelData");
        if (tag.getDouble("CustomModelData") != cmd || !id.getNamespace().equals("minecraft")
                || !CatalogModels.contains(id.getPath(), cmd)) return null;
        NbtCompound display = tag.getCompound("display");
        String name = literal(display.getString("Name"), true);
        if (name.length() < 2 || name.length() > 100 || PRIVATE.matcher(name).find()) name = "";
        Long price = null;
        String rarity = "";
        String collection = "";
        NbtList lore = display.getList("Lore", NbtElement.STRING_TYPE);
        for (int i = 0; i < Math.min(lore.size(), 64); i++) {
            String line = literal(lore.getString(i), false).replaceFirst("^❙\\s*", "");
            if (collection.isEmpty()) collection = collectionLabel(line);
            Matcher match = PRICE.matcher(line);
            if (match.matches()) {
                long n = Long.parseLong(match.group(1).replaceAll("[^0-9]", ""));
                if (n <= 1000000000000L) price = n;
            }
            if (line.startsWith("[") && line.endsWith("]") && line.length() > 2) {
                String label = line.substring(1, line.length()-1);
                if (RARITIES.contains(label)) rarity = label;
            }
        }
        if (name.isEmpty() && price == null && collection.isEmpty() && rarity.isEmpty()) return null;
        return new ArchiveItem(id.getPath(), cmd, name, price, rarity, collection);
    }
}
