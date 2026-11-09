//+------------------------------------------------------------------+
//| OceanRelay.mq5  v0.1.0  (DANH LENH THEO TIN HIEU)                |
//| Ping Gateway cuc bo moi InpPingSec giay: gui tai khoan + lenh    |
//| dang mo, nhan tin hieu OCEAN (da duoc Gateway kiem chu ky HMAC), |
//| mo 3 lenh cung Entry/SL voi TP1/TP2/TP3, ack ket qua.            |
//| EA chi noi chuyen voi Gateway/Server tren VPS (khong goi Worker).|
//| MAC DINH InpAllowTrading=false: chi theo doi, KHONG dat lenh.    |
//| Chua duoc bien dich tren MT5 that: thu tren DEMO truoc.          |
//| Dat http://127.0.0.1:47860 vao Tools > Options > Expert Advisors |
//| > Allow WebRequest for listed URL (doi cong thi sua InpGateway). |
//+------------------------------------------------------------------+
#property copyright "Ocean Relay"
#property version "1.00"
#property strict

#include <Trade\Trade.mqh>

#define EA_VER "0.1.0"

input string InpGateway = "http://127.0.0.1:47860";  // Gateway cuc bo (phai nam trong Allow WebRequest)
input int    InpPingSec = 2;                         // Nhip ping (giay, toi thieu 1)
input int    InpTimeoutMs = 1500;                    // Timeout WebRequest (ms)
input string InpTerminalId = "";                     // De trong = login@server
input bool   InpAutoSymbol = true;                   // Ten symbol khong khop thi tim ten gan nhat o san (XAUUSD -> XAUUSDm, XAUUSD.a ...)

input group "=== DANH LENH (mac dinh TAT) ==="
input bool   InpAllowTrading = false;                // CONG TAC TONG: false = chi theo doi, khong dat lenh
input double InpLotPerOrder  = 0.01;                 // Lot moi lenh (moi tin hieu mo 3 lenh = 3 x lot nay)
input double InpMaxTotalLots = 0.30;                 // Tong lot cac lenh dang mo cua EA (magic nay) toi da
input int    InpMaxAgeSec    = 60;                   // Bo tin hieu cu hon so giay nay
input int    InpMaxDevPoints = 500;                  // Bo neu gia hien tai lech Entry qua so point nay (0 = khong kiem)
input int    InpSlippagePts  = 30;                   // Truot gia toi da khi khop (point)
input bool   InpTP3Only      = false;                // true: chi mo 1 lenh toan bo (lot x3) voi TP3
input long   InpMagic        = 20261109;             // Magic number cua EA (de nhan lenh cua chinh no)
input string InpComment      = "OCEAN";              // Tien to comment lenh

string   g_acks = "";            // "12:received,13:received" gui kem o ping ke tiep
ulong    g_seen[64];             // id tin hieu da xu ly (tranh log lap khi Gateway giao lai truoc khi ack toi noi)
int      g_seenN = 0;
ulong    g_nextPingMs = 0;
int      g_fail = 0;
string   g_last = "chua co tin hieu";
CTrade   g_trade;

//+------------------------------------------------------------------+
int OnInit()
  {
   if(MQLInfoInteger(MQL_TESTER)) { Print("OceanRelay: khong chay trong Strategy Tester."); return INIT_FAILED; }
   if(!EventSetTimer(1)) { Print("OceanRelay: EventSetTimer that bai"); return INIT_FAILED; }
   // Tre ngau nhien 0-2 giay truoc ping dau de nhieu EA khong ban cung luc.
   g_nextPingMs = GetTickCount64() + (ulong)(MathRand() % 2000);
   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(InpSlippagePts);
   g_trade.SetAsyncMode(false);
   Print("OceanRelay ", EA_VER, " san sang. Gateway=", InpGateway, InpAllowTrading ? " | DANH LENH: BAT" : " | DANH LENH: TAT (chi theo doi)");
   if(InpAllowTrading && !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) Print("OceanRelay: CANH BAO - Algo Trading dang tat tren terminal.");
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
//| Id tin hieu da xu ly: ghi vao Global Variable TRUOC khi goi san, |
//| nen EA khoi dong lai / Gateway giao lai deu khong mo lenh lan 2. |
//+------------------------------------------------------------------+
string GvName(ulong id) { return "OCEAN_" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "_" + (string)id; }
bool Done(ulong id) { return GlobalVariableCheck(GvName(id)); }
void MarkDone(ulong id) { GlobalVariableSet(GvName(id), (double)TimeCurrent()); }

//+------------------------------------------------------------------+
//| Dong tin hieu:                                                   |
//|  S|id|side|symbol|tf|entry|sl|tp1|tp2|tp3|ageSec                 |
//|  U|id|side|status|symbol|tf|entry|sl|tp|ageSec                   |
//| Ket qua ack: opened:N | trading_off | too_old | price_dev |       |
//|  bad_levels | bad_stops | no_symbol | max_lots | failed:<ma>      |
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
      if(Seen(id) || Done(id)) { AddAck(id, "received"); continue; }
      Remember(id);
      string res = "received";
      if(f[0] == "S" && nf >= 11)
         res = OnEntrySignal(id, f[2], f[3], f[4], StringToDouble(f[5]), StringToDouble(f[6]),
                             StringToDouble(f[7]), StringToDouble(f[8]), StringToDouble(f[9]), (int)StringToInteger(f[10]));
      else if(f[0] == "U" && nf >= 10)
         OnUpdateSignal(id, f[2], f[3], f[4], f[5], StringToDouble(f[6]), StringToDouble(f[7]), StringToDouble(f[8]));
      AddAck(id, res);
     }
  }

