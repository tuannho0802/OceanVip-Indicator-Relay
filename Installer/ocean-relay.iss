; Bo cai OCEAN Relay (VPS Windows cung may MT5): Server + Gateway + giao dien web + EA + node.exe trong mot file.
; Nguoi dung chi can dan "ma ket noi" do chu Worker gui (khong phai nhap URL Worker, khoa, cong...).
; Build (CI: .github/workflows/release-server.yml lam het):
;   npm run pack            (tao release\ocean-relay, da kem node.exe khi chay tren Windows)
;   ISCC /DMyAppVersion=0.1.0 Installer\ocean-relay.iss
; Cai im lang (cho script/CI):
;   OceanRelay-Setup.exe /VERYSILENT /CODE=ocean1.xxxx [/ACCOUNTS=900001,900002] [/PORT=8090] [/WEBHOOKKEY=<>=16 ky tu>]
;       [/GATEWAY=0 (khong cai Gateway)] [/SYMBOLMAP=XAUUSD=XAUUSDm] [/TFS=M3,M5,M15,H1]
; Bo cai chi chay scripts\install-server.ps1 (dung chung voi cai tay): chep file vao thu muc cai, sinh server.env (giu khoa EA
; neu da co), dang ky tac vu SYSTEM chay luc khoi dong, bat Quick Tunnel, doi /api/health, roi cai Gateway (tac vu rieng,
; 127.0.0.1:47800) voi OCEAN_EA_KEY vua sinh, chep + bien dich EA vao MQL5\Experts cua MT5.
; Nang cap: chay lai bo cai moi, o nhap hien san ma ket noi / tai khoan cu. Go cai dat: go tac vu, giu du lieu o C:\ProgramData\OceanRelay.

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
Type: filesandordirs; Name: "{commonpf}\OceanRelayGateway"

[Code]
var
  ConnPage: TInputQueryWizardPage;

function IsDigits(const S: String): Boolean;
var
  I: Integer;
begin
  Result := S <> '';
  for I := 1 to Length(S) do
    if (S[I] < '0') or (S[I] > '9') then Result := False;
end;

{ Doc gia tri KEY=... tu server.env da co (nang cap: hien san gia tri cu). }
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

{ Bo khoang trang, xuong dong, dau nhay khi dan ma. }
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

function PortValue: Integer;
begin
  Result := StrToIntDef(Trim(ConnPage.Values[2]), 8090);
end;

function ServerUrl(Param: String): String;
begin
  Result := 'http://127.0.0.1:' + IntToStr(PortValue) + '/';
end;

function SetEnvironmentVariableW(Name, Value: String): Boolean; external 'SetEnvironmentVariableW@kernel32.dll stdcall';

procedure InitializeWizard;
var
  Code, Acc, Port: String;
begin
  { Windows 8.1 / Server 2012 R2: Node can bo qua kiem tra nen tang. }
  SetEnvironmentVariableW('NODE_SKIP_PLATFORM_CHECK', '1');
  ConnPage := CreateInputQueryPage(wpWelcome, 'Ket noi OCEAN Relay',
    'Chi can dan Ma ket noi ma nguoi quan tri gui cho ban',
    'Ma bat dau bang ocean1. - da chua san dia chi Worker va khoa rieng cua ban, ban khong phai nhap them gi. ' +
    'Neu may MT5 co nhieu tai khoan, dien cac so tai khoan se nhan tin hieu (cach nhau bang dau phay); de trong = moi tai khoan tren may nay.');
  ConnPage.Add('Ma ket noi (dan nguyen chuoi ocean1.xxxx):', False);
  ConnPage.Add('So tai khoan MT5 (vi du 900001,900002; de trong = tat ca):', False);
  ConnPage.Add('Cong Server (de nguyen 8090 neu khong bi trung):', False);
  Code := ExpandConstant('{param:CODE|}');
  if Code = '' then Code := ReadEnvValue('OCEAN_CONNECT_CODE');
  Acc := ExpandConstant('{param:ACCOUNTS|}');
  if Acc = '' then Acc := ReadEnvValue('OCEAN_ACCOUNTS');
  Port := ExpandConstant('{param:PORT|}');
  if Port = '' then Port := ReadEnvValue('OCEAN_PORT');
  if Port = '' then Port := '8090';
  ConnPage.Values[0] := Code;
  ConnPage.Values[1] := Acc;
  ConnPage.Values[2] := Port;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Code, Acc, Part: String;
  Port, P: Integer;
