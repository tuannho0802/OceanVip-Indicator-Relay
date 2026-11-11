//+------------------------------------------------------------------+
//| OceanRelay.mq5  v0.3.0  (DANH LENH + RETRY + KHOP DUNG GIA)     |
//| Ping Gateway cuc bo moi InpPingSec giay: gui tai khoan + lenh    |
//| dang mo, nhan tin hieu OCEAN (da duoc Gateway kiem chu ky HMAC), |
//| mo 3 lenh cung Entry/SL voi TP1/TP2/TP3, ack ket qua.            |
//| v0.3.0: mat ket noi may chu giao dich (retcode 6/10031...) thi   |
//| THU LAI cho du 3 lenh TP1/2/3 neu gia con trong sai so; gia lech |
//| Entry qua InpMaxDevPips thi KHONG danh (kiem tung lenh, kiem lai |
//| ca gia khop sau khi vao).                                        |
//| BreakEven (tuy chon, mac dinh TAT): khi lenh TP1 (hoac TP2) chot |
//| lai thi doi SL cac lenh con lai ve gan gia vao N don vi.         |
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

#define EA_VER "0.3.0"

input string InpGateway = "http://127.0.0.1:47860";  // Gateway cuc bo (phai nam trong Allow WebRequest)
input int    InpPingSec = 2;                         // Nhip ping (giay, toi thieu 1)
input int    InpTimeoutMs = 1500;                    // Timeout WebRequest (ms)
input string InpTerminalId = "";                     // De trong = login@server
input bool   InpAutoSymbol = true;                   // Ten symbol khong khop thi tim ten gan nhat o san (XAUUSD -> XAUUSDm, XAUUSD.a ...)

enum ENUM_BE_TRIGGER { BE_AFTER_TP1 = 1,
                       BE_AFTER_TP2 = 2 };
enum ENUM_BE_UNIT { BE_UNIT_PRICE = 0,
                    BE_UNIT_PIPS = 1 };

input group "=== DANH LENH (mac dinh TAT) ==="
input bool   InpAllowTrading = false;                // CONG TAC TONG: false = chi theo doi, khong dat lenh
input double InpLotPerOrder  = 0.01;                 // Lot moi lenh (moi tin hieu mo 3 lenh = 3 x lot nay)
input double InpMaxTotalLots = 0.30;                 // Tong lot cac lenh dang mo cua EA (magic nay) toi da
input int    InpMaxAgeSec    = 60;                   // Bo tin hieu cu hon so giay nay
input double InpMaxDevPips   = 10.0;                 // Sai so cho phep so voi gia Entry cua Signal (pip; vang: 1 pip = 0.1 gia nen 10 pip = 1.0 gia). Gia lech hon thi KHONG danh. 0 = khong kiem
input int    InpPipPoints    = 0;                    // So point trong 1 pip (0 = tu dong: 10 point; vang 3 so le gia >= 1000 la 100 point)
input int    InpSlippagePts  = 30;                   // Truot gia toi da khi khop (point); thuc te con bi gioi han boi phan sai so con lai cua InpMaxDevPips
input bool   InpCloseBadFill = false;                // Lenh khop lech Entry qua InpMaxDevPips (san bo qua truot gia): true = dong lenh do ngay; false = chi canh bao va ngung mo not cac lenh con lai
input int    InpRetrySec     = 1;                    // Loi tam thoi khi vao lenh (mat ket noi, requote, timeout...): thu lai moi so giay nay
input int    InpRetryMaxSec  = 120;                  // Thu lai toi da so giay ke tu khi nhan tin hieu (het han thi bo; gia di qua InpMaxDevPips thi bo ngay)
input bool   InpTP3Only      = false;                // true: chi mo 1 lenh toan bo (lot x3) voi TP3
input long   InpMagic        = 20261109;             // Magic number cua EA (de nhan lenh cua chinh no)
input string InpComment      = "OCEAN";              // Tien to comment lenh

input group "=== BREAKEVEN (mac dinh TAT) ===" input bool InpBEEnable = false; // BAT/TAT BreakEven (chi hoat dong khi InpAllowTrading = true)
input ENUM_BE_TRIGGER InpBETrigger = BE_AFTER_TP1;                             // Kich hoat khi: TP1 chot lai (doi SL TP2+TP3) hoac TP2 chot lai (doi SL TP3)
input double InpBEOffset = 3.0;                                                // N: khoang cach tu GIA VAO toi SL moi (>= 0)
input ENUM_BE_UNIT InpBEUnit = BE_UNIT_PRICE;                                  // Don vi N: GIA (XAUUSD: 3.0 = 3 USD) hoac PIP (1 pip = 10 point)
input bool InpBELockProfit = false;                                            // false: SL phia LO (BUY: Entry-N, SELL: Entry+N). true: khoa lai (BUY: Entry+N, SELL: Entry-N)