double TotalOpenLots()
  {
   double t = 0;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0 || !PositionSelectByTicket(tk)) continue;
      if(PositionGetInteger(POSITION_MAGIC) == InpMagic) t += PositionGetDouble(POSITION_VOLUME);
     }
   return t;
  }

double NormVol(string sym, double v)
  {
   double mn = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), mx = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), st = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(st <= 0) st = 0.01;
   v = MathFloor(v / st + 1e-9) * st;
   return NormalizeDouble(MathMax(mn, MathMin(mx, v)), 2);
  }

//+------------------------------------------------------------------+
//| Tim ten symbol dung o san cho ten tu tin hieu.                   |
//| 1) Ten khop CHINH XAC thi dung luon (Gateway da map neu co).     |
//| 2) Khong co: tim symbol bat dau bang ten do va chi them toi da 4 |
//|    ky tu (hau to cua san: m, .a, _i, pro...). Chon ten NGAN NHAT;|
//|    neu co hai ten cung do dai thi coi la mo ho va KHONG danh.    |
//| Tra ve "" neu khong co hoac mo ho. Ket qua duoc nho lai.         |
//+------------------------------------------------------------------+
string g_symKey[16];
string g_symVal[16];
int    g_symN = 0;

string ResolveSymbol(string want)
  {
   for(int i = 0; i < g_symN; i++) if(g_symKey[i] == want) return g_symVal[i];
   string found = "";
   if(SymbolSelect(want, true)) found = want;
   else if(InpAutoSymbol)
     {
      string up = want; StringToUpper(up);
      int wl = StringLen(up), total = SymbolsTotal(false), bestLen = 1000, ties = 0;
      for(int i = 0; i < total; i++)
        {
         string nm = SymbolName(i, false), u = nm; StringToUpper(u);
         int l = StringLen(u);
         if(l <= wl || l > wl + 4 || StringFind(u, up) != 0) continue;
         if(l < bestLen) { bestLen = l; found = nm; ties = 1; }
         else if(l == bestLen) ties++;
        }
      if(ties > 1) { Print("OceanRelay: ten symbol ", want, " mo ho o san nay (nhieu ten gan giong) -> khong danh, dat OCEAN_SYMBOL_MAP o Gateway"); found = ""; }
      else if(found != "" && !SymbolSelect(found, true)) found = "";
      if(found != "") Print("OceanRelay: tu dong ghep ", want, " -> ", found);
     }
   if(g_symN < 16) { g_symKey[g_symN] = want; g_symVal[g_symN] = found; g_symN++; }
   return found;
  }

