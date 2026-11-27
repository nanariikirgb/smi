package ru.rpmarchive.export;

import com.google.gson.*;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import net.minecraft.client.network.ServerAddress;
import org.slf4j.LoggerFactory;

final class Archive {
    private static final Gson JSON = new GsonBuilder().disableHtmlEscaping().create();
    private static final org.slf4j.Logger LOG = LoggerFactory.getLogger("rpm-nbt-export");
    private final Path file;
    private final Set<String> servers = new HashSet<>();
    private final Set<InventoryExport.Sample> pending = new LinkedHashSet<>();
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "RPM local NBT writer");
        thread.setDaemon(true);
        return thread;
    });
    private boolean scheduled;

    Archive(Path file) {
        this.file = file;
        try {
            Files.createDirectories(file.getParent());
            Path config = file.resolveSibling("servers.txt");
            if (Files.notExists(config)) Files.writeString(config, "play.rpmserver.com:25565\n", StandardOpenOption.CREATE_NEW);
            for (String line : Files.readAllLines(config)) {
                String address = line.strip();
                if (!address.isEmpty() && ServerAddress.isValid(address)) servers.add(normalize(address));
            }
        } catch (IOException e) { LOG.error("Cannot load rpm-nbt-export/servers.txt"); }
    }

    private static String normalize(String address) {
        var parsed = ServerAddress.parse(address);
        return parsed.getAddress().toLowerCase(Locale.ROOT) + ":" + parsed.getPort();
    }
    boolean allowed(String address) { return servers.contains(normalize(address)); }

    synchronized void offer(InventoryExport.Sample sample) {
        pending.add(sample);
        if (!scheduled) {
            scheduled = true;
            worker.schedule(this::flush, 300, TimeUnit.MILLISECONDS);
        }
    }

    private void flush() {
        Set<InventoryExport.Sample> batch;
        synchronized (this) { batch = new LinkedHashSet<>(pending); }
        boolean saved = false;
        try {
            if (!batch.isEmpty()) merge(batch);
            saved = true;
        } catch (IOException | RuntimeException e) {
            LOG.warn("Cannot update rpm-nbt-export/items.json. Check the JSON and directory permissions.");
        }
        synchronized (this) {
            if (saved) pending.removeAll(batch);
            scheduled = !pending.isEmpty() && !worker.isShutdown();
            if (scheduled) worker.schedule(this::flush, saved ? 1 : 5, TimeUnit.SECONDS);
        }
    }

    private void merge(Set<InventoryExport.Sample> batch) throws IOException {
        Path lockFile = file.resolveSibling("items.lock");
        try (var channel = FileChannel.open(lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
             var lock = channel.lock()) {
            JsonArray entries = new JsonArray();
            if (Files.exists(file)) {
                try (Reader reader = Files.newBufferedReader(file)) {
                    entries = JsonParser.parseReader(reader).getAsJsonArray();
                }
            }
            Set<JsonElement> known = new HashSet<>();
            for (var row : entries) known.add(row);
            int oldSize = entries.size();
            for (var sample : batch) {
                JsonObject row = new JsonObject();
                row.addProperty("item", sample.item());
                row.add("nbt", TagJson.encode(sample.tag()));
                if (known.add(row)) entries.add(row);
            }
            if (oldSize == entries.size()) return;
            Path temp = Files.createTempFile(file.getParent(), "items-", ".tmp");
            try {
                try (var out = Files.newBufferedWriter(temp, StandardCharsets.UTF_8)) {
                    JSON.toJson(entries, out);
                }
                Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } finally { Files.deleteIfExists(temp); }
        }
    }

    void close() {
        worker.execute(this::flush);
        worker.shutdown();
        try { worker.awaitTermination(10, TimeUnit.SECONDS); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