string   g_acks = "";            // "12:received,13:received" gui kem o ping ke tiep
ulong    g_seen[64];             // id tin hieu da xu ly (tranh log lap khi Gateway giao lai truoc khi ack toi noi)
int      g_seenN = 0;
ulong    g_nextPingMs = 0;
int      g_fail = 0;
string   g_last = "chua co tin hieu";
CTrade   g_trade;

// Mot tin hieu dang vao lenh (3 chan TP1/TP2/TP3, hoac 1 chan neu InpTP3Only). Chan nao chua mo duoc vi loi tam thoi se duoc thu lai.
struct RetryJob
  {
   ulong    id;
   bool     buy;
   string   symbol;
   double   entry;
   double   sl;
   double   tp1;
   double   tp2;
   double   tp3;
   double   lot;
   int      n;          // so chan can mo (3, hoac 1 neu InpTP3Only)
   int      seq;        // so thu tu lenh trong ngay (comment OCEAN#seq/TPn), 0 = chua cap
   int      seqDay;
   bool     marked;     // da ghi Global Variable chong mo lap
   int      doneMask;   // bit k = chan k da mo
   int      dropMask;   // bit k = chan k bo han (khong thu lai nua)
   int      tries;
   uint     lastRc;
   string   why;        // ly do (ma ack) khi chua mo du
   ulong    deadlineMs;
   ulong    nextMs;
  };
#define MAX_JOBS 16
RetryJob g_jobs[MAX_JOBS];
int      g_jobN = 0;

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
   Print("OceanRelay ", EA_VER, " san sang. Gateway=", InpGateway, InpAllowTrading ? " | DANH LENH: BAT" : " | DANH LENH: TAT (chi theo doi)",
         " | BREAKEVEN: ", BeLabel(),
         " | SAI SO GIA: ", InpMaxDevPips > 0 ? DoubleToString(InpMaxDevPips, 1) + " pip" : "khong kiem",
         " | RETRY: moi ", IntegerToString(InpRetrySec), "s, toi da ", IntegerToString(InpRetryMaxSec), "s");
   if(InpAllowTrading && !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) Print("OceanRelay: CANH BAO - Algo Trading dang tat tren terminal.");
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); Comment(""); }

