package de.cjbey.timetracker

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.wm.WindowManager
import com.intellij.util.Alarm
import git4idea.repo.GitRepositoryManager
import java.awt.AWTEvent
import java.awt.Toolkit
import java.awt.event.AWTEventListener
import java.awt.event.KeyEvent
import java.math.BigDecimal
import java.math.RoundingMode
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.WeekFields
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

@Service(Service.Level.PROJECT)
@State(name = "DevelopmentTimeTracker", storages = [Storage("development-time-tracker.xml")])
class TimeTrackerService(private val project: Project) : PersistentStateComponent<TimeTrackerState>, Disposable {
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val sessions = mutableListOf<TrackedSession>()
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private val syncInProgress = AtomicBoolean(false)
    private var activeSessionId: String? = null
    private var activeSessionStartedAt: Instant? = null
    private var activeSegmentStartedAt: Instant? = null
    private var activeAccumulatedMillis = 0L
    private var activeContext: TrackingContext? = null
    private var activeCharacters = 0L
    private var activeWrittenLines = mutableSetOf<String>()
    private var lastActivityAt = Instant.now()
    private var windowInactiveSince: Instant? = null
    private var hasObservedActiveWindow = false
    private var lastPhysicalTypingAt = Instant.EPOCH
    private var lastSyncAttempt = Instant.EPOCH
    var syncStatus: SyncStatus = SyncStatus.PENDING
        private set

    private val documentListener = object : DocumentListener {
        override fun documentChanged(event: DocumentEvent) {
            recordDocumentChange(event)
        }
    }
    private val activityListener = AWTEventListener { event ->
        if (event is KeyEvent && event.id == KeyEvent.KEY_TYPED) lastPhysicalTypingAt = Instant.now()
        lastActivityAt = Instant.now()
        updateTrackingState()
    }

    val isRunning: Boolean get() = activeSegmentStartedAt != null
    private val hasSession: Boolean get() = activeSessionId != null
    val currentSessionElapsed: Duration get() = Duration.ofMillis(activeAccumulatedMillis + (activeSegmentStartedAt?.let { Duration.between(it, Instant.now()).toMillis() } ?: 0L))
    val elapsed: Duration get() = durationOf(allSessionsIncludingActive())
    val currentWeekElapsed: Duration get() {
        val (start, end) = currentWeekBounds()
        return durationOf(allSessionsIncludingActive(), start, end)
    }
    val currentWeekValue: BigDecimal get() = BigDecimal.valueOf(currentWeekElapsed.toMillis())
        .multiply(HOURLY_RATE).divide(MILLIS_PER_HOUR, 2, RoundingMode.HALF_UP)
    val currentWeekCharacters: Long get() = sessionsInCurrentWeek().sumOf { it.charactersWritten }
    val currentWeekWrittenLines: Long get() = sessionsInCurrentWeek().sumOf { it.nonEmptyLinesWritten }
    val currentContext: TrackingContext get() = resolveTrackingContext()
    val currentWeekBreakdown: List<TrackingBreakdown> get() {
        val (start, end) = currentWeekBounds()
        return allSessionsIncludingActive().groupBy { Triple(it.projectName, it.projectPath, it.branchName) }
            .mapNotNull { (key, grouped) ->
                val duration = durationOf(grouped, start, end)
                if (duration.isZero) null else TrackingBreakdown(key.first, key.second, key.third, duration)
            }.sortedWith(compareBy<TrackingBreakdown> { it.projectName }.thenBy { it.branchName })
    }
    val currentWeekLabel: String get() {
        val today = LocalDate.now()
        return "KW ${today.get(WeekFields.ISO.weekOfWeekBasedYear())} / ${today.get(WeekFields.ISO.weekBasedYear())}"
    }
    val status: TrackingStatus get() = when {
        isRunning -> TrackingStatus.TRACKING
        !isProjectWindowActive() -> TrackingStatus.WINDOW_INACTIVE
        hasSession -> TrackingStatus.IDLE
        else -> TrackingStatus.STARTING
    }

    init {
        Toolkit.getDefaultToolkit().addAWTEventListener(activityListener, ACTIVITY_EVENT_MASK)
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(documentListener, this)
        scheduleTick()
    }

