package de.cjbey.timetracker

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

@Service(Service.Level.PROJECT)
@State(name = "DevelopmentTimeTrackerSettings", storages = [Storage("development-time-tracker-settings.xml")])
class TimeTrackerSettings(private val project: Project) : PersistentStateComponent<TimeTrackerSettingsState> {
    private var state = TimeTrackerSettingsState()
    var serverUrl: String
        get() = state.serverUrl
        set(value) { state.serverUrl = value.trim().trimEnd('/') }

    override fun getState() = state
    override fun loadState(state: TimeTrackerSettingsState) { this.state = state }

    fun getApiKey(): String = PasswordSafe.instance.getPassword(credentials()) ?: ""
    fun setApiKey(value: String) {
        PasswordSafe.instance.set(credentials(), if (value.isBlank()) null else Credentials("api-key", value.trim()))
    }
    private fun credentials() = CredentialAttributes(generateServiceName("Development Time Tracker", project.locationHash))

    companion object { fun getInstance(project: Project): TimeTrackerSettings = project.service() }
}

class TimeTrackerSettingsState { var serverUrl: String = "http://localhost:8080" }

class TimeTrackerConfigurable(private val project: Project) : Configurable {
    private val serverUrl = JBTextField()
    private val apiKey = JBPasswordField()
    private var panel: JPanel? = null

    override fun getDisplayName() = "Time Tracker"
    override fun createComponent(): JComponent {
        reset()
        return FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Serveradresse:"), serverUrl, 1, false)
            .addLabeledComponent(JBLabel("API-Schlüssel:"), apiKey, 1, false)
            .addComponentFillVertically(JPanel(), 0)
            .panel.also { panel = it }
    }
    override fun isModified(): Boolean {
        val settings = TimeTrackerSettings.getInstance(project)
        return serverUrl.text.trim().trimEnd('/') != settings.serverUrl || String(apiKey.password) != settings.getApiKey()
    }
    override fun apply() {
        val settings = TimeTrackerSettings.getInstance(project)
        settings.serverUrl = serverUrl.text
        settings.setApiKey(String(apiKey.password))
        TimeTrackerService.getInstance(project).syncNow()
    }
    override fun reset() {
        val settings = TimeTrackerSettings.getInstance(project)
        serverUrl.text = settings.serverUrl
        apiKey.text = settings.getApiKey()
    }
    override fun disposeUIResources() { panel = null }
}