void OnTimer()
  {
    ProcessRetries();  // moi giay: thu lai cac chan lenh chua mo duoc (mat ket noi may chu giao dich...)
    ManageBreakEven(); // moi giay, doc lap voi nhip ping Gateway
    ulong now = GetTickCount64();
    if (now < g_nextPingMs)
        return;
    int gap = MathMax(1, InpPingSec) * 1000;
    // Gateway hong: giãn nhip toi da 15 giay de khong spam.
    if (g_fail > 0)
        gap = MathMin(15000, gap * (1 + g_fail));
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
//| So thu tu lenh THEO NGAY (comment: <InpComment>#<so>/TPn).       |
//| Moi ngay (gio server) bat dau lai tu 1, khong dem vo han theo id |
//| tin hieu cua Server. Bo dem luu o Global Variable                |
//| OCEANSEQ_<login> = yyyymmdd*10000 + so, nen khoi dong lai EA van |
//| dem tiep dung. Id tin hieu that van dung de chong mo lenh lap.   |
//+------------------------------------------------------------------+
int DayOf(datetime t)
  {
   MqlDateTime m;
   TimeToStruct(t, m);
   return m.year * 10000 + m.mon * 100 + m.day;
  }

string SeqGv() { return "OCEANSEQ_" + (string)AccountInfoInteger(ACCOUNT_LOGIN); }

int NextSeq(int &day)
  {
   day = DayOf(TimeCurrent());
   double v = GlobalVariableCheck(SeqGv()) ? GlobalVariableGet(SeqGv()) : 0.0;
   int vd = (int)MathFloor(v / 10000.0);
   int n = (vd == day) ? (int)MathRound(v - (double)vd * 10000.0) : 0;
   n = (n >= 9999) ? 1 : n + 1;
   GlobalVariableSet(SeqGv(), (double)day * 10000.0 + (double)n);
   return n;
  }

//+------------------------------------------------------------------+
//| KHOP DUNG GIA SIGNAL + THU LAI KHI MAT KET NOI                   |
//|                                                                  |
//| Cac bien phap de lenh khop tai vi tri Signal (sai so cho phep la |
//| InpMaxDevPips, vi du 10 pip = 1.0 gia vang; lech hon thi KHONG   |
//| danh):                                                           |
//|  1) Moi lan thu (ke ca thu lai) doc GIA MOI roi moi kiem: mua    |
//|     so voi Ask, ban so voi Bid. Lech > sai so thi bo.            |
//|  2) Kiem rieng TUNG chan lenh: gia da di qua TP cua chan do thi  |
//|     bo chan do, khong gui lenh sai phia.                         |
//|  3) Truot gia gui kem lenh = phan sai so con lai (theo huong bat |
//|     loi), toi da InpSlippagePts, de san tu choi neu gia chay qua.|
//|  4) Sau khi khop doc lai GIA KHOP: lech Entry qua sai so (san bo |
//|     qua truot gia) thi canh bao, ngung mo not cac chan con lai,  |
//|     va dong lenh do neu InpCloseBadFill = true.                  |
//|  5) Truoc moi lan thu lai kiem lenh cua chan do da vao san chua  |
//|     (timeout nhung lenh da khop) de khong mo lap.                |
//|                                                                  |
//| Loi tam thoi (mat ket noi retcode 6 / 10031, requote, timeout,   |
//| off quotes...): chan chua mo duoc thu lai moi InpRetrySec giay,  |
//| toi da InpRetryMaxSec giay, cho den khi du 3 lenh TP1/TP2/TP3,   |
//| gia di qua sai so, hoac het han. Ack: retry:D/N khi dang thu lai,|
//| ket thuc: opened:N | partial:D/N_<ly do> | <ma loi>.             |
//+------------------------------------------------------------------+
double PipSize(string sym)
  {
   double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
   int pp = InpPipPoints;
   if(pp <= 0)
     {
      pp = 10;
      if((int)SymbolInfoInteger(sym, SYMBOL_DIGITS) == 3 && SymbolInfoDouble(sym, SYMBOL_BID) >= 1000.0) pp = 100; // vang 3 so le: 1 pip = 0.1 gia
     }
   return pt * pp;
  }

double TolPrice(string sym) { return InpMaxDevPips > 0 ? InpMaxDevPips * PipSize(sym) : 0.0; }

// Loi tam thoi: dang thu lai duoc. 6/8/128/135-138/146 la ma kieu MT4 ma mot so san MT5 van tra ve (6 = no connection with trade server).
bool IsTransientRc(uint rc)
  {
   if(rc == 0 || rc == 6 || rc == 8 || rc == 128 || rc == 135 || rc == 136 || rc == 137 || rc == 138 || rc == 146) return true;
   return rc == TRADE_RETCODE_REQUOTE || rc == TRADE_RETCODE_REJECT || rc == TRADE_RETCODE_TIMEOUT || rc == TRADE_RETCODE_PRICE_CHANGED ||
          rc == TRADE_RETCODE_PRICE_OFF || rc == TRADE_RETCODE_CONNECTION || rc == TRADE_RETCODE_TOO_MANY_REQUESTS ||
          rc == TRADE_RETCODE_ERROR || rc == TRADE_RETCODE_LOCKED;
  }

double LegTp(const RetryJob &j, int k)
  {
   if(InpTP3Only) return j.tp3;
   return (k == 0) ? j.tp1 : ((k == 1) ? j.tp2 : j.tp3);
  }
int LegNo(int k) { return InpTP3Only ? 3 : k + 1; }
int AllMask(const RetryJob &j) { return (1 << j.n) - 1; }
int CountBits(int m)
  {
   int c = 0;
   for(int i = 0; i < 3; i++) if(((m >> i) & 1) != 0) c++;
   return c;
  }
string LegComment(const RetryJob &j, int k) { return StringFormat("%s#%d/TP%d", InpComment, j.seq, LegNo(k)); }

// Chan nay da co lenh o san chua (dang mo, hoac vua mo trong 1 gio qua): tranh mo lap khi lan gui truoc bi timeout nhung lenh van khop.
bool LegExists(const RetryJob &j, int k)
  {
   if(j.seq <= 0) return false;
   string want = LegComment(j, k);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0 || !PositionSelectByTicket(tk)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      if(PositionGetString(POSITION_COMMENT) != want) continue;
      if(DayOf((datetime)PositionGetInteger(POSITION_TIME)) == j.seqDay) return true;
     }
   if(HistorySelect(TimeCurrent() - 3600, TimeCurrent() + 60))
     {
      for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
        {
         ulong d = HistoryDealGetTicket(i);
         if(d == 0) continue;
         if(HistoryDealGetInteger(d, DEAL_MAGIC) != InpMagic) continue;
         if(HistoryDealGetInteger(d, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
         if(HistoryDealGetString(d, DEAL_COMMENT) != want) continue;
         if(DayOf((datetime)HistoryDealGetInteger(d, DEAL_TIME)) == j.seqDay) return true;
        }
     }
   return false;
  }

void CloseLeg(const RetryJob &j, int k)
  {
   string want = LegComment(j, k);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0 || !PositionSelectByTicket(tk)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      if(PositionGetString(POSITION_COMMENT) != want) continue;
      if(g_trade.PositionClose(tk)) Print("OceanRelay: da dong lenh ", want, " ticket ", tk, " vi khop lech Entry qua sai so");
      else Print("OceanRelay: KHONG dong duoc lenh ", want, " ticket ", tk, " retcode=", g_trade.ResultRetcode(), " ", g_trade.ResultRetcodeDescription());
      return;
     }
  }

// Chuoi ack cua job: du lenh = opened:N; dang cho thu lai = retry:D/N; ket thuc thieu = partial:D/N_<ly do>; khong mo duoc lenh nao = <ly do>.
string JobResult(const RetryJob &j, bool pending)
  {
   int d = CountBits(j.doneMask);
   if(pending) return "retry:" + IntegerToString(d) + "/" + IntegerToString(j.n);
   if(d == j.n) return "opened:" + IntegerToString(d);
   string w = j.why;
   if(w == "") w = "retry_timeout";
   if(d == 0) return w;
   StringReplace(w, ":", "_");
   StringReplace(w, ",", "_");
   return "partial:" + IntegerToString(d) + "/" + IntegerToString(j.n) + "_" + w;
  }

// Mot luot vao lenh cho cac chan chua mo cua job. true = xong (du lenh hoac het cach); false = can thu lai sau.
bool RunJob(RetryJob &j)
  {
   int all = AllMask(j);
   if(GetTickCount64() > j.deadlineMs && j.tries > 0)
     {
      j.dropMask = all & ~j.doneMask;
      if(j.why == "") j.why = "retry_timeout";
      Print("OceanRelay: #", j.id, " het han thu lai (", InpRetryMaxSec, "s), da mo ", CountBits(j.doneMask), "/", j.n);
      return true;
     }
   j.tries++;
   string sym = j.symbol;
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
     { j.why = "trading_off"; j.dropMask = all & ~j.doneMask; Print("OceanRelay: Algo Trading tat"); return true; }
   if(!TerminalInfoInteger(TERMINAL_CONNECTED))
     { j.why = "no_connection"; if(j.tries == 1) Print("OceanRelay: #", j.id, " mat ket noi may chu giao dich, se thu lai"); return false; }

   bool   buy = j.buy;
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK), bid = SymbolInfoDouble(sym, SYMBOL_BID), pt = SymbolInfoDouble(sym, SYMBOL_POINT);
   int    dg  = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   if(ask <= 0 || bid <= 0 || pt <= 0) { j.why = "no_quote"; return false; }
   double px  = buy ? ask : bid;
   double tol = TolPrice(sym);

   // (1) Gia MOI phai con trong sai so so voi Entry cua Signal.
   if(tol > 0 && MathAbs(px - j.entry) > tol + pt / 2)
     {
      j.why = "price_dev";
      j.dropMask = all & ~j.doneMask;
      Print("OceanRelay: bo #", j.id, " gia ", DoubleToString(px, dg), " lech Entry ", DoubleToString(j.entry, dg), " ",
            DoubleToString(MathAbs(px - j.entry) / PipSize(sym), 1), " pip > ", DoubleToString(InpMaxDevPips, 1), " pip (da mo ", CountBits(j.doneMask), "/", j.n, ")");
      return true;
     }
   // SL phai dung phia va du xa so voi GIA HIEN TAI (Server da kiem phia theo Entry, day la kiem lan 2 theo gia that)
   double minDist = (double)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * pt;
   if(!(buy ? (j.sl < px) : (j.sl > px)))
     { j.why = "bad_levels"; j.dropMask = all & ~j.doneMask; Print("OceanRelay: bo #", j.id, " SL sai phia so voi gia hien tai"); return true; }
   if(MathAbs(px - j.sl) < minDist)
     { j.why = "bad_stops"; j.dropMask = all & ~j.doneMask; Print("OceanRelay: bo #", j.id, " SL gan hon stops level"); return true; }

   // Ghi nho id TRUOC khi goi san: loi giua chung thi khong bao gio mo lap (EA khoi dong lai / Gateway giao lai).
   if(!j.marked)
     {
      MarkDone(j.id);
      j.seq = NextSeq(j.seqDay);
      j.marked = true;
      Print("OceanRelay: tin hieu #", j.id, " -> lenh so ", j.seq, " cua ngay ", j.seqDay);
     }
   g_trade.SetTypeFillingBySymbol(sym);

   bool retry = false;
   for(int k = 0; k < j.n && !retry; k++)
     {
      int bit = 1 << k;
      if(((j.doneMask | j.dropMask) & bit) != 0) continue;
      double tp = LegTp(j, k);
      // (2) Kiem rieng tung chan: gia da di qua TP cua chan nay thi bo chan nay.
      if(!(buy ? (tp > px) : (tp < px))) { j.dropMask |= bit; j.why = "bad_levels"; Print("OceanRelay: bo chan TP", LegNo(k), " cua #", j.id, ": gia da di qua TP"); continue; }
      if(MathAbs(tp - px) < minDist)     { j.dropMask |= bit; j.why = "bad_stops";  Print("OceanRelay: bo chan TP", LegNo(k), " cua #", j.id, ": TP gan hon stops level"); continue; }
      // (5) Lenh cua chan nay da vao san roi (lan gui truoc timeout) thi coi nhu da mo.
      if(LegExists(j, k)) { j.doneMask |= bit; Print("OceanRelay: chan TP", LegNo(k), " cua #", j.id, " da co lenh o san"); continue; }
      if(TotalOpenLots() + j.lot > InpMaxTotalLots + 1e-9)
        { j.dropMask |= all & ~j.doneMask; j.why = "max_lots"; Print("OceanRelay: bo #", j.id, " vuot InpMaxTotalLots"); break; }

      // (3) Truot gia = phan sai so con lai theo huong bat loi (mua: khop khong cao hon Entry+sai so; ban: khong thap hon Entry-sai so).
      int dev = InpSlippagePts;
      if(tol > 0)
        {
         double room = buy ? (j.entry + tol - px) : (px - (j.entry - tol));
         dev = MathMin(dev, (int)MathFloor(MathMax(0.0, room) / pt + 1e-9));
        }
      g_trade.SetDeviationInPoints(dev);

      string cm = LegComment(j, k);
      bool sent = buy ? g_trade.Buy(j.lot, sym, 0, NormalizeDouble(j.sl, dg), NormalizeDouble(tp, dg), cm)
                      : g_trade.Sell(j.lot, sym, 0, NormalizeDouble(j.sl, dg), NormalizeDouble(tp, dg), cm);
      uint rc = g_trade.ResultRetcode();
      if(sent && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED))
        {
         j.doneMask |= bit;
         j.lastRc = 0;
         // (4) Doc lai GIA KHOP: lech Entry qua sai so thi ngung mo not (va dong lenh neu InpCloseBadFill).
         double fp = g_trade.ResultPrice();
         if(tol > 0 && fp > 0 && MathAbs(fp - j.entry) > tol + pt / 2)
           {
            Print("OceanRelay: CANH BAO #", j.id, " chan TP", LegNo(k), " khop ", DoubleToString(fp, dg), " lech Entry ", DoubleToString(j.entry, dg), " ",
                  DoubleToString(MathAbs(fp - j.entry) / PipSize(sym), 1), " pip > ", DoubleToString(InpMaxDevPips, 1), " pip -> ngung mo not cac chan con lai");
            if(InpCloseBadFill) CloseLeg(j, k);
            j.dropMask |= all & ~j.doneMask;
            j.why = "fill_dev";
            break;
           }
        }
      else
        {
         j.lastRc = rc;
         j.why = "failed:" + IntegerToString((int)rc);
         Print("OceanRelay: lenh TP", LegNo(k), " cua #", j.id, " that bai retcode=", rc, " ", g_trade.ResultRetcodeDescription(),
               IsTransientRc(rc) ? " -> se thu lai" : "");
         if(IsTransientRc(rc)) { retry = true; break; }
         if(rc == TRADE_RETCODE_INVALID_STOPS) { j.dropMask |= bit; continue; } // chi chan nay sai muc, chan khac van thu
         j.dropMask |= all & ~j.doneMask; // loi khong the khac phuc (het tien, thi truong dong...): ngung
         break;
        }
     }
   if(retry) return false;
   return ((j.doneMask | j.dropMask) & all) == all;
  }