    fun syncNow() {
        if (syncInProgress.getAndSet(true)) return
        lastSyncAttempt = Instant.now()
        val snapshot = allSessionsIncludingActive()
        val settings = TimeTrackerSettings.getInstance(project)
        ApplicationManager.getApplication().executeOnPooledThread {
            val success = runCatching {
                val apiKey = settings.getApiKey()
                require(settings.serverUrl.isNotBlank() && apiKey.isNotBlank())
                val request = HttpRequest.newBuilder(URI.create(settings.serverUrl.trimEnd('/') + "/api/sessions"))
                    .timeout(Duration.ofSeconds(10))
                    .header("Authorization", "Bearer $apiKey")
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(sessionsJson(snapshot)))
                    .build()
                HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.discarding()).statusCode() in 200..299
            }.getOrDefault(false)
            ApplicationManager.getApplication().invokeLater {
                syncInProgress.set(false)
                syncStatus = if (success) SyncStatus.SYNCED else SyncStatus.PENDING
                notifyListeners()
            }
        }
    }

    fun addListener(listener: () -> Unit) { listeners += listener; listener() }
    fun removeListener(listener: () -> Unit) { listeners -= listener }

    override fun getState() = TimeTrackerState().also { state ->
        state.sessions = allSessionsIncludingActive().map { it.toState() }.toMutableList()
        state.manuallyPaused = false
    }

    override fun loadState(state: TimeTrackerState) {
        val fallback = resolveTrackingContext()
        sessions.clear()
        sessions += state.sessions.mapNotNull { it.toSession(fallback) }
        if (sessions.isEmpty() && state.accumulatedMillis > 0) {
            val end = Instant.now()
            sessions += TrackedSession(UUID.randomUUID().toString(), end.minusMillis(state.accumulatedMillis), end, fallback.projectName, fallback.projectPath, fallback.branchName, 0, 0, state.accumulatedMillis)
        }
        clearActiveSession()
        markPending()
        notifyListeners()
    }

    private fun recordDocumentChange(event: DocumentEvent) {
        if (!isRunning) return
        if (Duration.between(lastPhysicalTypingAt, Instant.now()) > TYPING_EVENT_WINDOW) return
        if (FileEditorManager.getInstance(project).selectedTextEditor?.document !== event.document) return
        val file = FileDocumentManager.getInstance().getFile(event.document) ?: return
        if (!ProjectFileIndex.getInstance(project).isInContent(file)) return
        activeCharacters += event.newFragment.count { it != '\n' && it != '\r' }
        if (event.document.textLength > 0) {
            val startOffset = event.offset.coerceAtMost(event.document.textLength)
            val endOffset = (event.offset + event.newLength).coerceAtMost(event.document.textLength)
            val startLine = event.document.getLineNumber(startOffset)
            val endLine = event.document.getLineNumber(endOffset)
            for (line in startLine..endLine) {
                val text = event.document.getText(com.intellij.openapi.util.TextRange(event.document.getLineStartOffset(line), event.document.getLineEndOffset(line)))
                if (text.isNotBlank()) activeWrittenLines += "${file.url}:$line"
            }
        }
        markPending()
    }

    private fun updateTrackingState() {
        if (!hasSession) startSession()
        val latest = resolveTrackingContext()
        if (latest != activeContext) {
            endSession()
            startSession(latest)
        }

        val now = Instant.now()
        val windowActive = isProjectWindowActive()
        if (windowActive) {
            // Returning to the IDE is activity by itself. This also prevents an immediate
            // idle pause before the first key or mouse event reaches the AWT listener.
            if (windowInactiveSince != null) lastActivityAt = now
            windowInactiveSince = null
            hasObservedActiveWindow = true
        } else if (hasObservedActiveWindow && windowInactiveSince == null) {
            windowInactiveSince = now
        }

        val shouldRun = if (windowActive) {
            Duration.between(lastActivityAt, now) < IDLE_TIMEOUT
        } else {
            windowInactiveSince?.let { Duration.between(it, now) < WINDOW_INACTIVE_GRACE } == true
        }
        if (shouldRun && !isRunning) resumeSession()
        if (!shouldRun && isRunning) pauseSession()
    }

    private fun startSession(context: TrackingContext = resolveTrackingContext()) {
        activeSessionId = UUID.randomUUID().toString()
        activeSessionStartedAt = Instant.now()
        activeSegmentStartedAt = null
        activeAccumulatedMillis = 0
        activeContext = context
        activeCharacters = 0
        activeWrittenLines.clear()
        markPending()
        notifyListeners()
    }

    private fun resumeSession() {
        activeSegmentStartedAt = Instant.now()
        markPending()
        notifyListeners()
    }

    private fun pauseSession() {
        val segmentStart = activeSegmentStartedAt ?: return
        activeAccumulatedMillis += Duration.between(segmentStart, Instant.now()).toMillis().coerceAtLeast(0)
        activeSegmentStartedAt = null
        markPending()
        syncNow()
        notifyListeners()
    }

    private fun endSession() {
        if (isRunning) pauseSession()
        val active = activeSessionSnapshot() ?: return
        if (active.endedAt.isAfter(active.startedAt)) sessions += active
        clearActiveSession()
        markPending()
        syncNow()
        notifyListeners()
    }

    private fun clearActiveSession() {
        activeSessionId = null; activeSessionStartedAt = null; activeContext = null
        activeSegmentStartedAt = null; activeAccumulatedMillis = 0
        activeCharacters = 0; activeWrittenLines.clear()
    }

    private fun activeSessionSnapshot(): TrackedSession? {
        val id = activeSessionId ?: return null
        val start = activeSessionStartedAt ?: return null
        val context = activeContext ?: resolveTrackingContext()
        return TrackedSession(id, start, Instant.now(), context.projectName, context.projectPath, context.branchName, activeCharacters, activeWrittenLines.size.toLong(), currentSessionElapsed.toMillis())
    }

    private fun allSessionsIncludingActive(): List<TrackedSession> = activeSessionSnapshot()?.let { sessions + it } ?: sessions.toList()
    private fun sessionsInCurrentWeek(): List<TrackedSession> {
        val (start, end) = currentWeekBounds()
        return allSessionsIncludingActive().filter { it.endedAt.isAfter(start) && it.startedAt.isBefore(end) }
    }
    private fun markPending() { syncStatus = SyncStatus.PENDING }
    private fun resolveTrackingContext(): TrackingContext {
        val repositories = GitRepositoryManager.getInstance(project).repositories
        val branch = when (repositories.size) {
            0 -> "(kein Git-Repository)"
            1 -> repositories.single().currentBranchName ?: repositories.single().currentRevision?.take(8)?.let { "detached@$it" } ?: "(unbekannt)"
            else -> repositories.sortedBy { it.root.path }.joinToString(", ") { repository ->
                "${repository.root.name}:${repository.currentBranchName ?: repository.currentRevision?.take(8)?.let { "detached@$it" } ?: "unbekannt"}"
            }
        }
        return TrackingContext(project.name, project.basePath.orEmpty(), branch)
    }

    private fun durationOf(source: List<TrackedSession>, rangeStart: Instant? = null, rangeEnd: Instant? = null) = source.fold(Duration.ZERO) { total, session ->
        if (rangeStart == null && rangeEnd == null) return@fold total.plusMillis(session.durationMillis)
        val start = rangeStart?.let { maxOf(session.startedAt, it) } ?: session.startedAt
        val end = rangeEnd?.let { minOf(session.endedAt, it) } ?: session.endedAt
        val wallMillis = Duration.between(session.startedAt, session.endedAt).toMillis()
        val overlapMillis = if (end.isAfter(start)) Duration.between(start, end).toMillis() else 0
        val activeOverlap = if (wallMillis > 0) (session.durationMillis * (overlapMillis.toDouble() / wallMillis)).toLong() else 0
        total.plusMillis(activeOverlap)
    }
    private fun currentWeekBounds(): Pair<Instant, Instant> {
        val zone = ZoneId.systemDefault(); val today = LocalDate.now(zone)
        val monday = today.minusDays((today.dayOfWeek.value - 1).toLong()); val start = monday.atStartOfDay(zone).toInstant()
        return start to monday.plusWeeks(1).atStartOfDay(zone).toInstant()
    }
    private fun scheduleTick() {
        alarm.addRequest({
            updateTrackingState()
            if (Duration.between(lastSyncAttempt, Instant.now()) >= SYNC_INTERVAL) syncNow()
            notifyListeners(); scheduleTick()
        }, 1_000)
    }
    private fun notifyListeners() = listeners.forEach { it() }
    private fun isProjectWindowActive() = WindowManager.getInstance().getFrame(project)?.isActive == true

    override fun dispose() {
        if (hasSession) endSession()
        Toolkit.getDefaultToolkit().removeAWTEventListener(activityListener)
    }

    companion object {
        private val IDLE_TIMEOUT = Duration.ofMinutes(5)
        private val WINDOW_INACTIVE_GRACE = Duration.ofMinutes(5)
        private val TYPING_EVENT_WINDOW = Duration.ofMillis(250)
        private val SYNC_INTERVAL = Duration.ofSeconds(5)
        private val HOURLY_RATE = BigDecimal("750")
        private val MILLIS_PER_HOUR = BigDecimal("3600000")
        fun getInstance(project: Project): TimeTrackerService = project.service()
    }
}

