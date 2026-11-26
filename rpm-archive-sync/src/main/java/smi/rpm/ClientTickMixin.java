package smi.rpm;

import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MinecraftClient.class)
abstract class ClientTickMixin {
    @Inject(method = "tick", at = @At("TAIL"))
    private void rpmArchiveSyncTick(CallbackInfo info) {
        ArchiveClient.tick((MinecraftClient) (Object) this);
    }
}