// Moi giay: thu lai cac tin hieu con chan chua mo. Xong thi ack ket qua cuoi (ghi de ack "retry:" truoc do o Server).
void ProcessRetries()
  {
   if(g_jobN == 0) return;
   for(int i = g_jobN - 1; i >= 0; i--)
     {
      if(GetTickCount64() < g_jobs[i].nextMs) continue;
      if(!RunJob(g_jobs[i]))
        {
         g_jobs[i].nextMs = GetTickCount64() + (ulong)MathMax(1, InpRetrySec) * 1000;
         continue;
        }
      string res = JobResult(g_jobs[i], false);
      Print("OceanRelay: #", g_jobs[i].id, " ket thuc: ", res, " (lenh so ", g_jobs[i].seq, ", ", g_jobs[i].tries, " luot)");
      AddAck(g_jobs[i].id, res);
      g_jobs[i] = g_jobs[g_jobN - 1];
      g_jobN--;
     }
  }

//+------------------------------------------------------------------+
//| Vao lenh: 3 lenh (hoac 1 lenh neu InpTP3Only) cung SL, TP1/2/3.  |
//| Kiem thu tu cac dieu kien khong phu thuoc gia thi truong roi     |
//| giao cho RunJob (kiem gia, mo lenh, thu lai).                    |
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
   if(SymbolInfoDouble(symbol, SYMBOL_POINT) <= 0) return "no_symbol";

   bool buy = (side == "buy");
   // Thu tu muc: mua SL < Entry < TP1 <= TP2 <= TP3, ban nguoc lai (kiem gia thi truong nam trong RunJob, kiem lai moi lan thu).
   bool ok = buy ? (sl < entry && entry < tp1 && tp1 <= tp2 && tp2 <= tp3) : (sl > entry && entry > tp1 && tp1 >= tp2 && tp2 >= tp3);
   if(!ok) { Print("OceanRelay: bo #", id, " SL/TP sai phia so voi Entry"); return "bad_levels"; }
   if(g_jobN >= MAX_JOBS) { Print("OceanRelay: bo #", id, " hang doi thu lai day"); return "failed:queue_full"; }

   RetryJob j;
   j.id = id; j.buy = buy; j.symbol = symbol; j.entry = entry; j.sl = sl; j.tp1 = tp1; j.tp2 = tp2; j.tp3 = tp3;
   j.n = InpTP3Only ? 1 : 3;
   j.lot = NormVol(symbol, InpTP3Only ? InpLotPerOrder * 3 : InpLotPerOrder);
   if(TotalOpenLots() + j.lot * j.n > InpMaxTotalLots + 1e-9) { Print("OceanRelay: bo #", id, " vuot InpMaxTotalLots"); return "max_lots"; }
   j.seq = 0; j.seqDay = 0; j.marked = false; j.doneMask = 0; j.dropMask = 0; j.tries = 0; j.lastRc = 0; j.why = "";
   ulong nowMs = GetTickCount64();
   j.deadlineMs = nowMs + (ulong)MathMax(1, InpRetryMaxSec) * 1000;
   j.nextMs = nowMs + (ulong)MathMax(1, InpRetrySec) * 1000;

   if(RunJob(j))
     {
      string res = JobResult(j, false);
      Print("OceanRelay: #", id, " (lenh so ", j.seq, ") ket qua: ", res);
      return res;
     }
   // Chua mo du vi loi tam thoi (mat ket noi may chu giao dich...): giu lai de thu lai moi InpRetrySec giay.
   g_jobs[g_jobN] = j;
   g_jobN++;
   Print("OceanRelay: #", id, " moi mo ", CountBits(j.doneMask), "/", j.n, " lenh, se thu lai toi da ", InpRetryMaxSec, "s neu gia con trong ", DoubleToString(InpMaxDevPips, 1), " pip");
   return JobResult(j, true);
  }

