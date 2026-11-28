package ru.rpmarchive.sync.mixin;

import net.minecraft.client.Keyboard;
import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import ru.rpmarchive.sync.ArchiveShortcut;

@Mixin(Keyboard.class)
abstract class KeyboardMixin {
    @Inject(method = "onKey", at = @At("HEAD"), cancellable = true)
    private void rpmArchiveShortcut(long window, int key, int scancode, int action, int modifiers, CallbackInfo ci) {
        if (ArchiveShortcut.onKey(MinecraftClient.getInstance(), window, key, action, modifiers)) ci.cancel();
    }
}
