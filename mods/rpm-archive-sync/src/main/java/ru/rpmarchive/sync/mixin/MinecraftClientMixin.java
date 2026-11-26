package ru.rpmarchive.sync.mixin;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import ru.rpmarchive.sync.ArchiveSyncClient;

@Mixin(MinecraftClient.class)
abstract class MinecraftClientMixin {
    @Inject(method = "disconnect(Lnet/minecraft/client/gui/screen/Screen;)V", at = @At("HEAD"))
    private void rpmArchiveDisconnect(Screen screen, CallbackInfo ci) {
        ArchiveSyncClient.disconnected();
    }

    @Inject(method = "close", at = @At("HEAD"))
    private void rpmArchiveClose(CallbackInfo ci) {
        ArchiveSyncClient.stopped();
    }
}