// Khuon cap nhat (closeStatus): chua biet gia tri cu the nen CHI GHI NHAN, khong tu dong dong/doi SL.
void OnUpdateSignal(ulong id, string side, string status, string symbol, string tf, double entry, double sl, double tp)
  {
   g_last = StringFormat("#%I64u CAP NHAT %s %s %s %s", id, side, status, symbol, tf);
   Print("OceanRelay CAP NHAT: ", g_last);
  }

//+------------------------------------------------------------------+
//| BREAKEVEN: khi lenh TPn (n = InpBETrigger: 1 hoac 2) cua mot tin |
//| hieu chot lai (dong do cham TP), doi SL cac lenh co so TP > n    |
//| con mo cua tin hieu do ve gan GIA VAO THUC TE N don vi.          |
//|  - Chi dich SL theo huong co loi, khong bao gio keo SL ra xa.    |
//|  - Chi lam khi InpAllowTrading bat (cung cong tac tong).         |

//|  - Lenh TPn dong vi SL/dong tay/stop out thi KHONG doi SL.       |
//|  - Can tai khoan HEDGING (3 lenh rieng, TP khac nhau).           |
//|  - InpTP3Only (1 lenh duy nhat) thi BreakEven khong co tac dung. |
//+------------------------------------------------------------------+
#define BE_MAX_TRY 300 // so lan thu toi da / nhom lenh (moi giay 1 lan)

