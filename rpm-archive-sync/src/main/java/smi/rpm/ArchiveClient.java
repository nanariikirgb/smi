package smi.rpm;

import com.google.gson.Gson;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.nbt.NbtElement;
import net.minecraft.nbt.NbtList;
import net.minecraft.registry.Registries;
import net.minecraft.text.Text;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public final class ArchiveClient implements ClientModInitializer {
    static final Gson JSON = new Gson();
    static final System.Logger LOG = System.getLogger("RPM Archive Sync");
    private static final Pattern NAME = Pattern.compile("[\\p{L}\\p{M}\\p{N}\\p{P}\\p{S} ]{2,100}");
    private static final Pattern PRIVATE = Pattern.compile("[@§]|https?:|www\\.|[0-9]{7}", Pattern.CASE_INSENSITIVE);
    private static final Pattern PRICE = Pattern.compile("Стандартная цена: (?:[0-9]{1,12}|[0-9]{1,3}(?:\\.[0-9]{3}){1,3})\\$",
        Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern RARITY = Pattern.compile("\\[(?:Event|Elite|Season|Rare|Legendary)\\]", Pattern.CASE_INSENSITIVE);
    private static ArchiveClient instance;

    record Config(boolean enabled, String serverAddress, String endpoint, String token) {}
    record Item(String material, int customModelData, String name, List<String> lore) {}
    private record Slot(ItemStack stack, int fingerprint) {}

    private Config config;
    private Outbox outbox;
    private Slot[] slots = new Slot[0];
    private int ticks;

    @Override
    public void onInitializeClient() {
        Path directory = FabricLoader.getInstance().getConfigDir();
        Path file = directory.resolve("rpm-archive-sync.json");
        try {
            if (Files.notExists(file)) {
                Files.writeString(file, """
                    {
                      "enabled": false,
                      "serverAddress": "",
                      "endpoint": "https://smi-pearl.vercel.app/api/game-items",
                      "token": ""
                    }
                    """);
            }
            config = JSON.fromJson(Files.readString(file), Config.class);
            if (config == null || !config.enabled()) return;
            URI uri = URI.create(config.endpoint());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null ||
                uri.getFragment() != null || uri.getQuery() != null || config.token() == null ||
                !config.token().matches("[A-Za-z0-9_-]{32,256}") || config.serverAddress() == null ||
                config.serverAddress().isBlank()) {
                LOG.log(System.Logger.Level.WARNING, "Invalid RPM Archive Sync configuration");
                return;
            }
            outbox = new Outbox(directory, config.serverAddress().trim(), uri, config.token());
            instance = this;
        } catch (Exception e) {
            LOG.log(System.Logger.Level.WARNING, "Could not initialize RPM Archive Sync");
        }
    }

    public static void tick(MinecraftClient client) {
        if (instance != null) instance.scan(client);
    }

    private void scan(MinecraftClient client) {
        // Exclude integrated worlds, remote containers, and other multiplayer servers.
        var server = client.getCurrentServerEntry();
        if (client.player == null || client.isInSingleplayer() || server == null ||
            !config.serverAddress().trim().equalsIgnoreCase(server.address.trim())) {
            if (slots.length != 0) slots = new Slot[0];
            return;
        }
        if (++ticks % 10 != 0) return;
        var inventory = client.player.getInventory();
        if (slots.length != inventory.size()) slots = new Slot[inventory.size()];
        for (int i = 0; i < slots.length; i++) {
            ItemStack stack = inventory.getStack(i);
            NbtCompound tag = stack.getNbt();
            if (stack.isEmpty() || tag == null || !tag.contains("CustomModelData", NbtElement.INT_TYPE) ||
                tag.getInt("CustomModelData") < 0 || tag.getInt("RepairCost") > 0) {
                slots[i] = null;
                continue;
            }
            NbtCompound display = tag.getCompound("display");
            int cmd = tag.getInt("CustomModelData");
            int fingerprint = 31 * cmd + display.hashCode();
            Slot previous = slots[i];
            if (previous != null && previous.stack() == stack && previous.fingerprint() == fingerprint) continue;
            Item item = extract(stack, display, cmd);
            if (item != null && !outbox.offer(item)) continue;
            slots[i] = new Slot(stack, fingerprint);
        }
    }

    private static Item extract(ItemStack stack, NbtCompound display, int cmd) {
        var id = Registries.ITEM.getId(stack.getItem());
        if (!id.getNamespace().equals("minecraft") || !id.getPath().matches("[a-z0-9_]{1,64}")) return null;
        String name = plain(display.getString("Name"));
        if (!NAME.matcher(name).matches() || PRIVATE.matcher(name).find()) return null;
        NbtList source = display.getList("Lore", NbtElement.STRING_TYPE);
        String price = null;
        String rarity = null;
        for (int i = 0; i < Math.min(source.size(), 32); i++) {
            String line = plain(source.getString(i));
            if (PRICE.matcher(line).matches()) price = line;
            if (RARITY.matcher(line).matches()) rarity = line;
        }
        List<String> lore = new ArrayList<>(2);
        if (price != null) lore.add(price);
        if (rarity != null) lore.add(rarity);
        return new Item(id.getPath(), cmd, name, List.copyOf(lore));
    }

    private static String plain(String json) {
        if (json.isEmpty() || json.length() > 2048) return "";
        try {
            Text text = Text.Serialization.fromJson(json);
            return text == null ? "" : text.getString().replaceAll("(?i)§[0-9a-fk-orx]", "").strip();
        } catch (RuntimeException e) {
            return "";
        }
    }
}
