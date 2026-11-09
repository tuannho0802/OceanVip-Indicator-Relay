//+------------------------------------------------------------------+
//| OceanRelay.mq5  v0.1.0  (GIAI DOAN 1: TRACKING, CHUA DANH LENH)  |
//| Ping Gateway cuc bo moi InpPingSec giay: gui tai khoan + lenh    |
//| dang mo, nhan tin hieu OCEAN, ghi log va ack "received".         |
//| KHONG gui lenh len san. Chua duoc bien dich tren MT5 that.       |
//| Dat http://127.0.0.1:47800 vao Tools > Options > Expert Advisors |
//| > Allow WebRequest for listed URL.                               |
//+------------------------------------------------------------------+
#property copyright "Ocean Relay"
#property version "1.0"
#property strict

#define EA_VER "0.1.0"

input string InpGateway = "http://127.0.0.1:47800"; // Gateway cuc bo (phai nam trong Allow WebRequest)
input int    InpPingSec = 2;                         // Nhip ping (giay, toi thieu 1)
input int    InpTimeoutMs = 1500;                    // Timeout WebRequest (ms)
input string InpTerminalId = "";                     // De trong = login@server

string   g_acks = "";            // "12:received,13:received" gui kem o ping ke tiep
ulong    g_seen[64];             // id tin hieu da xu ly (tranh log lap khi Gateway giao lai truoc khi ack toi noi)
int      g_seenN = 0;
ulong    g_nextPingMs = 0;
int      g_fail = 0;
string   g_last = "chua co tin hieu";

//+------------------------------------------------------------------+
int OnInit()
  {
   if(MQLInfoInteger(MQL_TESTER)) { Print("OceanRelay: khong chay trong Strategy Tester."); return INIT_FAILED; }
   if(!EventSetTimer(1)) { Print("OceanRelay: EventSetTimer that bai"); return INIT_FAILED; }
   // Tre ngau nhien 0-2 giay truoc ping dau de nhieu EA khong ban cung luc.
   g_nextPingMs = GetTickCount64() + (ulong)(MathRand() % 2000);
   Print("OceanRelay ", EA_VER, " san sang. Gateway=", InpGateway, " (chi tracking, khong danh lenh)");
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); Comment(""); }

void OnTimer()
  {
   ulong now = GetTickCount64();
   if(now < g_nextPingMs) return;
   int gap = MathMax(1, InpPingSec) * 1000;
   // Gateway hong: giãn nhip toi da 15 giay de khong spam.
   if(g_fail > 0) gap = MathMin(15000, gap * (1 + g_fail));
   g_nextPingMs = now + (ulong)gap;
   Ping();
  }

//+------------------------------------------------------------------+
//| Gom lenh dang mo: ticket,symbol,side,vol,open,sl,tp,profit;...  |
//+------------------------------------------------------------------+
string BuildPositions()
  {
   string s = "";
   int n = MathMin(PositionsTotal(), 50);
   for(int i = 0; i < n; i++)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0 || !PositionSelectByTicket(tk)) continue;
      string side = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "buy" : "sell";
      string sym = PositionGetString(POSITION_SYMBOL);
      StringReplace(sym, ",", "_"); StringReplace(sym, ";", "_");
      s += StringFormat("%I64u,%s,%s,%.2f,%s,%s,%s,%.2f;", tk, sym, side,
            PositionGetDouble(POSITION_VOLUME),
            DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), (int)SymbolInfoInteger(PositionGetString(POSITION_SYMBOL), SYMBOL_DIGITS)),
            DoubleToString(PositionGetDouble(POSITION_SL), (int)SymbolInfoInteger(PositionGetString(POSITION_SYMBOL), SYMBOL_DIGITS)),
            DoubleToString(PositionGetDouble(POSITION_TP), (int)SymbolInfoInteger(PositionGetString(POSITION_SYMBOL), SYMBOL_DIGITS)),
            PositionGetDouble(POSITION_PROFIT));
     }
   return s;
  }

