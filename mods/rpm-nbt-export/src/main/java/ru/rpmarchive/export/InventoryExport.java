package ru.rpmarchive.export;

import java.util.HashMap;
import java.util.Map;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.CreativeInventoryScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.registry.Registries;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.Slot;

final class InventoryExport {
    private static final Archive archive = new Archive(FabricLoader.getInstance().getGameDir().resolve("rpm-nbt-export/items.json"));
    private static ScreenHandler previous;
    private static int ticks;
    private static Map<Sample, Sample> visible = Map.of();
    record Sample(String item, NbtCompound tag) {}

    static void tick(MinecraftClient client) {
        if (client.player == null || client.getCurrentServerEntry() == null || client.currentScreen instanceof CreativeInventoryScreen) {
            previous = null;
            visible = Map.of();
            return;
        }
        var screen = client.currentScreen instanceof HandledScreen<?> open ? open.getScreenHandler() : client.player.playerScreenHandler;
        if (previous == screen && ++ticks < 5) return;
        ticks = 0;
        previous = screen;
        if (!archive.allowed(client.getCurrentServerEntry().address)) return;
        Map<Sample, Sample> next = new HashMap<>();
        var inv = client.player.getInventory();
        for (int i = 0; i < inv.size(); i++) collect(inv.getStack(i), next);
        if (client.currentScreen instanceof HandledScreen<?>) {
            for (Slot slot : screen.slots) if (slot.isEnabled() && slot.inventory != inv) collect(slot.getStack(), next);
        }
        visible = next;
    }

    private static void collect(ItemStack stack, Map<Sample, Sample> next) {
        NbtCompound tag = stack.getNbt();
        if (stack.isEmpty() || tag == null || tag.isEmpty()) return;
        Sample view = new Sample(Registries.ITEM.getId(stack.getItem()).toString(), tag);
        if (next.containsKey(view)) return;
        Sample old = visible.get(view);
        if (old != null) {
            next.put(old, old);
            return;
        }
        Sample copy = new Sample(view.item(), tag.copy());
        next.put(copy, copy);
        archive.offer(copy);
    }
    static void close() { archive.close(); }
}
