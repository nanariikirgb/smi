package smi.rpm;

import smi.rpm.ArchiveClient.Item;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

final class Outbox {
    private static final int PENDING_LIMIT = 4096;
    private static final int CACHE_LIMIT = 8192;
    private static final int BATCH_SIZE = 50;
    private static final long INTERVAL = TimeUnit.SECONDS.toNanos(60);

    private record State(List<Item> pending, List<String> known) {}
    private record Batch(List<Item> items) {}

    private final Path path;
    private final URI endpoint;
    private final String token;
    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(8)).followRedirects(HttpClient.Redirect.NEVER).build();
    private final LinkedHashMap<String, Item> pending = new LinkedHashMap<>();
    private final LinkedHashMap<String, Boolean> known = new LinkedHashMap<>();
    private boolean ready;
    private long revision;
    private long savedRevision;
    private long lastAttempt = System.nanoTime();
    private boolean warned;

    Outbox(Path directory, String server, URI endpoint, String token) {
        this.endpoint = endpoint;
        this.token = token;
        try {
            var hash = MessageDigest.getInstance("SHA-256").digest(
                (server.toLowerCase(Locale.ROOT) + "\n" + endpoint).getBytes(StandardCharsets.UTF_8));
            path = directory.resolve("rpm-archive-outbox-" + HexFormat.of().formatHex(hash) + ".json");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        var worker = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "RPM Archive Sync");
            thread.setDaemon(true);
            return thread;
        });
        worker.scheduleWithFixedDelay(this::run, 0, 1, TimeUnit.SECONDS);
    }

    private static String key(Item item) {
        return item.material() + ":" + item.customModelData() + "\n" + item.name().toLowerCase(Locale.ROOT);
    }

    synchronized boolean offer(Item item) {
        if (!ready) return false;
        String key = key(item);
        if (known.containsKey(key) || pending.containsKey(key)) return true;
        if (pending.size() >= PENDING_LIMIT) return false;
        pending.put(key, item);
        revision++;
        return true;
    }

    private void restore() throws IOException {
        State state = null;
        if (Files.exists(path)) {
            if (Files.size(path) > 8_000_000) throw new IOException("Queue exceeds size limit");
            state = ArchiveClient.JSON.fromJson(Files.readString(path), State.class);
            if (state == null || state.pending() == null || state.known() == null) throw new IOException("Invalid queue");
        }
        synchronized (this) {
            if (state != null) {
                for (Item item : state.pending().stream().limit(PENDING_LIMIT).toList()) pending.put(key(item), item);
                for (String id : state.known().stream().limit(CACHE_LIMIT).toList()) known.put(id, true);
            }
            ready = true;
        }
    }

    private void save() throws IOException {
        State snapshot;
        long version;
        synchronized (this) {
            if (savedRevision == revision) return;
            version = revision;
            snapshot = new State(new ArrayList<>(pending.values()), new ArrayList<>(known.keySet()));
        }
        Path temporary = path.resolveSibling(path.getFileName() + ".tmp");
        Files.writeString(temporary, ArchiveClient.JSON.toJson(snapshot));
        try {
            Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
        }
        savedRevision = version;
    }

    private void run() {
        try {
            if (!ready) restore();
            save();
            List<Item> batch;
            synchronized (this) {
                long now = System.nanoTime();
                if (pending.isEmpty() || now - lastAttempt < INTERVAL) return;
                lastAttempt = now;
                batch = pending.values().stream().limit(BATCH_SIZE).toList();
            }
            HttpRequest request = HttpRequest.newBuilder(endpoint)
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(ArchiveClient.JSON.toJson(new Batch(batch))))
                .build();
            var response = http.send(request, HttpResponse.BodyHandlers.discarding());
            if (response.statusCode() != 200 || !response.headers().firstValue("X-RPM-Archive-Sync").orElse("").equals("1")) {
                throw new IOException("Unconfirmed batch");
            }
            synchronized (this) {
                for (Item item : batch) {
                    String key = key(item);
                    pending.remove(key);
                    known.put(key, true);
                }
                while (known.size() > CACHE_LIMIT) known.remove(known.keySet().iterator().next());
                revision++;
            }
            save();
            warned = false;
        } catch (IOException | RuntimeException e) {
            if (!warned) {
                ArchiveClient.LOG.log(System.Logger.Level.WARNING, "RPM Archive Sync will retry; check the API and local queue");
                warned = true;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
