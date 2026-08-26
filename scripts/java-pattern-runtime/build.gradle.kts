import org.teavm.gradle.api.JSModuleType
import org.teavm.gradle.api.OptimizationLevel

plugins {
    java
    id("org.teavm") version "0.15.0"
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(teavm.libs.jso)
}

teavm.js {
    mainClass = "org.commcare.nova.xpath.JavaPatternRuntime"
    moduleType = JSModuleType.ES2015
    optimization = OptimizationLevel.BALANCED
    obfuscated = true
    debugInformation = false
    sourceMap = false
    targetFileName = "javaPatternRuntime.generated.js"
}
