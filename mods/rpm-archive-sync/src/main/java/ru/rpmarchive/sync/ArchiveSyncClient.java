package ru.rpmarchive.sync;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.CreativeInventoryScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ServerInfo;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.PlayerScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.Slot;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;

public final class ArchiveSyncClient implements ClientModInitializer {
    private static final Logger LOG = LoggerFactory.getLogger("rpm-archive-sync");
    private static ArchiveConfig config = ArchiveConfig.DEFAULT;
    private static ArchiveQueue queue;
    private static ClientPlayNetworkHandler activeHandler;

    @Override
    public void onInitializeClient() {
        FabricLoader loader = FabricLoader.getInstance();
        try {
            config = ArchiveConfig.load(loader.getConfigDir().resolve("rpm-archive-sync.json"));
        } catch (IOException | RuntimeException ex) {
            // Parser and network exceptions can contain the input, including the token.
            LOG.warn("RPM Archive Sync disabled. Check config/rpm-archive-sync.json and directory permissions.");
        }
    }

    static ArchiveQueue currentQueue() { return activeHandler == null ? null : queue; }

    static ArchiveConfig settings() { return config; }

    static void save(ArchiveConfig next) throws IOException {
        next.save(FabricLoader.getInstance().getConfigDir().resolve("rpm-archive-sync.json"));
        boolean reconnect = next.enabled() != config.enabled() || !next.servers().equals(config.servers())
                || !next.token().equals(config.token()) || !next.endpoint().equals(config.endpoint());
        config = next;
        if (reconnect) joined(MinecraftClient.getInstance().getNetworkHandler());
    }

    public static void joined(ClientPlayNetworkHandler handler) {
        disconnected();
        if (queue != null) { queue.close(); queue = null; }
        MinecraftClient client = MinecraftClient.getInstance();
        if (!config.enabled() || handler == null || handler != client.getNetworkHandler() || client.isInSingleplayer()) return;
        ServerInfo info = handler.getServerInfo();
        String host = info == null ? null : ArchiveConfig.normalizeServer(info.address);
        if (host == null || !config.servers().contains(host)) return;
        queue = new ArchiveQueue(FabricLoader.getInstance().getGameDir().resolve("rpm-archive-sync"),
                host, config.endpoint(), config.token());
        activeHandler = handler;
        queue.setActive(true);
        if (client.player != null && !(client.currentScreen instanceof CreativeInventoryScreen)) {
            PlayerInventory inventory = client.player.getInventory();
            for (int slot = 0; slot < inventory.size(); slot++) observe(inventory.getStack(slot));
            if (client.currentScreen instanceof HandledScreen<?> screen) {
                ScreenHandler open = screen.getScreenHandler();
                if (open == client.player.currentScreenHandler) inventoryUpdated(handler, open.syncId, open.slots.size());
            }
        }
    }

    public static void disconnected() {
        activeHandler = null;
        if (queue != null) queue.setActive(false);
    }

    public static void stopped() {
        disconnected();
        if (queue != null) queue.close();
        queue = null;
    }

    // Vanilla has already applied the update. Read the resulting inventory, never the packet stack.
    public static void inventoryUpdated(ClientPlayNetworkHandler source, int syncId, int count) {
        if (source != activeHandler) return;
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || client.currentScreen instanceof CreativeInventoryScreen) return;
        ScreenHandler handler = readableHandler(client, syncId);
        if (handler == null) return;
        int end = Math.min(count, handler.slots.size());
        for (int i = 0; i < end; i++) observeSlot(handler, i);
    }

    public static void slotUpdated(ClientPlayNetworkHandler source, int syncId, int slot) {
        if (source != activeHandler || slot < 0) return;
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || client.currentScreen instanceof CreativeInventoryScreen) return;
        if (syncId == -2) {
            PlayerInventory inventory = client.player.getInventory();
            if (slot < inventory.size()) observe(inventory.getStack(slot));
            return;
        }
        if (syncId == 0 && client.player.currentScreenHandler != client.player.playerScreenHandler
                && !PlayerScreenHandler.isInHotbar(slot)) return;
        ScreenHandler handler = readableHandler(client, syncId);
        if (handler != null && slot < handler.slots.size()) observeSlot(handler, slot);
    }

    private static ScreenHandler readableHandler(MinecraftClient client, int syncId) {
        if (syncId == 0) return client.player.playerScreenHandler;
        ScreenHandler current = client.player.currentScreenHandler;
        if (current.syncId == syncId && client.currentScreen instanceof HandledScreen<?> screen
                && screen.getScreenHandler() == current) return current;
        return null;
    }

    private static void observeSlot(ScreenHandler handler, int index) {
        Slot slot = handler.getSlot(index);
        if (slot.isEnabled()) observe(slot.getStack());
    }

    private static void observe(ItemStack stack) {
        ArchiveItem item = ItemReader.read(stack);
        if (item != null) queue.offer(item);
    }
}
