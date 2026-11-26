package ru.rpmarchive.sync.mixin;

import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.network.packet.s2c.play.GameJoinS2CPacket;
import net.minecraft.network.packet.s2c.play.InventoryS2CPacket;
import net.minecraft.network.packet.s2c.play.ScreenHandlerSlotUpdateS2CPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import ru.rpmarchive.sync.ArchiveSyncClient;

@Mixin(ClientPlayNetworkHandler.class)
abstract class ClientPlayNetworkHandlerMixin {
    @Inject(method = "onGameJoin", at = @At("TAIL"))
    private void rpmArchiveJoined(GameJoinS2CPacket packet, CallbackInfo ci) {
        ArchiveSyncClient.joined((ClientPlayNetworkHandler) (Object) this);
    }

    @Inject(method = "onInventory", at = @At("TAIL"))
    private void rpmArchiveInventory(InventoryS2CPacket packet, CallbackInfo ci) {
        ArchiveSyncClient.inventoryUpdated((ClientPlayNetworkHandler) (Object) this,
                packet.getSyncId(), packet.getContents().size());
    }

    @Inject(method = "onScreenHandlerSlotUpdate", at = @At("TAIL"))
    private void rpmArchiveSlot(ScreenHandlerSlotUpdateS2CPacket packet, CallbackInfo ci) {
        ArchiveSyncClient.slotUpdated((ClientPlayNetworkHandler) (Object) this,
                packet.getSyncId(), packet.getSlot());
    }
}
