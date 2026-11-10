//+------------------------------------------------------------------+
//| OceanRelay.mq4  v0.2.0  (DANH LENH + BREAKEVEN THEO TP1/TP2)    |
//| Ban MT4 (MQL4) cua OceanRelay.mq5, giu nguyen chuc nang.         |
//| Ping Gateway cuc bo moi InpPingSec giay: gui tai khoan + lenh    |
//| dang mo, nhan tin hieu OCEAN (da duoc Gateway kiem chu ky HMAC), |
//| mo 3 lenh cung Entry/SL voi TP1/TP2/TP3, ack ket qua.            |
//| BreakEven (tuy chon, mac dinh TAT): khi lenh TP1 (hoac TP2) chot |
//| lai thi doi SL cac lenh con lai ve gan gia vao N don vi.         |
//| EA chi noi chuyen voi Gateway/Server tren VPS (khong goi Worker).|
//| MAC DINH InpAllowTrading=false: chi theo doi, KHONG dat lenh.    |
//| Chua duoc bien dich tren MT4 that: thu tren DEMO truoc.          |
//| Dat http://127.0.0.1:47860 vao Tools > Options > Expert Advisors |
//| > Allow WebRequest for listed URL (doi cong thi sua InpGateway). |
//+------------------------------------------------------------------+
#property copyright "Ocean Relay"
#property version "1.00"
#property strict

#include <stdlib.mqh>

#define EA_VER "0.2.0"

input string InpGateway = "http://127.0.0.1:47860"; // Gateway cuc bo (phai nam trong Allow WebRequest)
input int InpPingSec = 2;                           // Nhip ping (giay, toi thieu 1)
input int InpTimeoutMs = 1500;                      // Timeout WebRequest (ms)
input string InpTerminalId = "";                    // De trong = login@server
input bool InpAutoSymbol = true;                    // Ten symbol khong khop thi tim ten gan nhat o san (XAUUSD -> XAUUSDm, XAUUSD.a ...)

enum ENUM_BE_TRIGGER {
    BE_AFTER_TP1 = 1,
    BE_AFTER_TP2 = 2
};
enum ENUM_BE_UNIT {
    BE_UNIT_PRICE = 0,
    BE_UNIT_PIPS = 1
};

input group "=== DANH LENH (mac dinh TAT) ===" input bool InpAllowTrading = false; // CONG TAC TONG: false = chi theo doi, khong dat lenh
input double InpLotPerOrder = 0.01;                                                // Lot moi lenh (moi tin hieu mo 3 lenh = 3 x lot nay)
input double InpMaxTotalLots = 0.30;                                               // Tong lot cac lenh dang mo cua EA (magic nay) toi da
input int InpMaxAgeSec = 60;                                                       // Bo tin hieu cu hon so giay nay
input int InpMaxDevPoints = 500;                                                   // Bo neu gia hien tai lech Entry qua so point nay (0 = khong kiem)
input int InpSlippagePts = 30;                                                     // Truot gia toi da khi khop (point)
input bool InpTP3Only = false;                                                     // true: chi mo 1 lenh toan bo (lot x3) voi TP3
input int InpMagic = 20261109;                                                     // Magic number cua EA (de nhan lenh cua chinh no)
input string InpComment = "OCEAN";                                                 // Tien to comment lenh

input group "=== BREAKEVEN (mac dinh TAT) ===" input bool InpBEEnable = false; // BAT/TAT BreakEven (chi hoat dong khi InpAllowTrading = true)
input ENUM_BE_TRIGGER InpBETrigger = BE_AFTER_TP1;                             // Kich hoat khi: TP1 chot lai (doi SL TP2+TP3) hoac TP2 chot lai (doi SL TP3)
input double InpBEOffset = 3.0;                                                // N: khoang cach tu GIA VAO toi SL moi (>= 0)
input ENUM_BE_UNIT InpBEUnit = BE_UNIT_PRICE;                                  // Don vi N: GIA (XAUUSD: 3.0 = 3 USD) hoac PIP (1 pip = 10 point)
input bool InpBELockProfit = false;                                            // false: SL phia LO (BUY: Entry-N, SELL: Entry+N). true: khoa lai (BUY: Entry+N, SELL: Entry-N)

