package ru.rpmarchive.sync;

import com.google.common.net.HostAndPort;
import com.google.common.net.InetAddresses;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.net.IDN;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Locale;

record ArchiveConfig(boolean enabled, java.util.List<String> servers, URI endpoint, String token) {
    static final ArchiveConfig DEFAULT = new ArchiveConfig(false, java.util.List.of("play.rpmserver.com:25565"),
            URI.create("https://smi-pearl.vercel.app/api/game-items"), "");

    ArchiveConfig {
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
        return new ArchiveConfig(obj.get("enabled").getAsBoolean(), servers,
                URI.create(obj.get("endpoint").getAsString()), obj.get("token").getAsString());
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
