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

record ArchiveConfig(String server, URI endpoint, String token) {
    private static final String TEMPLATE = """
            {
              "enabled": false,
              "server": "play.rpmserver.com:25565",
              "endpoint": "https://smi-pearl.vercel.app/api/game-items",
              "token": ""
            }
            """;

    static ArchiveConfig load(Path path) throws IOException {
        if (Files.notExists(path)) {
            Files.createDirectories(path.getParent());
            Files.writeString(path, TEMPLATE, StandardOpenOption.CREATE_NEW);
            return null;
        }
        if (Files.size(path) > 8192) throw new IllegalArgumentException("config");
        JsonObject settings = JsonParser.parseString(Files.readString(path)).getAsJsonObject();
        JsonElement enabled = settings.get("enabled");
        if (enabled == null || !enabled.isJsonPrimitive() || !enabled.getAsJsonPrimitive().isBoolean()
                || !enabled.getAsBoolean()) return null;

        String server = normalizeServer(settings.get("server").getAsString());
        String token = settings.get("token").getAsString();
        URI endpoint = URI.create(settings.get("endpoint").getAsString());
        if (server == null || !token.matches("[!-~]{32,256}") || !"https".equalsIgnoreCase(endpoint.getScheme())
                || endpoint.getHost() == null || endpoint.getRawUserInfo() != null
                || endpoint.getRawQuery() != null || endpoint.getRawFragment() != null
                || !"/api/game-items".equals(endpoint.getRawPath())) {
            throw new IllegalArgumentException("config");
        }
        return new ArchiveConfig(server, endpoint, token);
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