string g_acks = ""; // "12:received,13:received" gui kem o ping ke tiep
ulong g_seen[64];   // id tin hieu da xu ly (tranh log lap khi Gateway giao lai truoc khi ack toi noi)
int g_seenN = 0;
uint g_nextPingMs = 0;
int g_fail = 0;
string g_last = "chua co tin hieu";

//+------------------------------------------------------------------+
int OnInit() {
    if (IsTesting()) {
        Print("OceanRelay: khong chay trong Strategy Tester.");
        return INIT_FAILED;
    }
    if (!EventSetTimer(1)) {
        Print("OceanRelay: EventSetTimer that bai");
        return INIT_FAILED;
    }
    // Tre ngau nhien 0-2 giay truoc ping dau de nhieu EA khong ban cung luc.
    g_nextPingMs = GetTickCount() + (uint)(MathRand() % 2000);
    Print("OceanRelay ", EA_VER, " san sang. Gateway=", InpGateway, InpAllowTrading ? " | DANH LENH: BAT" : " | DANH LENH: TAT (chi theo doi)",
          " | BREAKEVEN: ", BeLabel());
    if (InpAllowTrading && !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
        Print("OceanRelay: CANH BAO - Algo Trading dang tat tren terminal.");
    return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) {
    EventKillTimer();
    Comment("");
}

void OnTimer() {
    ManageBreakEven(); // moi giay, doc lap voi nhip ping Gateway
    uint now = GetTickCount();
    if ((int)(now - g_nextPingMs) < 0)
        return;
    int gap = MathMax(1, InpPingSec) * 1000;
    // Gateway hong: gian nhip toi da 15 giay de khong spam.
    if (g_fail > 0)
        gap = MathMin(15000, gap * (1 + g_fail));
    g_nextPingMs = now + (uint)gap;
    Ping();
}

//+------------------------------------------------------------------+
//| Gom lenh dang mo: ticket,symbol,side,vol,open,sl,tp,profit;...  |
//+------------------------------------------------------------------+
string BuildPositions() {
    string s = "";
    int n = MathMin(OrdersTotal(), 50);
    for (int i = 0; i < n; i++) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
            continue;
        int ty = OrderType();
        if (ty != OP_BUY && ty != OP_SELL)
            continue;
        string side = (ty == OP_BUY) ? "buy" : "sell";
        string sym0 = OrderSymbol();
        int dg = (int)MarketInfo(sym0, MODE_DIGITS);
        string sym = sym0;
        StringReplace(sym, ",", "_");
        StringReplace(sym, ";", "_");
        s += StringFormat("%d,%s,%s,%.2f,%s,%s,%s,%.2f;", OrderTicket(), sym, side,
                          OrderLots(),
                          DoubleToString(OrderOpenPrice(), dg),
                          DoubleToString(OrderStopLoss(), dg),
                          DoubleToString(OrderTakeProfit(), dg),
                          OrderProfit());
    }
    return s;
}

