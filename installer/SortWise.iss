; SortWise installer (Inno Setup 6 or 7)
; Normally compiled by build-installer.ps1, which passes AppVersion, AppBuild and SourceDir.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef AppBuild
  #define AppBuild "00000000"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\win-unpacked"
#endif

#define AppName "SortWise"
#define AppExe "SortWise.exe"
#define AppPublisher "resrge"
#define AppURL "https://resrge.com"

[Setup]
; Keep this AppId the same forever so upgrades replace the old install
AppId={{2FAB1949-5B2A-4BC4-B325-37BBE83F8D0B}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} v{#AppVersion} build {#AppBuild}
VersionInfoVersion={#AppVersion}.0
VersionInfoProductTextVersion=v{#AppVersion} build {#AppBuild}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
; Full install into C:\Program Files\SortWise (asks for admin)
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
PrivilegesRequired=admin
; Show the full wizard: Welcome -> Install folder -> Start Menu folder -> Options -> Ready -> Finish
DisableWelcomePage=no
DisableDirPage=no
DisableProgramGroupPage=no
DisableReadyPage=no
AllowNoIcons=yes
UsePreviousAppDir=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename={#AppName}-Setup-{#AppVersion}-build{#AppBuild}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; AppUserModelID matches the app so Windows notifications show "SortWise"
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; AppUserModelID: "com.resrge.sortwise"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon; AppUserModelID: "com.resrge.sortwise"

[Run]
; Normal install: optional "Launch SortWise" checkbox on the last page
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
; In-app update (silent install with /RELAUNCH): reopen SortWise when done
Filename: "{app}\{#AppExe}"; Flags: nowait runasoriginaluser; Check: ShouldRelaunch

[Registry]
; Remove the "Start with Windows" entry the app may have created
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "SortWise"; Flags: uninsdeletevalue

[UninstallRun]
; SortWise may be running in the tray while watching a folder
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#AppExe} /F"; Flags: runhidden; RunOnceId: "StopSortWise"

[UninstallDelete]
; Settings and undo history live in %APPDATA%\SortWise; only remove leftovers in the install folder
Type: filesandordirs; Name: "{app}"

[Code]
function ShouldRelaunch: Boolean;
begin
  Result := WizardSilent and (Pos('/RELAUNCH', Uppercase(GetCmdTail)) > 0);
end;

// SortWise may be running in the tray; stop it so its files can be replaced
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#AppExe} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(500);
  Result := '';
end;
