package ru.rpmarchive.sync;

import net.minecraft.client.MinecraftClient;
import org.lwjgl.glfw.GLFW;

public final class ArchiveShortcut {
    private ArchiveShortcut() {}

    static boolean bindable(int key) {
        // GLFW reports physical keys independently of the selected text input layout.
        return key == GLFW.GLFW_KEY_SPACE || key == GLFW.GLFW_KEY_APOSTROPHE
                || (key >= GLFW.GLFW_KEY_COMMA && key <= GLFW.GLFW_KEY_9)
                || key == GLFW.GLFW_KEY_SEMICOLON || key == GLFW.GLFW_KEY_EQUAL
                || (key >= GLFW.GLFW_KEY_A && key <= GLFW.GLFW_KEY_RIGHT_BRACKET)
                || key == GLFW.GLFW_KEY_GRAVE_ACCENT || key == GLFW.GLFW_KEY_WORLD_1 || key == GLFW.GLFW_KEY_WORLD_2
                || (key >= GLFW.GLFW_KEY_ENTER && key <= GLFW.GLFW_KEY_END)
                || (key >= GLFW.GLFW_KEY_F1 && key <= GLFW.GLFW_KEY_F25)
                || (key >= GLFW.GLFW_KEY_KP_0 && key <= GLFW.GLFW_KEY_KP_EQUAL);
    }

    public static boolean onKey(MinecraftClient client, long window, int key, int action, int modifiers) {
        if (action != GLFW.GLFW_PRESS || window != client.getWindow().getHandle()) return false;
        if (client.currentScreen instanceof ArchiveSettingsScreen settings && settings.capturingKey()) {
            settings.chooseKey(key);
            return true;
        }
        int chord = GLFW.GLFW_MOD_SHIFT | GLFW.GLFW_MOD_ALT | GLFW.GLFW_MOD_CONTROL | GLFW.GLFW_MOD_SUPER;
        if (key != ArchiveSyncClient.settings().menuKey() || (modifiers & chord) != 0
                || client.currentScreen != null || client.getOverlay() != null || client.getNetworkHandler() == null) return false;
        client.setScreen(new ArchiveSettingsScreen(null));
        return true;
    }
}