//+------------------------------------------------------------------+
void Ping() {
    string body = "";
    body += "login=" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "\n";
    body += "server=" + AccountInfoString(ACCOUNT_SERVER) + "\n";
    if (InpTerminalId != "")
        body += "tid=" + InpTerminalId + "\n";
    body += "bal=" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "\n";
    body += "eq=" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "\n";
    body += "mg=" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + "\n";
    body += "fm=" + DoubleToString(AccountInfoDouble(ACCOUNT_FREEMARGIN), 2) + "\n";
    body += "ver=" + EA_VER + "\n";
    body += "pos=" + BuildPositions() + "\n";
    body += "acks=" + g_acks + "\n";
    string sentAcks = g_acks;

    char data[], result[];
    string rh;
    int n = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
    if (n > 0)
        ArrayResize(data, n - 1); // bo ky tu NUL cuoi
    ResetLastError();
    int code = WebRequest("POST", InpGateway + "/v1/ping", "Content-Type: text/plain\r\n", InpTimeoutMs, data, result, rh);
    if (code != 200) {
        g_fail++;
        if (g_fail == 1 || g_fail % 20 == 0)
            Print("OceanRelay: Gateway loi, HTTP=", code, " err=", GetLastError(), " (kiem tra Allow WebRequest va Gateway)");
        UpdateComment(false);
        return;
    }
    g_fail = 0;
    // Gateway da nhan ack nay: bo khoi danh sach (chi bo phan da gui, giu phan phat sinh them).
    if (sentAcks != "" && StringFind(g_acks, sentAcks) == 0)
        g_acks = StringSubstr(g_acks, StringLen(sentAcks));
    if (StringLen(g_acks) > 0 && StringGetCharacter(g_acks, 0) == ',')
        g_acks = StringSubstr(g_acks, 1);
    HandleResponse(CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8));
    UpdateComment(true);
}

//+------------------------------------------------------------------+
bool Seen(ulong id) {
    for (int i = 0; i < g_seenN; i++)
        if (g_seen[i] == id)
            return true;
    return false;
}
void Remember(ulong id) {
    if (g_seenN < 64) {
        g_seen[g_seenN++] = id;
        return;
    }
    for (int i = 1; i < 64; i++)
        g_seen[i - 1] = g_seen[i];
    g_seen[63] = id;
}
void AddAck(ulong id, string result) {
    if (g_acks != "")
        g_acks += ",";
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
void HandleResponse(string text) {
    string lines[];
    int nl = StringSplit(text, '\n', lines);
    for (int i = 1; i < nl; i++) // dong 0 la "OK"
    {
        string f[];
        int nf = StringSplit(lines[i], '|', f);
        if (nf < 3)
            continue;
        ulong id = (ulong)StringToInteger(f[1]);
        if (id == 0)
            continue;
        if (Seen(id) || Done(id)) {
            AddAck(id, "received");
            continue;
        }
        Remember(id);
        string res = "received";
        if (f[0] == "S" && nf >= 11)
            res = OnEntrySignal(id, f[2], f[3], f[4], StringToDouble(f[5]), StringToDouble(f[6]),
                                StringToDouble(f[7]), StringToDouble(f[8]), StringToDouble(f[9]), (int)StringToInteger(f[10]));
        else if (f[0] == "U" && nf >= 10)
            OnUpdateSignal(id, f[2], f[3], f[4], f[5], StringToDouble(f[6]), StringToDouble(f[7]), StringToDouble(f[8]));
        AddAck(id, res);
    }
}

double TotalOpenLots() {
    double t = 0;
    for (int i = 0; i < OrdersTotal(); i++) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
            continue;
        int ty = OrderType();
        if (ty != OP_BUY && ty != OP_SELL)
            continue;
        if (OrderMagicNumber() == InpMagic)
            t += OrderLots();
    }
    return t;
}

