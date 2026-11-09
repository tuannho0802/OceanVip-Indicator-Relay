; Bo cai OCEAN Relay Server (VPS Windows): Server + Gateway + giao dien web + EA + node.exe trong mot file.
; Build (CI: .github/workflows/release-server.yml lam het):
;   npm run pack            (tao release\ocean-relay, da kem node.exe khi chay tren Windows)
;   ISCC /DMyAppVersion=0.2.0 Installer\ocean-relay.iss
; Cai im lang:
;   OceanRelay-Server-Setup.exe /VERYSILENT /WORKERURL=https://ocean-relay.xxx.workers.dev /SYNCKEY=<>=32 ky tu> [/PORT=8090] [/WEBHOOKKEY=<>=16 ky tu>]
; Bo cai chi chay scripts\install-server.ps1 (dung chung voi cai tay): chep file vao thu muc cai, sinh server.env (khoa ngau nhien,
; giu nguyen neu da co), dang ky tac vu SYSTEM chay luc khoi dong, bat Quick Tunnel khi co Worker, doi /api/health.
; Nang cap: chay lai bo cai moi, server.env cu duoc giu. Go cai dat: go tac vu, giu du lieu o C:\ProgramData\OceanRelay.

#ifndef MyAppVersion
  #define MyAppVersion "0.2.0"
#endif
#define MyAppName "OCEAN Relay Server"
#define Pkg "..\release\ocean-relay"

