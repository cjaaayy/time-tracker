package de.cjbey.timetracker

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.updateSettings.impl.UpdateSettings
import java.util.concurrent.atomic.AtomicBoolean

/** Registers the GitHub Releases feed with IntelliJ's native plugin updater. */
object TimeTrackerUpdateRepository {
    private const val UPDATE_FEED =
        "https://github.com/cjaaayy/time-tracker/releases/latest/download/updatePlugins.xml"

    private val registered = AtomicBoolean(false)
    private val logger = Logger.getInstance(TimeTrackerUpdateRepository::class.java)

    fun register() {
        if (!registered.compareAndSet(false, true)) return

        runCatching {
            val hosts = UpdateSettings.getInstance().storedPluginHosts
            if (UPDATE_FEED !in hosts) {
                hosts.add(UPDATE_FEED)
                logger.info("Registered Time Tracker update feed: $UPDATE_FEED")
            }
        }.onFailure {
            registered.set(false)
            logger.warn("Could not register the Time Tracker update feed", it)
        }
    }
}