double NormVol(string sym, double v) {
    double mn = MarketInfo(sym, MODE_MINLOT), mx = MarketInfo(sym, MODE_MAXLOT), st = MarketInfo(sym, MODE_LOTSTEP);
    if (st <= 0)
        st = 0.01;
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
int g_symN = 0;

string ResolveSymbol(string want) {
    for (int i = 0; i < g_symN; i++)
        if (g_symKey[i] == want)
            return g_symVal[i];
    string found = "";
    if (SymbolSelect(want, true))
        found = want;
    else if (InpAutoSymbol) {
        string up = want;
        StringToUpper(up);
        int wl = StringLen(up), total = SymbolsTotal(false), bestLen = 1000, ties = 0;
        for (int i = 0; i < total; i++) {
            string nm = SymbolName(i, false), u = nm;
            StringToUpper(u);
            int l = StringLen(u);
            if (l <= wl || l > wl + 4 || StringFind(u, up) != 0)
                continue;
            if (l < bestLen) {
                bestLen = l;
                found = nm;
                ties = 1;
            } else if (l == bestLen)
                ties++;
        }
        if (ties > 1) {
            Print("OceanRelay: ten symbol ", want, " mo ho o san nay (nhieu ten gan giong) -> khong danh, dat OCEAN_SYMBOL_MAP o Gateway");
            found = "";
        } else if (found != "" && !SymbolSelect(found, true))
            found = "";
        if (found != "")
            Print("OceanRelay: tu dong ghep ", want, " -> ", found);
    }
    if (g_symN < 16) {
        g_symKey[g_symN] = want;
        g_symVal[g_symN] = found;
        g_symN++;
    }
    return found;
}

//+------------------------------------------------------------------+
//| So thu tu lenh THEO NGAY (comment: <InpComment>#<so>/TPn).       |
//| Moi ngay (gio server) bat dau lai tu 1, khong dem vo han theo id |
//| tin hieu cua Server. Bo dem luu o Global Variable                |
//| OCEANSEQ_<login> = yyyymmdd*10000 + so, nen khoi dong lai EA van |
//| dem tiep dung. Id tin hieu that van dung de chong mo lenh lap.   |
//+------------------------------------------------------------------+
int DayOf(datetime t) {
    return TimeYear(t) * 10000 + TimeMonth(t) * 100 + TimeDay(t);
}

string SeqGv() { return "OCEANSEQ_" + (string)AccountInfoInteger(ACCOUNT_LOGIN); }

int NextSeq(int& day) {
    day = DayOf(TimeCurrent());
    double v = GlobalVariableCheck(SeqGv()) ? GlobalVariableGet(SeqGv()) : 0.0;
    int vd = (int)MathFloor(v / 10000.0);
    int n = (vd == day) ? (int)MathRound(v - (double)vd * 10000.0) : 0;
    n = (n >= 9999) ? 1 : n + 1;
    GlobalVariableSet(SeqGv(), (double)day * 10000.0 + (double)n);
    return n;
}

//+------------------------------------------------------------------+
//| Mo 3 lenh (hoac 1 lenh neu InpTP3Only) cung SL, TP1/TP2/TP3.     |
//| Tra ve chuoi ket qua de ack. Moi buoc chan deu tra ve ma ro rang.|
//+------------------------------------------------------------------+
string OnEntrySignal(ulong id, string side, string symbol, string tf, double entry, double sl,
                     double tp1, double tp2, double tp3, int ageSec) {
    g_last = StringFormat("#%s %s %s %s entry=%.2f sl=%.2f tp1=%.2f tp2=%.2f tp3=%.2f (%ds)", (string)id, side, symbol, tf, entry, sl, tp1, tp2, tp3, ageSec);
    Print("OceanRelay TIN HIEU: ", g_last);
    if (!InpAllowTrading)
        return "trading_off";
    if (!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) {
        Print("OceanRelay: Algo Trading tat");
        return "trading_off";
    }
    if (ageSec > InpMaxAgeSec) {
        Print("OceanRelay: bo #", id, " qua cu (", ageSec, "s)");
        return "too_old";
    }
    string sigSymbol = symbol;
    symbol = ResolveSymbol(sigSymbol);
    if (symbol == "") {
        Print("OceanRelay: khong co symbol ", sigSymbol, " o san nay (kiem OCEAN_SYMBOL_MAP o Gateway)");
        return "no_symbol";
    }

    bool buy = (side == "buy");
    double ask = MarketInfo(symbol, MODE_ASK), bid = MarketInfo(symbol, MODE_BID);
    double pt = MarketInfo(symbol, MODE_POINT);
    int dg = (int)MarketInfo(symbol, MODE_DIGITS);
    if (ask <= 0 || bid <= 0 || pt <= 0)
        return "no_symbol";
    double px = buy ? ask : bid;

    if (InpMaxDevPoints > 0 && MathAbs(px - entry) > InpMaxDevPoints * pt) {
        Print("OceanRelay: bo #", id, " gia lech Entry ", DoubleToString(MathAbs(px - entry) / pt, 0), " point");
        return "price_dev";
    }
    // SL/TP phai dung phia so voi GIA HIEN TAI (Server da kiem phia theo Entry, day la kiem lan 2 theo gia that)
    bool ok = buy ? (sl < px && tp1 > px && tp1 <= tp2 && tp2 <= tp3) : (sl > px && tp1 < px && tp1 >= tp2 && tp2 >= tp3);
    if (!ok) {
        Print("OceanRelay: bo #", id, " SL/TP sai phia so voi gia hien tai");
        return "bad_levels";
    }
    double minDist = MarketInfo(symbol, MODE_STOPLEVEL) * pt;
    if (MathAbs(px - sl) < minDist || MathAbs(tp1 - px) < minDist) {
        Print("OceanRelay: bo #", id, " SL/TP gan hon stops level");
        return "bad_stops";
    }

    int n = InpTP3Only ? 1 : 3;
    double lotEach = NormVol(symbol, InpTP3Only ? InpLotPerOrder * 3 : InpLotPerOrder);
    if (TotalOpenLots() + lotEach * n > InpMaxTotalLots + 1e-9) {
        Print("OceanRelay: bo #", id, " vuot InpMaxTotalLots");
        return "max_lots";
    }

    // Ghi nho id TRUOC khi goi san: loi giua chung thi khong bao gio mo lap.
    MarkDone(id);
    int seqDay = 0;
    int seq = NextSeq(seqDay);
    Print("OceanRelay: tin hieu #", id, " -> lenh so ", seq, " cua ngay ", seqDay);
    double tps[3];
    tps[0] = tp1;
    tps[1] = tp2;
    tps[2] = tp3;
    int opened = 0;
    int lastRc = 0;
    for (int k = 0; k < n; k++) {
        double tp = InpTP3Only ? tp3 : tps[k];
        string cm = StringFormat("%s#%d/TP%d", InpComment, seq, InpTP3Only ? 3 : k + 1);
        double price = NormalizeDouble(MarketInfo(symbol, buy ? MODE_ASK : MODE_BID), dg);
        ResetLastError();
        int ticket = OrderSend(symbol, buy ? OP_BUY : OP_SELL, lotEach, price, InpSlippagePts,
                               NormalizeDouble(sl, dg), NormalizeDouble(tp, dg), cm, InpMagic, 0, clrNONE);
        if (ticket > 0)
            opened++;
        else {
            lastRc = GetLastError();
            Print("OceanRelay: lenh TP", k + 1, " that bai retcode=", lastRc, " ", ErrorDescription(lastRc));
        }
    }
    Print("OceanRelay: #", id, " (lenh so ", seq, ") da mo ", opened, "/", n, " lenh");
    if (opened == 0)
        return "failed:" + (string)lastRc;
    return "opened:" + (string)opened;
}

// Khuon cap nhat (closeStatus): chua biet gia tri cu the nen CHI GHI NHAN, khong tu dong dong/doi SL.
void OnUpdateSignal(ulong id, string side, string status, string symbol, string tf, double entry, double sl, double tp) {
    g_last = StringFormat("#%s CAP NHAT %s %s %s %s", (string)id, side, status, symbol, tf);
    Print("OceanRelay CAP NHAT: ", g_last);
}

//+------------------------------------------------------------------+
//| BREAKEVEN: khi lenh TPn (n = InpBETrigger: 1 hoac 2) cua mot tin |
//| hieu chot lai (dong do cham TP), doi SL cac lenh co so TP > n    |
//| con mo cua tin hieu do ve gan GIA VAO THUC TE N don vi.          |
//|  - Chi dich SL theo huong co loi, khong bao gio keo SL ra xa.    |
//|  - Chi lam khi InpAllowTrading bat (cung cong tac tong).         |
//|  - Moi nhom lenh chi lam mot lan: Global Variable                |
//|    OCEANBE_<login>_<yyyymmdd*10000+so>, khoi dong lai khong lam. |
//|  - Lenh TPn dong vi SL/dong tay/stop out thi KHONG doi SL.       |
//|  - MT4: khong co ly do dong lenh, nen nhan biet "dong do cham TP"|
//|    bang comment "[tp]"/"[sl]" cua san, neu khong co thi so sanh  |
//|    gia dong voi TP cua lenh.                                     |
//|  - Can tab Account History co du lich su (ngay hom nay tro len). |
//|  - InpTP3Only (1 lenh duy nhat) thi BreakEven khong co tac dung. |
//+------------------------------------------------------------------+
#define BE_MAX_TRY 300 // so lan thu toi da / nhom lenh (moi giay 1 lan)

// Moi nhom lenh (3 chan cua 1 tin hieu) duoc dinh danh bang khoa = ngay*10000 + so thu tu trong ngay,
// vi so thu tu tren comment bat dau lai moi ngay. Ngay lay theo thoi gian mo lenh (OrderOpenTime).
ulong g_beKey[64];
int g_beTry[64];
int g_beN = 0;

string BeLabel() {
    if (!InpBEEnable)
        return "TAT";
    return "BAT (sau TP" + IntegerToString((int)InpBETrigger) + ", SL " + (InpBELockProfit ? "khoa lai " : "phia lo ") + DoubleToString(MathAbs(InpBEOffset), 2) + (InpBEUnit == BE_UNIT_PIPS ? " pip" : " gia") + " so voi gia vao)";
}

ulong BeKeyOf(int day, int seq) { return (ulong)day * 10000 + (ulong)seq; }
string BeGv(ulong key) { return "OCEANBE_" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "_" + (string)key; }

// Tang va tra ve so lan da thu cua nhom lenh nay (de khong thu mai mai).
int BeBump(ulong key) {
    for (int i = 0; i < g_beN; i++)
        if (g_beKey[i] == key) {
            g_beTry[i]++;
            return g_beTry[i];
        }
    if (g_beN < 64) {
        g_beKey[g_beN] = key;
        g_beTry[g_beN] = 1;
        g_beN++;
        return 1;
    }
    for (int i = 1; i < 64; i++) {
        g_beKey[i - 1] = g_beKey[i];
        g_beTry[i - 1] = g_beTry[i];
    }
    g_beKey[63] = key;
    g_beTry[63] = 1;
    return 1;
}

// Doc so thu tu va so TP tu comment "<InpComment>#<so>/TP<n>". false = khong phai lenh cua EA.
bool ParseComment(string cm, int& seq, int& tpn) {
    string pre = InpComment + "#";
    int pl = StringLen(pre);
    if (StringFind(cm, pre) != 0)
        return false;
    int slash = StringFind(cm, "/TP", pl);
    if (slash < 0)
        return false;
    long v = StringToInteger(StringSubstr(cm, pl, slash - pl));
    long t = StringToInteger(StringSubstr(cm, slash + 3));
    if (v <= 0 || t < 1 || t > 3)
        return false;
    seq = (int)v;
    tpn = (int)t;
    return true;
}

double BeOffsetPrice(string sym) {
    double off = MathAbs(InpBEOffset);
    if (InpBEUnit == BE_UNIT_PIPS)
        off = off * MarketInfo(sym, MODE_POINT) * 10.0;
    return off;
}

// Lenh LICH SU dang duoc chon: 1 = dong do cham TP; 0 = dong vi ly do khac (SL, dong tay...).
int ClosedByTp() {
    string cm = OrderComment();
    if (StringFind(cm, "[tp]") >= 0)
        return 1;
    if (StringFind(cm, "[sl]") >= 0)
        return 0;
    string sym = OrderSymbol();
    double pt = MarketInfo(sym, MODE_POINT);
    double tol = MathMax(2.0 * pt, MarketInfo(sym, MODE_SPREAD) * pt);
    double tp = OrderTakeProfit();
    if (tp > 0 && MathAbs(OrderClosePrice() - tp) <= tol)
        return 1;
    return 0;
}

// 1 = lenh TPn cua nhom da dong do cham TP; 0 = dong vi ly do khac (SL, dong tay...); -1 = chua thay trong lich su.
// tRef = thoi gian mo cua mot lenh con lai trong nhom: chi nhan lenh TPn mo trong +-300 giay quanh moc nay,
// nen lenh cung so thu tu cua ngay khac khong bi nham.
int TpClosedByTp(int seq, int n, datetime tRef) {
    string want = InpComment + "#" + IntegerToString(seq) + "/TP" + IntegerToString(n);
    int total = OrdersHistoryTotal();
    for (int i = total - 1; i >= 0; i--) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY))
            continue;
        if (OrderMagicNumber() != InpMagic)
            continue;
        int ty = OrderType();
        if (ty != OP_BUY && ty != OP_SELL)
            continue;
        if (StringFind(OrderComment(), want) != 0)
            continue;
        if (MathAbs((long)OrderOpenTime() - (long)tRef) > 300)
            continue;
        return ClosedByTp();
    }
    return -1;
}

