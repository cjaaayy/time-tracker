plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.2.20"
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = "de.cjbey.timetracker"
version = "0.1.1"

base {
    archivesName.set("time-tracker")
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2025.1.7")
        bundledPlugin("Git4Idea")
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "251"
        }
    }
}

val pluginVersion = version.toString()
val githubRepository = providers.gradleProperty("githubRepository")
    .orElse("cjaaayy/time-tracker")
val releaseTag = providers.gradleProperty("releaseTag")
    .orElse("v$pluginVersion")
val pluginArchiveName = "time-tracker-$pluginVersion.zip"
val pluginDistribution = layout.buildDirectory.file("distributions/$pluginArchiveName")
val updateRepositoryFile = layout.buildDirectory.file("update-repository/updatePlugins.xml")

tasks {
    withType<JavaCompile>().configureEach {
        sourceCompatibility = "21"
        targetCompatibility = "21"
    }

    register("generateUpdateRepository") {
        group = "distribution"
        description = "Generates updatePlugins.xml for the GitHub release."
        notCompatibleWithConfigurationCache("Writes release-specific plugin repository metadata")
        dependsOn("buildPlugin")
        inputs.property("githubRepository", githubRepository)
        inputs.property("releaseTag", releaseTag)
        inputs.property("pluginVersion", pluginVersion)
        inputs.file(pluginDistribution)
        outputs.file(updateRepositoryFile)

        doLast {
            val repository = githubRepository.get()
            val tag = releaseTag.get()
            val distribution = pluginDistribution.get().asFile
            val outputFile = updateRepositoryFile.get().asFile

            require(distribution.isFile) {
                "Plugin distribution not found: ${distribution.absolutePath}"
            }
            require(repository.matches(Regex("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"))) {
                "githubRepository must use the OWNER/REPOSITORY format"
            }
            require(tag.matches(Regex("[A-Za-z0-9._-]+"))) {
                "releaseTag contains unsupported characters"
            }

            outputFile.parentFile.mkdirs()
            outputFile.writeText(
                """<?xml version="1.0" encoding="UTF-8"?>
<plugins>
  <plugin id="de.cjbey.timetracker"
          url="https://github.com/$repository/releases/download/$tag/$pluginArchiveName"
          version="$pluginVersion">
    <idea-version since-build="251"/>
    <name>Time Tracker</name>
    <vendor>cjaayy</vendor>
  </plugin>
</plugins>
"""
            )
        }
    }
}