begin
  Result := True;
  if CurPageID <> ConnPage.ID then Exit;
  Code := CleanCode(ConnPage.Values[0]);
  if (Pos('ocean1.', Code) <> 1) or (Length(Code) < 40) then
  begin
    MsgBox('Ma ket noi khong dung. Ma phai bat dau bang ocean1. va dan du, khong thieu ky tu. Neu chua co, hay xin nguoi quan tri.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  Port := StrToIntDef(Trim(ConnPage.Values[2]), 0);
  if (Port < 1) or (Port > 65535) then
  begin
    MsgBox('Cong phai la so tu 1 den 65535 (mac dinh 8090).', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  Acc := CleanAccounts(Trim(ConnPage.Values[1]));
  while Acc <> '' do
  begin
    P := Pos(',', Acc);
    if P = 0 then
    begin
      Part := Acc;
      Acc := '';
    end
    else
    begin
      Part := Copy(Acc, 1, P - 1);
      Acc := Copy(Acc, P + 1, Length(Acc));
    end;
    if (Part <> '') and ((not IsDigits(Part)) or (Length(Part) < 3) or (Length(Part) > 12)) then
    begin
      MsgBox('So tai khoan MT5 chi gom chu so, cach nhau bang dau phay (vi du 900001,900002).', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;
end;

{ Chay scripts\install-server.ps1 tu goi da giai nen. Loi (throw) -> ma thoat khac 0, ghi vao logs\install.log. }
procedure RunInstallScript;
var
  RC: Integer;
  Pkg, Args, LogFile, Hook, Map, Tfs: String;
begin
  Pkg := ExpandConstant('{tmp}\ocean-pkg');
  ForceDirectories(ExpandConstant('{commonappdata}\OceanRelay\logs'));
  LogFile := ExpandConstant('{commonappdata}\OceanRelay\logs\install.log');
  Args := '-NoProfile -ExecutionPolicy Bypass -File "' + Pkg + '\scripts\install-server.ps1" -InstallDir "' + ExpandConstant('{app}') +
    '" -Port ' + IntToStr(PortValue) + ' -ConnectCode "' + CleanCode(ConnPage.Values[0]) + '"';
  if Trim(ConnPage.Values[1]) <> '' then Args := Args + ' -Accounts "' + CleanAccounts(Trim(ConnPage.Values[1])) + '"';
  Hook := ExpandConstant('{param:WEBHOOKKEY|}');
  if Hook <> '' then Args := Args + ' -WebhookKey "' + Hook + '"';
  if ExpandConstant('{param:GATEWAY|1}') = '0' then Args := Args + ' -NoGateway';
  Map := ExpandConstant('{param:SYMBOLMAP|}');
  if Map <> '' then Args := Args + ' -SymbolMap "' + Map + '"';
  Tfs := ExpandConstant('{param:TFS|}');
  if Tfs <> '' then Args := Args + ' -Tfs "' + Tfs + '"';
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
      'Bo cai se cai Server, Gateway va EA cho MT5 tren may nay, tu khoi dong cung may. Ban chi can dan Ma ket noi.' + #13#10#13#10 +
      'Sau khi cai, lam 2 viec trong MT5 (bo cai se nhac lai o cuoi): them http://127.0.0.1:47800 vao Allow WebRequest, ' +
      'va keo EA OceanRelay len mot chart.';
  if (CurPageID = wpFinished) and (not WizardSilent) then
    WizardForm.FinishedLabel.Caption :=
      'OCEAN Relay da chay va tu khoi dong cung may.' + #13#10#13#10 +
      'Con 2 viec trong MT5 (lam mot lan):' + #13#10 +
      '1) Tools > Options > Expert Advisors > Allow WebRequest > them  http://127.0.0.1:47800' + #13#10 +
      '2) Keo EA OceanRelay (Navigator) len MOT chart. Mac dinh EA chi theo doi; bat InpAllowTrading khi san sang (thu tren DEMO truoc).' + #13#10#13#10 +
      'Xem tin hieu: http://127.0.0.1:' + IntToStr(PortValue) + '/' + #13#10 +
      'Kiem tra nhanh: scripts\check-vps.ps1 trong thu muc cai.' + #13#10 +
      'Log cai dat: C:\ProgramData\OceanRelay\logs\install.log';
end;
