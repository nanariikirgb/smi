package ru.rpmarchive.sync;

import com.google.common.net.HostAndPort;
import com.google.common.net.InetAddresses;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.net.IDN;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

record ArchiveConfig(boolean enabled, List<String> servers, URI endpoint, String token, int menuKey) {
    private static final String LEGACY_SERVER = "play.rpmserver.com:25565";
    static final ArchiveConfig DEFAULT = new ArchiveConfig(false, List.of("mc.rpmserver.com:25565",
            "fix.rpmserver.ru:25565", "ru.rpmserver.ru:25565"),
            URI.create("https://smi-pearl.vercel.app/api/game-items"), bundledToken(), org.lwjgl.glfw.GLFW.GLFW_KEY_COMMA);

    private static String bundledToken() {
        try (InputStream in = ArchiveConfig.class.getResourceAsStream("/rpm-archive-default-token.txt")) {
            if (in == null) return "";
            String token = new String(in.readAllBytes(), StandardCharsets.US_ASCII).strip();
            return token.matches("[!-~]{32,256}") ? token : "";
        } catch (IOException ex) {
            return "";
        }
    }

    ArchiveConfig {
        if (!ArchiveShortcut.bindable(menuKey)) throw new IllegalArgumentException("Выберите клавишу для открытия меню");
        var unique = new java.util.LinkedHashSet<String>();
        for (String entry : servers) {
            String host = normalizeServer(entry);
            if (host == null) throw new IllegalArgumentException("Проверьте адрес и порт сервера");
            unique.add(host);
        }
        servers = java.util.List.copyOf(unique);
        if (servers.size() > 16 || (enabled && servers.isEmpty()))
            throw new IllegalArgumentException("Укажите от 1 до 16 серверов для сбора");
        if (!(token.isEmpty() && !enabled) && !token.matches("[!-~]{32,256}"))
            throw new IllegalArgumentException("Токен: 32–256 символов ASCII без пробелов");
        if (!"https".equalsIgnoreCase(endpoint.getScheme()) || endpoint.getHost() == null
                || endpoint.getRawUserInfo() != null || endpoint.getRawQuery() != null
                || endpoint.getRawFragment() != null || !"/api/game-items".equals(endpoint.getRawPath()))
            throw new IllegalArgumentException("Проверьте HTTPS-адрес API");
    }

    static ArchiveConfig load(Path path) throws IOException {
        if (Files.notExists(path)) {
            DEFAULT.save(path);
            return DEFAULT;
        }
        if (Files.size(path) > 16384) throw new IOException("config");
        JsonObject obj = JsonParser.parseString(Files.readString(path)).getAsJsonObject();
        var servers = new java.util.ArrayList<String>();
        if (obj.has("servers")) obj.getAsJsonArray("servers").forEach(v -> servers.add(v.getAsString()));
        else servers.add(obj.get("server").getAsString());
        boolean legacy = !obj.has("menuKey");
        if (legacy && servers.size() == 1 && LEGACY_SERVER.equals(normalizeServer(servers.get(0)))) {
            servers.addAll(DEFAULT.servers());
        }
        URI endpoint = URI.create(obj.get("endpoint").getAsString());
        String token = obj.has("token") ? obj.get("token").getAsString() : "";
        if (token.isEmpty() && DEFAULT.endpoint().equals(endpoint)) token = DEFAULT.token();
        int menuKey = legacy ? DEFAULT.menuKey() : obj.get("menuKey").getAsInt();
        ArchiveConfig config = new ArchiveConfig(obj.get("enabled").getAsBoolean(), servers, endpoint, token, menuKey);
        if (legacy) config.save(path);
        return config;
    }

    void save(Path path) throws IOException {
        Files.createDirectories(path.getParent());
        Path tmp = Files.createTempFile(path.getParent(), "rpm-settings-", ".tmp");
        try {
            Files.writeString(tmp, new com.google.gson.GsonBuilder().setPrettyPrinting().create().toJson(this));
            try {
                Files.move(tmp, path, java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            } catch (java.nio.file.AtomicMoveNotSupportedException ex) {
                Files.move(tmp, path, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
        } finally { Files.deleteIfExists(tmp); }
    }

    // Compare the address selected in the multiplayer screen. No IP lookup or suffix matching.
    static String normalizeServer(String input) {
        if (input == null || input.isBlank() || input.length() > 300) return null;
        try {
            HostAndPort parsed = HostAndPort.fromString(input.strip()).withDefaultPort(25565);
            String host = parsed.getHost();
            if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
            if (host.isEmpty() || parsed.getPort() == 0) return null;
            if (host.contains(":")) {
                host = InetAddresses.toAddrString(InetAddresses.forString(host));
            } else {
                host = IDN.toASCII(host, IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
            }
            return HostAndPort.fromParts(host, parsed.getPort()).toString();
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }
}