private fun sessionsJson(sessions: List<TrackedSession>) = sessions.joinToString(prefix = "{\"sessions\":[", postfix = "]}") { session ->
    """{"id":"${session.id.json()}","projectName":"${session.projectName.json()}","projectPath":"${session.projectPath.json()}","branchName":"${session.branchName.json()}","startedAt":"${session.startedAt}","endedAt":"${session.endedAt}","charactersWritten":${session.charactersWritten},"nonEmptyLinesWritten":${session.nonEmptyLinesWritten},"durationMillis":${session.durationMillis}}"""
}
private fun String.json() = replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r")

data class TrackingContext(val projectName: String, val projectPath: String, val branchName: String)
data class TrackedSession(val id: String, val startedAt: Instant, val endedAt: Instant, val projectName: String, val projectPath: String, val branchName: String, val charactersWritten: Long, val nonEmptyLinesWritten: Long, val durationMillis: Long)
data class TrackingBreakdown(val projectName: String, val projectPath: String, val branchName: String, val duration: Duration)
enum class TrackingStatus(val label: String) { TRACKING("Session läuft"), IDLE("Session pausiert wegen Inaktivität"), WINDOW_INACTIVE("Session pausiert – IDE nicht fokussiert"), STARTING("Session wird gestartet") }
enum class SyncStatus { SYNCED, PENDING }

