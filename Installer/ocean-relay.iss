; Bo cai OCEAN Relay (VPS Windows cung may MT5): Server + Gateway + giao dien web + EA + node.exe trong mot file.
; KHONG hoi gi luc cai. Cai xong trinh duyet tu mo trang Cai dat (http://127.0.0.1:8090/#setup): nguoi dung dan "ma ket noi" do
; chu Worker gui, dien tai khoan MT5 neu can. Sau nay vao lai trang do (hoac shortcut "Cai dat OCEAN Relay" o Start Menu) de doi,
; khong phai cai lai. Cai dat luu o C:\ProgramData\OceanRelay\settings.json nen nang cap bo cai khong lam mat.
; Build (CI: .github/workflows/release-server.yml lam het):
;   npm run pack            (tao release\ocean-relay, da kem node.exe khi chay tren Windows)
;   ISCC /DMyAppVersion=0.1.0 Installer\ocean-relay.iss
; Cai im lang (cho script/CI), tat ca tham so deu KHONG bat buoc:
;   OceanRelay-Setup.exe /VERYSILENT [/CODE=ocean1.xxxx] [/ACCOUNTS=900001,900002] [/PORT=8090] [/WEBHOOKKEY=<>=16 ky tu>]
;       [/GATEWAY=0 (khong cai Gateway)] [/SYMBOLMAP=XAUUSD=XAUUSDm] [/TFS=M3,M5,M15,H1]
;       [/GWPORT=47860 (cong Gateway cho EA; mac dinh 47860, KHONG phai 47800 de khoi dung Gateway khac cung VPS. Doi sau o trang Cai dat)]
; Bo cai chi chay scripts\install-server.ps1 (dung chung voi cai tay): chep file vao thu muc cai, sinh server.env (giu khoa EA
; neu da co), dang ky tac vu SYSTEM chay luc khoi dong, bat Quick Tunnel, doi /api/health, roi cai Gateway (tac vu rieng,
; 127.0.0.1:47860) voi OCEAN_EA_KEY vua sinh, chep + bien dich EA vao MQL5\Experts cua MT5.
; Go cai dat: go tac vu, giu du lieu o C:\ProgramData\OceanRelay.

#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#define MyAppName "OCEAN Relay"
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
OutputBaseFilename=OceanRelay-Setup
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
Name: "{autoprograms}\OCEAN Relay\Mo OCEAN Relay"; Filename: "{app}\OCEAN Relay.url"
Name: "{autoprograms}\OCEAN Relay\Cai dat OCEAN Relay (doi ma ket noi, tai khoan)"; Filename: "{app}\OCEAN Relay Setup.url"
Name: "{autoprograms}\OCEAN Relay\Xem log"; Filename: "{win}\explorer.exe"; Parameters: """{commonappdata}\OceanRelay\logs"""
Name: "{autoprograms}\OCEAN Relay\Thu muc cai (server.env, EA, docs)"; Filename: "{win}\explorer.exe"; Parameters: """{app}"""

[INI]
Filename: "{app}\OCEAN Relay.url"; Section: "InternetShortcut"; Key: "URL"; String: "{code:ServerUrl}"
Filename: "{app}\OCEAN Relay Setup.url"; Section: "InternetShortcut"; Key: "URL"; String: "{code:SetupUrl}"

[Run]
; O tick san o trang cuoi: mo ngay trang Cai dat trong trinh duyet (chay bang user dang dang nhap, khong phai Administrator).
Filename: "{app}\OCEAN Relay Setup.url"; Description: "Mo trang cai dat OCEAN Relay ngay (dan ma ket noi)"; Flags: postinstall shellexec skipifsilent nowait

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
Type: files; Name: "{app}\OCEAN Relay Setup.url"
Type: filesandordirs; Name: "{commonpf}\OceanRelayGateway"

[Code]
{ Doc gia tri KEY=... tu server.env da co (nang cap: giu cong dang dung). }
function ReadEnvValue(const Key: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
  P: String;
begin
  Result := '';
  if not LoadStringsFromFile(ExpandConstant('{commonpf}\OceanRelay\server.env'), Lines) then Exit;
  P := Key + '=';
  for I := 0 to GetArrayLength(Lines) - 1 do
    if Pos(P, Lines[I]) = 1 then
    begin
      Result := Trim(Copy(Lines[I], Length(P) + 1, Length(Lines[I])));
      Exit;
    end;
end;

{ Bo khoang trang, xuong dong, dau nhay (chi dung cho tham so cai im lang /CODE). }
function CleanCode(const S: String): String;
var
  I: Integer;
  C: String;
begin
  Result := '';
  for I := 1 to Length(S) do
  begin
    C := Copy(S, I, 1);
    if (C <> ' ') and (C <> #9) and (C <> #13) and (C <> #10) and (C <> '"') and (C <> '''') then Result := Result + C;
  end;
end;

function CleanAccounts(const S: String): String;
var
  I: Integer;
  C: String;
begin
  Result := '';
  for I := 1 to Length(S) do
  begin
    C := Copy(S, I, 1);
    if (C = ';') or (C = ' ') then C := ',';
    Result := Result + C;
  end;
end;

{ Cong Server: /PORT=..., neu khong thi giu cong dang dung (nang cap), mac dinh 8090. }
function PortValue: Integer;
var
  S: String;
begin
  S := ExpandConstant('{param:PORT|}');
  if S = '' then S := ReadEnvValue('OCEAN_PORT');
  Result := StrToIntDef(Trim(S), 8090);
  if (Result < 1) or (Result > 65535) then Result := 8090;
end;

function ServerUrl(Param: String): String;
begin
  Result := 'http://127.0.0.1:' + IntToStr(PortValue) + '/';
end;

function SetupUrl(Param: String): String;
begin
  Result := 'http://127.0.0.1:' + IntToStr(PortValue) + '/#setup';
end;

function SetEnvironmentVariableW(Name, Value: String): Boolean; external 'SetEnvironmentVariableW@kernel32.dll stdcall';

procedure InitializeWizard;
begin
  { Windows 8.1 / Server 2012 R2: Node can bo qua kiem tra nen tang. }
  SetEnvironmentVariableW('NODE_SKIP_PLATFORM_CHECK', '1');
end;

{ Chay scripts\install-server.ps1 tu goi da giai nen. Loi (throw) -> ma thoat khac 0, ghi vao logs\install.log. }
procedure RunInstallScript;
var
  RC: Integer;
  Pkg, Args, LogFile, Code, Acc, Hook, Map, Tfs: String;
  GwPort: Integer;
begin
  Pkg := ExpandConstant('{tmp}\ocean-pkg');
  ForceDirectories(ExpandConstant('{commonappdata}\OceanRelay\logs'));
  LogFile := ExpandConstant('{commonappdata}\OceanRelay\logs\install.log');
  Args := '-NoProfile -ExecutionPolicy Bypass -File "' + Pkg + '\scripts\install-server.ps1" -InstallDir "' + ExpandConstant('{app}') +
    '" -Port ' + IntToStr(PortValue);
  { Cac tham so duoi day chi de cai tu dong; nguoi dung thuong dan ma o trang Cai dat sau khi cai. }
  Code := CleanCode(ExpandConstant('{param:CODE|}'));
  if Code <> '' then Args := Args + ' -ConnectCode "' + Code + '"';
  Acc := CleanAccounts(Trim(ExpandConstant('{param:ACCOUNTS|}')));
  if Acc <> '' then Args := Args + ' -Accounts "' + Acc + '"';
  Hook := ExpandConstant('{param:WEBHOOKKEY|}');
  if Hook <> '' then Args := Args + ' -WebhookKey "' + Hook + '"';
  if ExpandConstant('{param:GATEWAY|1}') = '0' then Args := Args + ' -NoGateway';
  Map := ExpandConstant('{param:SYMBOLMAP|}');
  if Map <> '' then Args := Args + ' -SymbolMap "' + Map + '"';
  Tfs := ExpandConstant('{param:TFS|}');
  if Tfs <> '' then Args := Args + ' -Tfs "' + Tfs + '"';
  { Cong Gateway: chi nhan so hop le (1024-65535); khong co thi script tu giu cong da dat o trang Cai dat, hoac mac dinh 47860. }
  GwPort := StrToIntDef(Trim(ExpandConstant('{param:GWPORT|}')), 0);
  if (GwPort >= 1024) and (GwPort <= 65535) then Args := Args + ' -GatewayPort ' + IntToStr(GwPort);
  WizardForm.StatusLabel.Caption := 'Dang cai Server, Gateway va EA (co the mat 1-2 phut)...';
  RC := 1;
  Exec(ExpandConstant('{cmd}'), '/S /C ""powershell.exe" ' + Args + ' > "' + LogFile + '" 2>&1"', Pkg, SW_HIDE, ewWaitUntilTerminated, RC);
  if RC <> 0 then
    SuppressibleMsgBox('Cai khong thanh cong (ma ' + IntToStr(RC) + '). Xem chi tiet: ' + LogFile, mbError, MB_OK, IDOK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then RunInstallScript;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpWelcome then
    WizardForm.WelcomeLabel2.Caption :=
      'Bo cai se cai Server, Gateway va EA cho MT5 tren may nay, tu khoi dong cung may.' + #13#10#13#10 +
      'Ban khong phai nhap gi luc cai. Cai xong, trinh duyet se mo trang Cai dat de ban dan Ma ket noi (ma do nguoi quan tri gui). ' +
      'Sau nay muon doi ma ket noi hay tai khoan MT5 thi mo lai trang do, khong can cai lai.';
  if (CurPageID = wpFinished) and (not WizardSilent) then
    WizardForm.FinishedLabel.Caption :=
      'OCEAN Relay da chay va tu khoi dong cung may.' + #13#10#13#10 +
      'BUOC TIEP THEO: de nguyen o "Mo trang cai dat" ben duoi roi bam Finish, dan Ma ket noi vao trang vua mo.' + #13#10#13#10 +
      'Sau do lam 2 viec trong MT5 (mot lan, trang Cai dat cung co huong dan):' + #13#10 +
      '1) Tools > Options > Expert Advisors > Allow WebRequest > them  http://127.0.0.1:47860  (mac dinh; trang Cai dat ghi dung dia chi dang dung)' + #13#10 +
      '2) Keo EA OceanRelay (Navigator) len MOT chart. Mac dinh EA chi theo doi; bat InpAllowTrading khi san sang (thu tren DEMO truoc).' + #13#10#13#10 +
      'Bi trung cong voi chuong trinh khac tren VPS? Mo trang Cai dat > Nang cao > Cong Gateway, doi la chay, khong can cai lai.' + #13#10#13#10 +
      'Mo lai trang cai dat bat cu luc nao: Start Menu > OCEAN Relay > Cai dat, hoac http://127.0.0.1:' + IntToStr(PortValue) + '/#setup' + #13#10 +
      'Log cai dat: C:\ProgramData\OceanRelay\logs\install.log';
end;
