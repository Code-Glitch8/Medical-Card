@echo off
setlocal enabledelayedexpansion
set "GV=8.13"
if not defined GRADLE_USER_HOME set "GRADLE_USER_HOME=%USERPROFILE%\.gradle"
set "GD=%GRADLE_USER_HOME%\medical-card-gradle\gradle-%GV%"
if not exist "%GD%\bin\gradle.bat" (
  echo Downloading Gradle %GV% from the official Gradle distribution service...
  if not exist "%GRADLE_USER_HOME%\medical-card-gradle" mkdir "%GRADLE_USER_HOME%\medical-card-gradle"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $u='https://services.gradle.org/distributions/gradle-%GV%-bin.zip'; $z=Join-Path '%GRADLE_USER_HOME%\medical-card-gradle' 'gradle-dist.zip'; Invoke-WebRequest -Uri $u -OutFile $z; Expand-Archive -LiteralPath $z -DestinationPath '%GRADLE_USER_HOME%\medical-card-gradle' -Force; Remove-Item $z"
  if errorlevel 1 exit /b 1
)
call "%GD%\bin\gradle.bat" %*
exit /b %ERRORLEVEL%