// Doi SL cac lenh con mo (so TP > n) cua nhom (seq, day). true = moi lenh da o SL moi hoac tot hon.
bool ApplyBreakEven(int seq, int day, int n) {
    bool allOk = true;
    for (int i = OrdersTotal() - 1; i >= 0; i--) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
            continue;
        int ty = OrderType();
        if (ty != OP_BUY && ty != OP_SELL)
            continue;
        if (OrderMagicNumber() != InpMagic)
            continue;
        int ps = 0, tpn = 0;
        if (!ParseComment(OrderComment(), ps, tpn) || ps != seq || tpn <= n)
            continue;
        if (DayOf(OrderOpenTime()) != day)
            continue;

        int tk = OrderTicket();
        string sym = OrderSymbol();
        bool buy = (ty == OP_BUY);
        double open = OrderOpenPrice();
        double curSl = OrderStopLoss();
        double tp = OrderTakeProfit();
        double pt = MarketInfo(sym, MODE_POINT);
        int dg = (int)MarketInfo(sym, MODE_DIGITS);
        double off = BeOffsetPrice(sym);
        double want = buy ? (InpBELockProfit ? open + off : open - off) : (InpBELockProfit ? open - off : open + off);
        want = NormalizeDouble(want, dg);

        // SL hien tai da tot hon hoac bang muc moi: khong dong vao (khong bao gio keo SL ra xa).
        if (curSl > 0 && (buy ? curSl >= want - pt / 2 : curSl <= want + pt / 2))
            continue;

        // SL moi phai cach gia thi truong it nhat stops level (BUY: duoi Bid, SELL: tren Ask).
        double minDist = MarketInfo(sym, MODE_STOPLEVEL) * pt;
        double bid = MarketInfo(sym, MODE_BID), ask = MarketInfo(sym, MODE_ASK);
        bool valid = buy ? (want < bid - minDist) : (want > ask + minDist);
        if (!valid) {
            allOk = false;
            continue;
        }

        ResetLastError();
        if (OrderModify(tk, open, want, tp, 0, clrNONE))
            Print("OceanRelay BREAKEVEN: lenh so ", seq, " TP", tpn, " ticket ", tk, " SL ", DoubleToString(curSl, dg), " -> ", DoubleToString(want, dg));
        else {
            allOk = false;
            int err = GetLastError();
            Print("OceanRelay BREAKEVEN: doi SL ticket ", tk, " that bai retcode=", err, " ", ErrorDescription(err));
        }
    }
    return allOk;
}

