#define MyAppName "MedVault Secure Medical Records"

#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif

#ifndef SourceDir
  #error "SourceDir must point to the extracted folder containing the original MedVault EXE and runtime files."
#endif

#ifndef OutputDir
  #define OutputDir "dist"
#endif

[Setup]
AppId={{B3D701E9-7D56-4C7C-A4E1-2C896F70B7F9}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher=MedVault Secure Medical Records
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\MedVault Secure Medical Records.exe
OutputDir={#OutputDir}
OutputBaseFilename=MedVault-Secure-Medical-Records-Setup
SetupLogging=yes
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin
DisableProgramGroupPage=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; Copy the entire supplied Windows app folder so all Electron/Chromium DLLs,
; locales and resources/app.asar remain beside the exact original EXE.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\MedVault Secure Medical Records.exe"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\MedVault Secure Medical Records.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\MedVault Secure Medical Records.exe"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
