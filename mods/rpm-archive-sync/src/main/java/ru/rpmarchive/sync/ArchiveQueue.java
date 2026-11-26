package ru.rpmarchive.sync;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public final class ArchiveQueue implements AutoCloseable {
    private static final Logger LOG = LoggerFactory.getLogger("rpm-archive-sync");
    private static final Gson JSON = new Gson();
    private static final int LIMIT = 8192;
    private static final int BATCH = 32;
    private static final int RESPONSE_LIMIT = 4096;

    private record Snapshot(int version, List<ArchiveItem> pending, List<String> confirmed) {}
    private final Path directory;
    private final URI endpoint;
    private final String token;
    private final ScheduledThreadPoolExecutor worker = new ScheduledThreadPoolExecutor(1, task -> {
        Thread thread = new Thread(task, "RPM Archive Sync");
        thread.setDaemon(true);
        return thread;
    });

    // These members belong to the worker. It serializes disk writes and acknowledgements.
    private final LinkedHashMap<String, ArchiveItem> pending = new LinkedHashMap<>();
    private final LinkedHashSet<String> confirmed = new LinkedHashSet<>();
    private FileChannel lockChannel;
    private FileLock lock;
    private boolean loaded;
    private boolean dirty;
    private HttpClient http;
    private long lastWarning;
    private long storageRetryAt;

    // Short operations under the monitor only. File and network I/O stay outside game callbacks.
    private final LinkedHashSet<ArchiveItem> incoming = new LinkedHashSet<>();
    private boolean flushScheduled;
    private boolean active;
    private volatile String status = "";
    private volatile int cached;
    private volatile boolean sending;
    private int remaining;
    private int sent;
    private boolean closed;
    private CompletableFuture<HttpResponse<byte[]>> inFlight;

    public ArchiveQueue(Path dataDir, String server, URI endpoint, String token) {
        this.directory = dataDir.resolve(digest(server + "\n" + endpoint.toASCIIString()));
        this.endpoint = endpoint;
        this.token = token;
        worker.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
        worker.execute(this::flushIncoming);
        worker.scheduleWithFixedDelay(this::flushIncoming, 60, 60, TimeUnit.SECONDS);
    }

    public synchronized void setActive(boolean value) {
        if (closed || active == value) return;
        active = value;
        if (!value && inFlight != null) inFlight.cancel(true);
    }

    public synchronized void offer(ArchiveItem item) {
        if (!active || closed || item == null) return;
        if (incoming.size() == LIMIT) return;
        if (!incoming.add(item) || flushScheduled) return;
        flushScheduled = true;
        worker.schedule(this::flushIncoming, 250, TimeUnit.MILLISECONDS);
    }

    String status() { return status; }
    int cached() { return cached; }
    boolean sending() { return sending; }

    synchronized void sendCached() {
        if (!active || closed || sending) return;
        sending = true;
        status = "Отправка…";
        worker.execute(() -> {
            if (!flushIncoming()) { finish("Не удалось открыть кэш"); return; }
            remaining = pending.size();
            sent = 0;
            if (remaining == 0) { finish("Кэш пуст"); return; }
            sendNextBatch();
        });
    }

    private void finish(String message) {
        status = message;
        sending = false;
    }

    private void sendNextBatch() {
        try {
            if (http == null) http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(6))
                    .followRedirects(HttpClient.Redirect.NEVER).build();
            var batch = pending.entrySet().stream().limit(Math.min(BATCH, remaining)).map(Map.Entry::copyOf).toList();
            String body = JSON.toJson(Map.of("items", batch.stream().map(Map.Entry::getValue).toList()));
            HttpRequest request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(15))
                    .header("Authorization", "Bearer " + token).header("Content-Type", "application/json")
                    .header("X-RPM-Submission", "manual").POST(HttpRequest.BodyPublishers.ofString(body)).build();
            synchronized (this) {
                if (!active || closed) { finish("Отправка прервана"); return; }
                inFlight = http.sendAsync(request, headers -> new BoundedBody());
                inFlight.whenComplete((response, error) -> dispatchResult(batch, response, error));
            }
        } catch (RuntimeException e) {
            finish("Ошибка соединения. Повторите отправку");
        }
    }

    private synchronized void dispatchResult(List<Map.Entry<String, ArchiveItem>> batch,
                                             HttpResponse<byte[]> response, Throwable error) {
        if (closed) return;
        worker.execute(() -> {
            synchronized (this) {
                inFlight = null;
            }
            if (error != null) {
                finish("Нет связи. Остаток сохранён в кэше");
                return;
            }
            if (response.statusCode() != 200) {
                finish("Ошибка HTTP " + response.statusCode() + ". Остаток в кэше");
                return;
            }
            if (!acknowledged(response.body(), batch.size())) {
                finish("Сайт не подтвердил приём. Остаток в кэше");
                return;
            }
            for (var entry : batch) {
                pending.remove(entry.getKey());
                confirmed.add(entry.getKey());
            }
            while (confirmed.size() > LIMIT) confirmed.remove(confirmed.iterator().next());
            dirty = true;
            sent += batch.size();
            remaining -= batch.size();
            if (!flushIncoming()) { finish("Ошибка записи кэша"); return; }
            if (remaining > 0) sendNextBatch();
            else finish("Обработано сайтом: " + sent);
        });
    }

    private static boolean acknowledged(byte[] bytes, int expected) {
        try {
            JsonObject reply = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
            return reply.get("ok").getAsJsonPrimitive().isBoolean() && reply.get("ok").getAsBoolean()
                    && reply.get("processed").getAsJsonPrimitive().isNumber()
                    && reply.get("processed").getAsBigDecimal().intValueExact() == expected;
        } catch (RuntimeException e) {
            return false;
        }
    }

    private boolean flushIncoming() {
        synchronized (this) { flushScheduled = false; }
        if (System.nanoTime() - storageRetryAt < 0) return false;
        try {
            if (!loaded) load();
            List<ArchiveItem> items;
            synchronized (this) {
                items = new ArrayList<>(incoming);
                incoming.clear();
            }
            for (ArchiveItem item : items) {
                String key = digest(JSON.toJson(item));
                if (confirmed.contains(key) || pending.containsKey(key)) continue;
                if (pending.size() == LIMIT) {
                    warn("Archive queue full. New items can be recorded when observed again after a sync.");
                    continue;
                }
                pending.put(key, item);
                dirty = true;
            }
            if (dirty) save();
            cached = pending.size();
            return true;
        } catch (IOException | RuntimeException e) {
            storageRetryAt = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            warn("Cannot read or write the archive queue. Check disk space, state.json and other running game instances.");
            return false;
        }
    }

    private void load() throws IOException {
        Files.createDirectories(directory);
        if (lockChannel == null) lockChannel = FileChannel.open(directory.resolve("state.lock"),
                StandardOpenOption.WRITE, StandardOpenOption.CREATE);
        if (lock == null) lock = lockChannel.tryLock();
        if (lock == null) throw new IOException("Queue is busy");
        Path file = directory.resolve("state.json");
        if (Files.exists(file)) {
            if (Files.size(file) > 16 * 1024 * 1024) throw new IOException("Queue too large");
            Snapshot state;
            try (BufferedReader input = Files.newBufferedReader(file)) {
                state = JSON.fromJson(input, Snapshot.class);
            }
            if (state == null || state.version != 1 || state.confirmed == null || state.pending == null
                    || state.confirmed.size() > LIMIT || state.pending.size() > LIMIT
                    || state.confirmed.stream().anyMatch(s -> s == null || s.length() != 64)
                    || state.pending.stream().anyMatch(i -> i == null || i.name() == null || i.material() == null)) {
                throw new IOException("Invalid queue");
            }
            confirmed.addAll(state.confirmed);
            for (ArchiveItem item : state.pending) {
                if (CatalogModels.contains(item.material(), item.customModelData())) pending.put(digest(JSON.toJson(item)), item);
                else dirty = true;
            }
        }
        loaded = true;
    }

    private void save() throws IOException {
        Path temporary = directory.resolve("state.tmp");
        try (BufferedWriter output = Files.newBufferedWriter(temporary)) {
            JSON.toJson(new Snapshot(1, List.copyOf(pending.values()), List.copyOf(confirmed)), output);
        }
        try (FileChannel file = FileChannel.open(temporary, StandardOpenOption.WRITE)) { file.force(true); }
        Files.move(temporary, directory.resolve("state.json"), StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE);
        dirty = false;
    }

    private void warn(String message) {
        long now = System.nanoTime();
        if (lastWarning == 0 || now - lastWarning >= TimeUnit.MINUTES.toNanos(1)) {
            lastWarning = now;
            LOG.warn(message);
        }
    }

    private static String digest(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    @Override public void close() {
        synchronized (this) {
            if (closed) return;
            closed = true;
            active = false;
            if (inFlight != null) inFlight.cancel(true);
            worker.execute(() -> {
                boolean hasIncoming;
                synchronized (this) { hasIncoming = !incoming.isEmpty(); }
                if (dirty || hasIncoming) {
                    storageRetryAt = 0;
                    flushIncoming();
                }
                try {
                    if (lockChannel != null) lockChannel.close();
                } catch (IOException e) {
                    LOG.warn("Could not close archive queue file.");
                }
            });
            worker.shutdown();
        }
        try {
            worker.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /** Limit even chunked responses before accumulating bytes in the JDK subscriber. */
    private static final class BoundedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final HttpResponse.BodySubscriber<byte[]> receiver = HttpResponse.BodySubscribers.ofByteArray();
        private Flow.Subscription subscription;
        private int remaining = RESPONSE_LIMIT;

        public CompletionStage<byte[]> getBody() { return receiver.getBody(); }
        public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            receiver.onSubscribe(subscription);
        }
        public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                if (buffer.remaining() > remaining) {
                    subscription.cancel();
                    receiver.onError(new IOException("Response too large"));
                    return;
                }
                remaining -= buffer.remaining();
            }
            receiver.onNext(buffers);
        }
        public void onError(Throwable error) { receiver.onError(error); }
        public void onComplete() { receiver.onComplete(); }
    }
}