// Moi nhom lenh (3 chan cua 1 tin hieu) duoc dinh danh bang khoa = ngay*10000 + so thu tu trong ngay,
// vi so thu tu tren comment bat dau lai moi ngay. Ngay lay theo thoi gian mo lenh (POSITION_TIME).
ulong g_beKey[64];
int   g_beTry[64];
int   g_beN = 0;

  string BeLabel() {
      if (!InpBEEnable)
          return "TAT";
      return "BAT (sau TP" + IntegerToString((int)InpBETrigger) + ", SL " + (InpBELockProfit ? "khoa lai " : "phia lo ") + DoubleToString(MathAbs(InpBEOffset), 2) + (InpBEUnit == BE_UNIT_PIPS ? " pip" : " gia") + " so voi gia vao)";
  }

ulong BeKeyOf(int day, int seq) { return (ulong)day * 10000 + (ulong)seq; }
string BeGv(ulong key) { return "OCEANBE_" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "_" + (string)key; }

// Tang va tra ve so lan da thu cua nhom lenh nay (de khong thu mai mai).
int BeBump(ulong key)
  {
   for(int i = 0; i < g_beN; i++)
      if(g_beKey[i] == key) { g_beTry[i]++; return g_beTry[i]; }
   if(g_beN < 64) { g_beKey[g_beN] = key; g_beTry[g_beN] = 1; g_beN++; return 1; }
   for(int i = 1; i < 64; i++) { g_beKey[i - 1] = g_beKey[i]; g_beTry[i - 1] = g_beTry[i]; }
   g_beKey[63] = key; g_beTry[63] = 1;
   return 1;
  }