// Bo dem nhom lenh dung cho ManageBreakEven (bien toan cuc de MQL4 strict khong bao "uninitialized"; moi lan chay deu ghi lai tu dau).
ulong g_bgKeys[32];
int g_bgSeqs[32];
int g_bgDays[32];
int g_bgMask[32];      // bit (n-1) = lenh TPn cua nhom dang con mo
datetime g_bgTref[32]; // thoi gian mo cua 1 lenh trong nhom

// Chay moi giay. Nhe khi khong co viec: chi quet danh sach lenh dang mo.
void ManageBreakEven() {
    if (!InpBEEnable || !InpAllowTrading)
        return;
    if (!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
        return;
    int trig = (int)InpBETrigger;

    int cnt = 0;
    for (int i = 0; i < OrdersTotal(); i++) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
            continue;
        int ty = OrderType();
        if (ty != OP_BUY && ty != OP_SELL)
            continue;
        if (OrderMagicNumber() != InpMagic)
            continue;
        int seq = 0, tpn = 0;
        if (!ParseComment(OrderComment(), seq, tpn))
            continue;
        datetime ot = OrderOpenTime();
        int day = DayOf(ot);
        ulong key = BeKeyOf(day, seq);
        int g = -1;
        for (int k = 0; k < cnt; k++)
            if (g_bgKeys[k] == key) {
                g = k;
                break;
            }
        if (g < 0) {
            if (cnt >= 32)
                continue;
            g = cnt++;
            g_bgKeys[g] = key;
            g_bgSeqs[g] = seq;
            g_bgDays[g] = day;
            g_bgMask[g] = 0;
            g_bgTref[g] = ot;
        }
        g_bgMask[g] |= (1 << (tpn - 1));
    }

    for (int g = 0; g < cnt; g++) {
        bool trigOpen = ((g_bgMask[g] >> (trig - 1)) & 1) != 0;
        bool laterOpen = (g_bgMask[g] >> trig) != 0; // con lenh co so TP lon hon trig
        if (trigOpen || !laterOpen)
            continue; // chua toi luc, hoac khong con lenh nao de doi
        ulong key = g_bgKeys[g];
        if (GlobalVariableCheck(BeGv(key)))
            continue; // da xu ly (xong hoac bo qua)

        int r = TpClosedByTp(g_bgSeqs[g], trig, g_bgTref[g]);
        if (r == 0) {
            GlobalVariableSet(BeGv(key), 0);
            Print("OceanRelay BREAKEVEN: lenh so ", g_bgSeqs[g], " (", g_bgDays[g], ") TP", trig, " dong khong phai do cham TP -> khong doi SL");
            continue;
        }
        if (r == 1 && ApplyBreakEven(g_bgSeqs[g], g_bgDays[g], trig)) {
            GlobalVariableSet(BeGv(key), 1);
            continue;
        }
        if (BeBump(key) >= BE_MAX_TRY) {
            GlobalVariableSet(BeGv(key), 0);
            Print("OceanRelay BREAKEVEN: lenh so ", g_bgSeqs[g], " (", g_bgDays[g], ") bo cuoc sau ", BE_MAX_TRY, " lan thu (",
                  r < 0 ? "khong thay lenh dong TP trong lich su" : "SL moi khong hop le/bi san tu choi", ")");
        }
    }
}

void UpdateComment(bool ok) {
    Comment("OceanRelay ", EA_VER, InpAllowTrading ? "  [DANH LENH: BAT]" : "  [CHI THEO DOI]", "\n",
            ok ? "Gateway: OK" : "Gateway: LOI (xem tab Experts)", "\n",
            "BreakEven: ", BeLabel(), "\n",
            "Tin hieu cuoi: ", g_last);
}