//+------------------------------------------------------------------+
//| Mo 3 lenh (hoac 1 lenh neu InpTP3Only) cung SL, TP1/TP2/TP3.     |
//| Tra ve chuoi ket qua de ack. Moi buoc chan deu tra ve ma ro rang.|
//+------------------------------------------------------------------+
string OnEntrySignal(ulong id, string side, string symbol, string tf, double entry, double sl,
                     double tp1, double tp2, double tp3, int ageSec)
  {
   g_last = StringFormat("#%I64u %s %s %s entry=%.2f sl=%.2f tp1=%.2f tp2=%.2f tp3=%.2f (%ds)", id, side, symbol, tf, entry, sl, tp1, tp2, tp3, ageSec);
   Print("OceanRelay TIN HIEU: ", g_last);
   if(!InpAllowTrading) return "trading_off";
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) { Print("OceanRelay: Algo Trading tat"); return "trading_off"; }
   if(ageSec > InpMaxAgeSec) { Print("OceanRelay: bo #", id, " qua cu (", ageSec, "s)"); return "too_old"; }
   string sigSymbol = symbol;
   symbol = ResolveSymbol(sigSymbol);
   if(symbol == "") { Print("OceanRelay: khong co symbol ", sigSymbol, " o san nay (kiem OCEAN_SYMBOL_MAP o Gateway)"); return "no_symbol"; }

   bool buy = (side == "buy");
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK), bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   double pt = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int dg = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(ask <= 0 || bid <= 0 || pt <= 0) return "no_symbol";
   double px = buy ? ask : bid;

   if(InpMaxDevPoints > 0 && MathAbs(px - entry) > InpMaxDevPoints * pt)
     { Print("OceanRelay: bo #", id, " gia lech Entry ", DoubleToString(MathAbs(px - entry) / pt, 0), " point"); return "price_dev"; }
   // SL/TP phai dung phia so voi GIA HIEN TAI (Server da kiem phia theo Entry, day la kiem lan 2 theo gia that)
   bool ok = buy ? (sl < px && tp1 > px && tp1 <= tp2 && tp2 <= tp3) : (sl > px && tp1 < px && tp1 >= tp2 && tp2 >= tp3);
   if(!ok) { Print("OceanRelay: bo #", id, " SL/TP sai phia so voi gia hien tai"); return "bad_levels"; }
   double minDist = (double)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL) * pt;
   if(MathAbs(px - sl) < minDist || MathAbs(tp1 - px) < minDist) { Print("OceanRelay: bo #", id, " SL/TP gan hon stops level"); return "bad_stops"; }

   int n = InpTP3Only ? 1 : 3;
   double lotEach = NormVol(symbol, InpTP3Only ? InpLotPerOrder * 3 : InpLotPerOrder);
   if(TotalOpenLots() + lotEach * n > InpMaxTotalLots + 1e-9) { Print("OceanRelay: bo #", id, " vuot InpMaxTotalLots"); return "max_lots"; }

   // Ghi nho id TRUOC khi goi san: loi giua chung thi khong bao gio mo lap.
   MarkDone(id);
   g_trade.SetTypeFillingBySymbol(symbol);
   double tps[3]; tps[0] = tp1; tps[1] = tp2; tps[2] = tp3;
   int opened = 0; uint lastRc = 0;
   for(int k = 0; k < n; k++)
     {
      double tp = InpTP3Only ? tp3 : tps[k];
      string cm = StringFormat("%s#%I64u/TP%d", InpComment, id, InpTP3Only ? 3 : k + 1);
      bool sent = buy ? g_trade.Buy(lotEach, symbol, 0, NormalizeDouble(sl, dg), NormalizeDouble(tp, dg), cm)
                      : g_trade.Sell(lotEach, symbol, 0, NormalizeDouble(sl, dg), NormalizeDouble(tp, dg), cm);
      lastRc = g_trade.ResultRetcode();
      if(sent && (lastRc == TRADE_RETCODE_DONE || lastRc == TRADE_RETCODE_PLACED)) opened++;
      else Print("OceanRelay: lenh TP", k + 1, " that bai retcode=", lastRc, " ", g_trade.ResultRetcodeDescription());
     }
   Print("OceanRelay: #", id, " da mo ", opened, "/", n, " lenh");
   if(opened == 0) return "failed:" + (string)lastRc;
   return "opened:" + (string)opened;
  }

// Khuon cap nhat (closeStatus): chua biet gia tri cu the nen CHI GHI NHAN, khong tu dong dong/doi SL.
void OnUpdateSignal(ulong id, string side, string status, string symbol, string tf, double entry, double sl, double tp)
  {
   g_last = StringFormat("#%I64u CAP NHAT %s %s %s %s", id, side, status, symbol, tf);
   Print("OceanRelay CAP NHAT: ", g_last);
  }

void UpdateComment(bool ok)
  {
   Comment("OceanRelay ", EA_VER, InpAllowTrading ? "  [DANH LENH: BAT]" : "  [CHI THEO DOI]", "\n",
           ok ? "Gateway: OK" : "Gateway: LOI (xem tab Experts)", "\n",
           "Tin hieu cuoi: ", g_last);
  }
