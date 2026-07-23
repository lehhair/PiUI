#!/bin/bash

# Set environment variables for Android development
export ANDROID_HOME="/e/app/Android/Sdk"
export NDK_HOME="/e/app/Android/Sdk/ndk/29.0.14206865"
export JAVA_HOME="/e/app/Android/Android Studio/jbr"
export PATH="$HOME/.cargo/bin:$PATH"

echo "Checking connected Android devices..."
adb devices

echo "Starting Tauri Android Dev..."
npm run tauri android dev