[Setup]
AppId={{B7C3F2A1-5D4E-4A8B-9E21-6F0C8D7A3B54}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=OCEAN Relay
DefaultDirName={commonpf}\OceanRelay
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release
OutputBaseFilename=OceanRelay-Server-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
VersionInfoVersion={#MyAppVersion}
CloseApplications=no
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Goi da build duoc giai nen vao thu muc tam; install-server.ps1 chep tu do sang {app} (cung script dung cho cai tay).
Source: "{#Pkg}\*"; DestDir: "{tmp}\ocean-pkg"; Flags: ignoreversion recursesubdirs createallsubdirs deleteafterinstall

[Icons]
Name: "{autoprograms}\OCEAN Relay\Mo giao dien OCEAN Relay"; Filename: "{app}\OCEAN Relay.url"
Name: "{autoprograms}\OCEAN Relay\Xem log"; Filename: "{win}\explorer.exe"; Parameters: """{commonappdata}\OceanRelay\logs"""
Name: "{autoprograms}\OCEAN Relay\Thu muc cai (server.env, EA, docs)"; Filename: "{win}\explorer.exe"; Parameters: """{app}"""

[INI]
Filename: "{app}\OCEAN Relay.url"; Section: "InternetShortcut"; Key: "URL"; String: "{code:ServerUrl}"

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveTasks"

[UninstallDelete]
; Giu lai server.env (khoa) va du lieu o ProgramData; xoa phan con lai.
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\web"
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\ea"
Type: filesandordirs; Name: "{app}\docs"
Type: files; Name: "{app}\node.exe"
Type: files; Name: "{app}\run-server.cmd"
Type: files; Name: "{app}\init-env.ps1"
Type: files; Name: "{app}\OCEAN Relay.url"

[Code]
var
  CloudPage: TInputQueryWizardPage;

function IsHttpUrl(const U: String): Boolean;
begin
  Result := (Pos('https://', Lowercase(U)) = 1) or (Pos('http://', Lowercase(U)) = 1);
end;

function StripSlash(const U: String): String;
begin
  Result := Trim(U);
  while (Result <> '') and (Copy(Result, Length(Result), 1) = '/') do
    Delete(Result, Length(Result), 1);
end;

function PortValue: Integer;
begin
  Result := StrToIntDef(Trim(CloudPage.Values[2]), 8090);
end;

function ServerUrl(Param: String): String;
begin
  Result := 'http://127.0.0.1:' + IntToStr(PortValue) + '/';
end;

function SetEnvironmentVariableW(Name, Value: String): Boolean; external 'SetEnvironmentVariableW@kernel32.dll stdcall';

procedure InitializeWizard;
begin
  { Windows 8.1 / Server 2012 R2: Node can bo qua kiem tra nen tang. }
  SetEnvironmentVariableW('NODE_SKIP_PLATFORM_CHECK', '1');
  CloudPage := CreateInputQueryPage(wpWelcome, 'Ket noi Cloudflare Worker',
    'Cua truoc nhan webhook cua TradingView va giu tin hieu khi VPS tat (khuyen dung)',
    'Dien dia chi Worker va SYNC_KEY (in ra khi chay "npm run setup" trong thu muc worker). Server se tu mo Quick Tunnel ' +
    '(khong can ten mien) va bao dia chi moi cho Worker moi lan khoi dong. Bo trong ca hai neu chua co Worker.');
  CloudPage.Add('Dia chi Worker (https://....workers.dev, khong co / o cuoi):', False);
  CloudPage.Add('SYNC_KEY (tu 32 ky tu, trung SYNC_KEY cua Worker):', True);
  CloudPage.Add('Cong HTTP cua Server (chi nghe 127.0.0.1):', False);
  CloudPage.Values[0] := ExpandConstant('{param:WORKERURL|}');
  CloudPage.Values[1] := ExpandConstant('{param:SYNCKEY|}');
  CloudPage.Values[2] := ExpandConstant('{param:PORT|8090}');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Cloud, Sync: String;
  Port: Integer;
begin
  Result := True;
  if CurPageID <> CloudPage.ID then Exit;
  Cloud := StripSlash(CloudPage.Values[0]);
  Sync := Trim(CloudPage.Values[1]);
  Port := StrToIntDef(Trim(CloudPage.Values[2]), 0);
  if (Port < 1) or (Port > 65535) then
  begin
    MsgBox('Cong HTTP phai la so tu 1 den 65535.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  if (Cloud <> '') and (not IsHttpUrl(Cloud)) then
  begin
    MsgBox('Dia chi Worker phai bat dau bang https://', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  if (Cloud <> '') <> (Sync <> '') then
  begin
    MsgBox('Dia chi Worker va SYNC_KEY phai di cung nhau (dien ca hai hoac bo trong ca hai).', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  if (Sync <> '') and (Length(Sync) < 32) then
  begin
    MsgBox('SYNC_KEY phai dai it nhat 32 ky tu (trung SYNC_KEY cua Worker).', mbError, MB_OK);
    Result := False;
  end;
end;

{ Chay scripts\install-server.ps1 tu goi da giai nen. Loi (throw) -> ma thoat khac 0, ghi vao logs\install.log. }
procedure RunInstallScript;
var
  RC: Integer;
  Pkg, Args, LogFile, Hook: String;
begin
  Pkg := ExpandConstant('{tmp}\ocean-pkg');
  ForceDirectories(ExpandConstant('{commonappdata}\OceanRelay\logs'));
  LogFile := ExpandConstant('{commonappdata}\OceanRelay\logs\install.log');
  Args := '-NoProfile -ExecutionPolicy Bypass -File "' + Pkg + '\scripts\install-server.ps1" -InstallDir "' + ExpandConstant('{app}') +
    '" -Port ' + IntToStr(PortValue);
  if StripSlash(CloudPage.Values[0]) <> '' then
    Args := Args + ' -WorkerUrl "' + StripSlash(CloudPage.Values[0]) + '" -SyncKey "' + Trim(CloudPage.Values[1]) + '"';
  Hook := ExpandConstant('{param:WEBHOOKKEY|}');
  if Hook <> '' then Args := Args + ' -WebhookKey "' + Hook + '"';
  WizardForm.StatusLabel.Caption := 'Dang cai Server va dang ky tac vu tu khoi dong...';
  RC := 1;
  Exec(ExpandConstant('{cmd}'), '/S /C ""powershell.exe" ' + Args + ' > "' + LogFile + '" 2>&1"', Pkg, SW_HIDE, ewWaitUntilTerminated, RC);
  if RC <> 0 then
    SuppressibleMsgBox('Cai Server khong thanh cong (ma ' + IntToStr(RC) + '). Xem chi tiet: ' + LogFile, mbError, MB_OK, IDOK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then RunInstallScript;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and (not WizardSilent) then
    WizardForm.FinishedLabel.Caption :=
      'OCEAN Relay Server da chay va tu khoi dong cung may.' + #13#10#13#10 +
      'Giao dien: http://127.0.0.1:' + IntToStr(PortValue) + '/' + #13#10 +
      'Khoa va dia chi: PowerShell Administrator, chay  "' + ExpandConstant('{app}') + '\node.exe" "' + ExpandConstant('{app}') +
      '\dist\server.mjs" info --show-keys' + #13#10 +
      'Kiem tra nhanh: scripts\check-vps.ps1 trong thu muc cai.';
end;
