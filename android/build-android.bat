@echo off
setlocal
call gradlew.bat assembleDebug
if errorlevel 1 exit /b 1
echo Debug APK should be at app\build\outputs\apk\debug\app-debug.apk