class TimeTrackerState { var sessions: MutableList<TrackedSessionState> = mutableListOf(); var manuallyPaused = false; var accumulatedMillis: Long = 0 }
class TrackedSessionState {
    var id = ""; var startedAtEpochMillis: Long = -1; var endedAtEpochMillis: Long = -1
    var projectName = ""; var projectPath = ""; var branchName = ""
    var charactersWritten: Long = 0; var nonEmptyLinesWritten: Long = 0
    var durationMillis: Long = -1
}
private fun TrackedSession.toState() = TrackedSessionState().also {
    it.id = id; it.startedAtEpochMillis = startedAt.toEpochMilli(); it.endedAtEpochMillis = endedAt.toEpochMilli()
    it.projectName = projectName; it.projectPath = projectPath; it.branchName = branchName
    it.charactersWritten = charactersWritten; it.nonEmptyLinesWritten = nonEmptyLinesWritten
    it.durationMillis = durationMillis
}
private fun TrackedSessionState.toSession(fallback: TrackingContext): TrackedSession? {
    if (startedAtEpochMillis < 0 || endedAtEpochMillis < startedAtEpochMillis) return null
    val duration = if (durationMillis >= 0) durationMillis else endedAtEpochMillis - startedAtEpochMillis
    return TrackedSession(id.ifBlank { UUID.randomUUID().toString() }, Instant.ofEpochMilli(startedAtEpochMillis), Instant.ofEpochMilli(endedAtEpochMillis), projectName.ifBlank { fallback.projectName }, projectPath.ifBlank { fallback.projectPath }, branchName.ifBlank { fallback.branchName }, charactersWritten, nonEmptyLinesWritten, duration)
}
        private val ACTIVITY_EVENT_MASK = AWTEvent.KEY_EVENT_MASK or AWTEvent.MOUSE_EVENT_MASK or AWTEvent.MOUSE_MOTION_EVENT_MASK or AWTEvent.MOUSE_WHEEL_EVENT_MASK
