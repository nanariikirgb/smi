package ru.rpmarchive.sync;

import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.text.Text;
import net.minecraft.client.util.InputUtil;
import org.lwjgl.glfw.GLFW;
import net.minecraft.text.OrderedText;
import net.minecraft.text.Style;

import java.io.IOException;
import java.util.Arrays;

final class ArchiveSettingsScreen extends Screen {
    private final Screen parent;
    private final ArchiveConfig original = ArchiveSyncClient.settings();
    private boolean enabled = original.enabled();
    private String addresses = String.join(", ", original.servers());
    private String replacement = "";
    private ButtonWidget send;
    private ButtonWidget rebind;
    private int menuKey = original.menuKey();
    private boolean capturingKey;
    private String error = "";

    ArchiveSettingsScreen(Screen parent) {
        super(Text.literal("RPM Archive Sync"));
        this.parent = parent;
    }

    private Text toggleLabel() { return Text.literal("Сбор: " + (enabled ? "включён" : "выключен")); }

    @Override
    protected void init() {
        int w = Math.min(350, width - 20), x = (width - w) / 2, y = top();
        addDrawableChild(ButtonWidget.builder(toggleLabel(), button -> {
            enabled = !enabled;
            button.setMessage(toggleLabel());
        }).dimensions(x, y + 18, w, 20).build());
        var servers = new TextFieldWidget(textRenderer, x, y + 54, w, 20, Text.literal("Адреса серверов"));
        servers.setMaxLength(5000);
        servers.setText(addresses);
        servers.setChangedListener(text -> addresses = text);
        addDrawableChild(servers);
        var token = new TextFieldWidget(textRenderer, x, y + 92, w, 20, Text.literal("Токен"));
        token.setMaxLength(256);
        token.setRenderTextProvider((text, start) -> OrderedText.styledForwardsVisitedString("•".repeat(text.length()), Style.EMPTY));
        token.setText(replacement);
        token.setChangedListener(text -> replacement = text);
        addDrawableChild(token);
        send = addDrawableChild(ButtonWidget.builder(Text.literal("Отправить из кэша"), b -> {
            var queue = ArchiveSyncClient.currentQueue();
            if (queue != null) queue.sendCached();
        }).dimensions(x, y + 133, w / 2 - 2, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("Просмотреть кэш"), b -> client.setScreen(new CacheScreen(this)))
                .dimensions(x + w / 2 + 2, y + 133, w / 2 - 2, 20).build());
        rebind = addDrawableChild(ButtonWidget.builder(keyLabel(), b -> {
            capturingKey = true;
            b.setMessage(keyLabel());
        }).dimensions(x, y + 157, w, 20).build());
        tick();
        addDrawableChild(ButtonWidget.builder(Text.literal("Сохранить"), b -> save())
                .dimensions(x, y + 181, w / 2 - 2, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("Отмена"), b -> close())
                .dimensions(x + w / 2 + 2, y + 181, w / 2 - 2, 20).build());
    }

    private int top() { return Math.max(2, (height - 203) / 2); }

    private Text keyLabel() {
        if (capturingKey) return Text.literal("Нажмите клавишу (Esc — отмена)");
        var label = menuKey == GLFW.GLFW_KEY_COMMA ? Text.literal("Б / ,")
                : InputUtil.fromKeyCode(menuKey, 0).getLocalizedText();
        return Text.literal("Клавиша меню: ").append(label);
    }

    boolean capturingKey() { return capturingKey; }

    void chooseKey(int key) {
        if (key != GLFW.GLFW_KEY_ESCAPE) {
            if (!ArchiveShortcut.bindable(key)) return;
            menuKey = key;
        }
        capturingKey = false;
        rebind.setMessage(keyLabel());
    }

    @Override public void tick() {
        var queue = ArchiveSyncClient.currentQueue();
        send.active = enabled && original.enabled() && replacement.isEmpty()
                && addresses.equals(String.join(", ", original.servers())) && queue != null && !queue.sending();
    }

    private void save() {
        try {
            var servers = Arrays.stream(addresses.split(",")).map(String::strip).filter(s -> !s.isEmpty()).toList();
            var next = new ArchiveConfig(enabled, servers, original.endpoint(),
                    replacement.isEmpty() ? original.token() : replacement, menuKey);
            ArchiveSyncClient.save(next);
            close();
        } catch (IllegalArgumentException ex) {
            error = ex.getMessage();
        } catch (IOException ex) {
            error = "Не удалось сохранить конфигурацию на диск";
        }
    }

    @Override public void close() { client.setScreen(parent); }

    @Override public void render(DrawContext ctx, int mouseX, int mouseY, float delta) {
        super.render(ctx, mouseX, mouseY, delta);
        int x = (width - Math.min(350, width - 20)) / 2, y = top();
        ctx.drawCenteredTextWithShadow(textRenderer, title, width / 2, y, 0xffffff);
        ctx.drawTextWithShadow(textRenderer, "Адреса серверов через запятую", x, y + 42, 0xffffff);
        ctx.drawTextWithShadow(textRenderer, original.token().isEmpty() ? "Токен синхронизации" : "Новый токен (пусто — сохранить текущий)", x, y + 80, 0xffffff);
        var queue = ArchiveSyncClient.currentQueue();
        String hint;
        if (queue == null) hint = "Для отправки зайдите на разрешённый сервер";
        else if (!send.active && !queue.sending()) hint = "Сначала сохраните настройки";
        else hint = "В кэше: " + queue.cached() + "   " + queue.status();
        ctx.drawTextWithShadow(textRenderer, error.isEmpty() ? hint : error, x, y + 118,
                error.isEmpty() ? 0xc8c8c8 : 0xff9999);
    }
}