// Doc so thu tu va so TP tu comment "<InpComment>#<so>/TP<n>". false = khong phai lenh cua EA.
bool ParseComment(string cm, int &seq, int &tpn)
  {
   string pre = InpComment + "#";
   int pl = StringLen(pre);
   if(StringFind(cm, pre) != 0) return false;
   int slash = StringFind(cm, "/TP", pl);
   if(slash < 0) return false;
   long v = StringToInteger(StringSubstr(cm, pl, slash - pl));
   long t = StringToInteger(StringSubstr(cm, slash + 3));
   if(v <= 0 || t < 1 || t > 3) return false;
   seq = (int)v;
   tpn = (int)t;
   return true;
  }

  double BeOffsetPrice(string sym) {
      double off = MathAbs(InpBEOffset);
      if (InpBEUnit == BE_UNIT_PIPS)
          off = off * SymbolInfoDouble(sym, SYMBOL_POINT) * 10.0;
      return off;
  }

// 1 = lenh TPn cua nhom da dong do cham TP; 0 = dong vi ly do khac (SL, dong tay...); -1 = chua thay trong lich su.
// tRef = thoi gian mo cua mot lenh con lai trong nhom: chi nhan deal mo lenh TPn trong +-300 giay quanh moc nay,
// nen lenh cung so thu tu cua ngay khac khong bi nham.
int TpClosedByTp(int seq, int n, datetime tRef)
  {
   if(!HistorySelect(tRef - 600, TimeCurrent() + 60)) return -1;
   string want = InpComment + "#" + IntegerToString(seq) + "/TP" + IntegerToString(n);
   int total = HistoryDealsTotal();
   for(int i = total - 1; i >= 0; i--)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0) continue;
      if(HistoryDealGetInteger(d, DEAL_MAGIC) != InpMagic) continue;
      if(HistoryDealGetInteger(d, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
      if(HistoryDealGetString(d, DEAL_COMMENT) != want) continue;
      datetime dt = (datetime)HistoryDealGetInteger(d, DEAL_TIME);
      if(MathAbs((long)dt - (long)tRef) > 300) continue;
      long pid = HistoryDealGetInteger(d, DEAL_POSITION_ID);
      for(int j = total - 1; j >= 0; j--)
        {
         ulong o = HistoryDealGetTicket(j);
         if(o == 0 || HistoryDealGetInteger(o, DEAL_POSITION_ID) != pid) continue;
         long en = HistoryDealGetInteger(o, DEAL_ENTRY);
         if(en == DEAL_ENTRY_OUT || en == DEAL_ENTRY_INOUT || en == DEAL_ENTRY_OUT_BY)
            return (HistoryDealGetInteger(o, DEAL_REASON) == DEAL_REASON_TP) ? 1 : 0;
        }
      return -1;
     }
   return -1;
  }

