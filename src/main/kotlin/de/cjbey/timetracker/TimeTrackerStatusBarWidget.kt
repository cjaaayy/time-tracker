package de.cjbey.timetracker

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.ui.JBUI
import java.time.Duration
import javax.swing.JComponent
import javax.swing.JLabel

class TimeTrackerStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = TimeTrackerStatusBarWidget.ID

    override fun getDisplayName(): String = "Time Tracker"

    override fun isAvailable(project: Project): Boolean = true

    override fun createWidget(project: Project): StatusBarWidget = TimeTrackerStatusBarWidget(project)

    override fun disposeWidget(widget: StatusBarWidget) = widget.dispose()

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

private class TimeTrackerStatusBarWidget(project: Project) : CustomStatusBarWidget {
    private val service = TimeTrackerService.getInstance(project)
    private val label = JLabel().apply {
        border = JBUI.Borders.empty(0, 6)
    }
    private val updateUi: () -> Unit = {
        val color = if (service.syncStatus == SyncStatus.SYNCED) "#38a8ff" else "#f5c542"
        label.text = "<html><font color='$color'>●</font>&nbsp;${service.currentSessionElapsed.formatAsClock()}</html>"
        val syncText = if (service.syncStatus == SyncStatus.SYNCED) "vollständig synchronisiert" else "Synchronisation ausstehend oder fehlgeschlagen"
        label.toolTipText = "Time Tracker: ${service.status.label}; $syncText."
    }

    init {
        service.addListener(updateUi)
    }

    override fun ID(): String = ID

    override fun getComponent(): JComponent = label

    override fun dispose() {
        service.removeListener(updateUi)
    }

    companion object {
        const val ID = "DevelopmentTimeTrackerStatus"
    }
}

private fun Duration.formatAsClock(): String {
    val totalSeconds = seconds.coerceAtLeast(0)
    return "%02d:%02d:%02d".format(
        totalSeconds / 3600,
        (totalSeconds % 3600) / 60,
        totalSeconds % 60,
    )
}
