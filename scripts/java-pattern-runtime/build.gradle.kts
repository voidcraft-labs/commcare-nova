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
    val runtime = providers.gradleProperty("runtime").orElse("pattern").get()
    require(runtime == "pattern" || runtime == "math") {
        "runtime must be exactly 'pattern' or 'math'"
    }
    mainClass = if (runtime == "math") {
        "org.commcare.nova.xpath.JavaMathRuntime"
    } else {
        "org.commcare.nova.xpath.JavaPatternRuntime"
    }
    moduleType = JSModuleType.ES2015
    optimization = OptimizationLevel.BALANCED
    obfuscated = true
    debugInformation = false
    sourceMap = false
    targetFileName = if (runtime == "math") {
        "javaMathRuntime.generated.js"
    } else {
        "javaPatternRuntime.generated.js"
    }
}