// Doi SL cac lenh con mo (so TP > n) cua nhom (seq, day). true = moi lenh da o SL moi hoac tot hon.
bool ApplyBreakEven(int seq, int day, int n)
  {
   bool allOk = true;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0 || !PositionSelectByTicket(tk)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      int ps, tpn;
      if(!ParseComment(PositionGetString(POSITION_COMMENT), ps, tpn) || ps != seq || tpn <= n) continue;
      if(DayOf((datetime)PositionGetInteger(POSITION_TIME)) != day) continue;

      string sym = PositionGetString(POSITION_SYMBOL);
      bool buy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      double curSl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
      int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double off = BeOffsetPrice(sym);
      double want = buy ? (InpBELockProfit ? open + off : open - off) : (InpBELockProfit ? open - off : open + off);
      want = NormalizeDouble(want, dg);

      // SL hien tai da tot hon hoac bang muc moi: khong dong vao (khong bao gio keo SL ra xa).
      if(curSl > 0 && (buy ? curSl >= want - pt / 2 : curSl <= want + pt / 2)) continue;

      // SL moi phai cach gia thi truong it nhat stops level (BUY: duoi Bid, SELL: tren Ask).
      double minDist = (double)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * pt;
      double bid = SymbolInfoDouble(sym, SYMBOL_BID), ask = SymbolInfoDouble(sym, SYMBOL_ASK);
      bool valid = buy ? (want < bid - minDist) : (want > ask + minDist);
      if(!valid) { allOk = false; continue; }

      if(g_trade.PositionModify(tk, want, tp) && (g_trade.ResultRetcode() == TRADE_RETCODE_DONE || g_trade.ResultRetcode() == TRADE_RETCODE_PLACED))
         Print("OceanRelay BREAKEVEN: lenh so ", seq, " TP", tpn, " ticket ", tk, " SL ", DoubleToString(curSl, dg), " -> ", DoubleToString(want, dg));
      else
        {
         allOk = false;
         Print("OceanRelay BREAKEVEN: doi SL ticket ", tk, " that bai retcode=", g_trade.ResultRetcode(), " ", g_trade.ResultRetcodeDescription());
        }
     }
   return allOk;
  }

// Chay moi giay. Nhe khi khong co viec: chi quet danh sach vi the dang mo.
void ManageBreakEven()
  {
   if(!InpBEEnable || !InpAllowTrading) return;
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) return;
   int trig = (int)InpBETrigger;

   ulong    keys[32];
   int      seqs[32];
   int      days[32];
   int      mask[32];   // bit (n-1) = lenh TPn cua nhom dang con mo
   datetime tref[32];   // thoi gian mo cua 1 lenh trong nhom
   int      cnt = 0;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0 || !PositionSelectByTicket(tk)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      int seq, tpn;
      if(!ParseComment(PositionGetString(POSITION_COMMENT), seq, tpn)) continue;
      datetime ot = (datetime)PositionGetInteger(POSITION_TIME);
      int day = DayOf(ot);
      ulong key = BeKeyOf(day, seq);
      int g = -1;
      for(int k = 0; k < cnt; k++) if(keys[k] == key) { g = k; break; }
      if(g < 0)
        {
         if(cnt >= 32) continue;
         g = cnt++;
         keys[g] = key; seqs[g] = seq; days[g] = day; mask[g] = 0; tref[g] = ot;
        }
      mask[g] |= (1 << (tpn - 1));
     }

   for(int g = 0; g < cnt; g++)
     {
      bool trigOpen = ((mask[g] >> (trig - 1)) & 1) != 0;
      bool laterOpen = (mask[g] >> trig) != 0; // con lenh co so TP lon hon trig
      if(trigOpen || !laterOpen) continue;      // chua toi luc, hoac khong con lenh nao de doi
      ulong key = keys[g];
      if(GlobalVariableCheck(BeGv(key))) continue; // da xu ly (xong hoac bo qua)

      int r = TpClosedByTp(seqs[g], trig, tref[g]);
      if(r == 0)
        {
         GlobalVariableSet(BeGv(key), 0);
         Print("OceanRelay BREAKEVEN: lenh so ", seqs[g], " (", days[g], ") TP", trig, " dong khong phai do cham TP -> khong doi SL");
         continue;
        }
      if(r == 1 && ApplyBreakEven(seqs[g], days[g], trig))
        {
         GlobalVariableSet(BeGv(key), 1);
         continue;
        }
      if(BeBump(key) >= BE_MAX_TRY)
        {
         GlobalVariableSet(BeGv(key), 0);
         Print("OceanRelay BREAKEVEN: lenh so ", seqs[g], " (", days[g], ") bo cuoc sau ", BE_MAX_TRY, " lan thu (",
               r < 0 ? "khong thay deal dong TP trong lich su" : "SL moi khong hop le/bi san tu choi", ")");
        }
     }
  }

void UpdateComment(bool ok)
  {
    Comment("OceanRelay ", EA_VER, InpAllowTrading ? "  [DANH LENH: BAT]" : "  [CHI THEO DOI]", "\n",
            ok ? "Gateway: OK" : "Gateway: LOI (xem tab Experts)", "\n",
            "Sai so gia: ", InpMaxDevPips > 0 ? DoubleToString(InpMaxDevPips, 1) + " pip" : "khong kiem", "   Cho thu lai: ", IntegerToString(g_jobN), " tin hieu", "\n",
            "BreakEven: ", BeLabel(), "\n",
            "Tin hieu cuoi: ", g_last);
  }
