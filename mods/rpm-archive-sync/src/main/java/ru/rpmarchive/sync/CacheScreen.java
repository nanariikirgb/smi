package ru.rpmarchive.sync;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.text.Text;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/** The worker publishes an immutable list from the last successful disk read/write. */
final class CacheScreen extends Screen {
    private static final int LIST_TOP = 62;
    private static final int ROW_HEIGHT = 24;
    private final Screen parent;
    private final ArchiveConfig config = ArchiveSyncClient.settings();
    private int serverIndex;
    private ArchiveQueue live;
    private CompletableFuture<List<ArchiveItem>> offline;
    private int page;
    private ButtonWidget previous;
    private ButtonWidget next;

    CacheScreen(Screen parent) {
        super(Text.literal("Кэш предметов"));
        this.parent = parent;
        ArchiveQueue active = ArchiveSyncClient.currentQueue();
        if (active != null) serverIndex = Math.max(0, config.servers().indexOf(active.server()));
    }

    @Override protected void init() {
        int buttonWidth = Math.min(96, (width - 24) / 3);
        int y = height - 25;
        previous = addDrawableChild(ButtonWidget.builder(Text.literal("← Назад"), button -> page--)
                .dimensions(width / 2 - buttonWidth * 3 / 2 - 4, y, buttonWidth, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("К настройкам"), button -> close())
                .dimensions(width / 2 - buttonWidth / 2, y, buttonWidth, 20).build());
        next = addDrawableChild(ButtonWidget.builder(Text.literal("Далее →"), button -> page++)
                .dimensions(width / 2 + buttonWidth / 2 + 4, y, buttonWidth, 20).build());
        if (config.servers().size() > 1) {
            int half = Math.min(195, width / 2 - 8);
            addDrawableChild(ButtonWidget.builder(Text.literal("‹"), b -> changeServer(-1))
                    .dimensions(width / 2 - half, 19, 24, 20).build());
            addDrawableChild(ButtonWidget.builder(Text.literal("›"), b -> changeServer(1))
                    .dimensions(width / 2 + half - 24, 19, 24, 20).build());
        }
        selectSource();
        previous.active = false;
        next.active = false;
    }

    private String selectedServer() { return config.servers().get(serverIndex); }

    private void changeServer(int step) {
        serverIndex = Math.floorMod(serverIndex + step, config.servers().size());
        page = 0;
        selectSource();
    }

    private ArchiveQueue matchingQueue() {
        var active = ArchiveSyncClient.currentQueue();
        return active != null && !config.servers().isEmpty() && selectedServer().equals(active.server()) ? active : null;
    }

    private void selectSource() {
        live = matchingQueue();
        if (offline != null) offline.cancel(false);
        offline = null;
        if (live != null || config.servers().isEmpty()) return;
        String server = selectedServer();
        var data = FabricLoader.getInstance().getGameDir().resolve("rpm-archive-sync");
        offline = CompletableFuture.supplyAsync(() -> {
            try { return ArchiveQueue.readCachedItems(data, server, config.endpoint()); }
            catch (IOException e) { throw new CompletionException(e); }
        });
    }

    @Override public void tick() {
        if (live != matchingQueue()) selectSource();
    }

    @Override public void close() { client.setScreen(parent); }

    @Override public void render(DrawContext ctx, int mouseX, int mouseY, float delta) {
        boolean failed = live != null ? live.cacheReadFailed() : offline != null && offline.isCompletedExceptionally();
        List<ArchiveItem> items = live != null ? live.cachedItems() : null;
        if (offline != null && offline.isDone()) {
            try { items = offline.join(); }
            catch (CompletionException e) { failed = true; }
        }
        int count = items == null ? 0 : items.size();
        int rows = Math.max(1, (height - LIST_TOP - 31) / ROW_HEIGHT);
        int pages = Math.max(1, (count + rows - 1) / rows);
        page = Math.max(0, Math.min(page, pages - 1));
        previous.active = page > 0;
        next.active = page + 1 < pages;
        super.render(ctx, mouseX, mouseY, delta);
        ctx.drawCenteredTextWithShadow(textRenderer, title, width / 2, 7, 0xffffff);
        if (!config.servers().isEmpty()) {
            String server = selectedServer();
            int available = Math.min(390, width - 16) - 56;
            if (textRenderer.getWidth(server) > available)
                server = textRenderer.trimToWidth(server, available - textRenderer.getWidth("…")) + "…";
            ctx.drawCenteredTextWithShadow(textRenderer, server, width / 2, 25, 0xffffff);
        }
        if (items == null || count == 0) {
            String message;
            if (config.servers().isEmpty()) message = "Добавьте адрес сервера в настройках";
            else if (failed) message = "Не удалось прочитать кэш";
            else if (items == null) message = "Загрузка кэша…";
            else message = "Нет записей для отправки";
            ctx.drawCenteredTextWithShadow(textRenderer, message, width / 2, LIST_TOP, 0xc8c8c8);
            return;
        }

        String caption = "В очереди: " + count + "    Страница " + (page + 1) + " / " + pages;
        ctx.drawCenteredTextWithShadow(textRenderer, caption, width / 2, 46, 0xc8c8c8);
        int panelWidth = Math.min(390, width - 16);
        int left = (width - panelWidth) / 2;
        String tooltip = null;
        for (int i = 0; i < rows && page * rows + i < count; i++) {
            ArchiveItem item = items.get(page * rows + i);
            int y = LIST_TOP + i * ROW_HEIGHT;
            String name = item.name().isBlank() ? "Без названия" : item.name();
            String shown = name;
            if (textRenderer.getWidth(name) > panelWidth - 8) {
                shown = textRenderer.trimToWidth(name, panelWidth - 8 - textRenderer.getWidth("…")) + "…";
                if (mouseX >= left && mouseX < left + panelWidth && mouseY >= y && mouseY < y + ROW_HEIGHT) tooltip = name;
            }
            ctx.fill(left, y, left + panelWidth, y + ROW_HEIGHT - 1, 0x66000000);
            ctx.drawTextWithShadow(textRenderer, shown, left + 4, y + 2, 0xffffff);
            ctx.drawTextWithShadow(textRenderer, item.material() + " · CMD " + item.customModelData(), left + 4, y + 12, 0xb0b0b0);
        }
        if (tooltip != null) ctx.drawOrderedTooltip(textRenderer,
                textRenderer.wrapLines(Text.literal(tooltip), Math.max(80, width - 48)), mouseX, mouseY);
    }
}
