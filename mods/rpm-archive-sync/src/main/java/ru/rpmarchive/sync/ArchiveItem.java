package ru.rpmarchive.sync;

/** The entire item payload. No game objects or raw text components leave the client thread. */
public record ArchiveItem(String material, int customModelData, String name, Long price, String rarity, String collection) {
    public ArchiveItem { if (collection == null) collection = ""; }
}
