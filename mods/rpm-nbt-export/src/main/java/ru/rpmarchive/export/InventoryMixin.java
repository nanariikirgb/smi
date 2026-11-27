package ru.rpmarchive.export;

import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MinecraftClient.class)
abstract class InventoryMixin {
    @Inject(method="tick", at=@At("TAIL"))
    private void rpmNbtTick(CallbackInfo ci) {
        InventoryExport.tick((MinecraftClient)(Object)this);
    }
    @Inject(method="close", at=@At("HEAD"))
    private void rpmNbtClose(CallbackInfo ci) { InventoryExport.close(); }
}
