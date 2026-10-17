package de.cjbey.timetracker

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

class TimeTrackerStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        TimeTrackerUpdateRepository.register()
        TimeTrackerService.getInstance(project)
    }
}