//+------------------------------------------------------------------+
void Ping()
  {
   string body = "";
   body += "login=" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "\n";
   body += "server=" + AccountInfoString(ACCOUNT_SERVER) + "\n";
   if(InpTerminalId != "") body += "tid=" + InpTerminalId + "\n";
   body += "bal=" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "\n";
   body += "eq=" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "\n";
   body += "mg=" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + "\n";
   body += "fm=" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + "\n";
   body += "ver=" + EA_VER + "\n";
   body += "pos=" + BuildPositions() + "\n";
   body += "acks=" + g_acks + "\n";
   string sentAcks = g_acks;

   char data[], result[];
   string rh;
   int n = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0) ArrayResize(data, n - 1); // bo ky tu NUL cuoi
   ResetLastError();
   int code = WebRequest("POST", InpGateway + "/v1/ping", "Content-Type: text/plain\r\n", InpTimeoutMs, data, result, rh);
   if(code != 200)
     {
      g_fail++;
      if(g_fail == 1 || g_fail % 20 == 0)
         Print("OceanRelay: Gateway loi, HTTP=", code, " err=", GetLastError(), " (kiem tra Allow WebRequest va Gateway)");
      UpdateComment(false);
      return;
     }
   g_fail = 0;
   // Gateway da nhan ack nay: bo khoi danh sach (chi bo phan da gui, giu phan phat sinh them).
   if(sentAcks != "" && StringFind(g_acks, sentAcks) == 0) g_acks = StringSubstr(g_acks, StringLen(sentAcks));
   if(StringLen(g_acks) > 0 && StringGetCharacter(g_acks, 0) == ',') g_acks = StringSubstr(g_acks, 1);
   HandleResponse(CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8));
   UpdateComment(true);
  }

//+------------------------------------------------------------------+
bool Seen(ulong id)
  {
   for(int i = 0; i < g_seenN; i++) if(g_seen[i] == id) return true;
   return false;
  }
void Remember(ulong id)
  {
   if(g_seenN < 64) { g_seen[g_seenN++] = id; return; }
   for(int i = 1; i < 64; i++) g_seen[i - 1] = g_seen[i];
   g_seen[63] = id;
  }
void AddAck(ulong id, string result)
  {
   if(g_acks != "") g_acks += ",";
   g_acks += (string)id + ":" + result;
  }

//+------------------------------------------------------------------+
//| Dong tin hieu:                                                   |
//|  S|id|side|symbol|tf|entry|sl|tp1|tp2|tp3|ageSec                 |
//|  U|id|side|status|symbol|tf|entry|sl|tp|ageSec                   |
//+------------------------------------------------------------------+
void HandleResponse(string text)
  {
   string lines[];
   int nl = StringSplit(text, '\n', lines);
   for(int i = 1; i < nl; i++) // dong 0 la "OK"
     {
      string f[];
      int nf = StringSplit(lines[i], '|', f);
      if(nf < 3) continue;
      ulong id = (ulong)StringToInteger(f[1]);
      if(id == 0) continue;
      if(Seen(id)) { AddAck(id, "received"); continue; }
      Remember(id);
      if(f[0] == "S" && nf >= 11)
         OnEntrySignal(id, f[2], f[3], f[4], StringToDouble(f[5]), StringToDouble(f[6]),
                       StringToDouble(f[7]), StringToDouble(f[8]), StringToDouble(f[9]), (int)StringToInteger(f[10]));
      else if(f[0] == "U" && nf >= 10)
         OnUpdateSignal(id, f[2], f[3], f[4], f[5], StringToDouble(f[6]), StringToDouble(f[7]), StringToDouble(f[8]));
      AddAck(id, "received"); // GIAI DOAN 1: chi xac nhan da nhan, chua danh lenh
     }
  }

// GIAI DOAN 2 se mo 3 lenh o day (cung entry/SL, TP1/TP2/TP3). Hien tai chi ghi nhan.
void OnEntrySignal(ulong id, string side, string symbol, string tf, double entry, double sl,
                   double tp1, double tp2, double tp3, int ageSec)
  {
   g_last = StringFormat("#%I64u %s %s %s entry=%.2f sl=%.2f tp1=%.2f tp2=%.2f tp3=%.2f (%ds)", id, side, symbol, tf, entry, sl, tp1, tp2, tp3, ageSec);
   Print("OceanRelay TIN HIEU: ", g_last);
  }

void OnUpdateSignal(ulong id, string side, string status, string symbol, string tf, double entry, double sl, double tp)
  {
   g_last = StringFormat("#%I64u CAP NHAT %s %s %s %s", id, side, status, symbol, tf);
   Print("OceanRelay CAP NHAT: ", g_last);
  }

void UpdateComment(bool ok)
  {
   Comment("OceanRelay ", EA_VER, "  [TRACKING]\n",
           ok ? "Gateway: OK" : "Gateway: LOI (xem tab Experts)", "\n",
           "Tin hieu cuoi: ", g_last);
  }
