//+------------------------------------------------------------------+
//| OceanRelay.mq4  v0.3.0  (DANH LENH + BREAKEVEN + BU LENH)       |
//| Ban MT4 (MQL4) cua OceanRelay.mq5, giu nguyen chuc nang.         |
//| Ping Gateway cuc bo moi InpPingSec giay: gui tai khoan + lenh    |
//| dang mo, nhan tin hieu OCEAN (da duoc Gateway kiem chu ky HMAC), |
//| mo 3 lenh cung Entry/SL voi TP1/TP2/TP3, ack ket qua.            |
//| v0.3.0: BU LENH (tuy chon, mac dinh TAT): chan nao con thieu     |
//| (loi san/terminal, gia di xa, tin hieu den tre/EA khong phan hoi)|
//| thi DAT BU lenh cho (Limit/Stop) tai Entry cua Signal, tu huy sau|
//| N giay (InpMakeupExpirySec). EA bao Setup + lenh cho len Server. |
//| BreakEven (tuy chon, mac dinh TAT): khi lenh TP1 (hoac TP2) chot |
//| lai thi doi SL cac lenh con lai ve gan gia vao N don vi.         |
//| EA chi noi chuyen voi Gateway/Server tren VPS (khong goi Worker).|
//| LOC GIO + LOC TIN MANH (moi): ngung VAO THEM lenh theo khung gio |
//| (VD 23:00-05:00, 07:30-08:03) va quanh tin nhap tay (-30p/+5p).  |
//| MT4 khong co lich kinh te: tin CPI/Fed/NFP nhap tay theo ngay gio|
//| MAC DINH InpAllowTrading=false: chi theo doi, KHONG dat lenh.    |
//| Chua duoc bien dich tren MT4 that: thu tren DEMO truoc.          |
//| Dat http://127.0.0.1:47860 vao Tools > Options > Expert Advisors |
//| > Allow WebRequest for listed URL (doi cong thi sua InpGateway). |
//| MT4 bao err=5200 neu URL co cong: dung InpGateway=http://127.0.0.1|
//| (khong cong) + netsh portproxy cong 80 -> cong Gateway (xem docs).|
//+------------------------------------------------------------------+
#property copyright "Ocean Relay"
#property version "1.00"
#property strict

#include <stdlib.mqh>

#define EA_VER "0.3.0"

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
enum ENUM_TIME_SOURCE { TIME_SOURCE_LOCAL = 0,  // Gio VPS (gio Local cua may tinh) - MAC DINH
                        TIME_SOURCE_SERVER = 1, // Gio Broker (gio may chu giao dich)
                        TIME_SOURCE_UTC = 2 };  // Gio UTC/GMT

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

input group "=== BU LENH (mac dinh TAT) ===" input bool InpMakeupEnable = false; // BAT/TAT bu lenh: chan TP1/2/3 con thieu thi dat Limit/Stop tai Entry (chi hoat dong khi InpAllowTrading = true)
input int InpMakeupExpirySec = 300;                                              // N: bu cho tin hieu khong qua N giay tuoi (ke ca da qua InpMaxAgeSec); lenh cho tu huy sau N giay ke tu luc tin hieu phat ra (30..1800)

input group "===== LOC GIO NGUNG VAO LENH (PAUSE TIME FILTER) =====" input bool InpUsePauseFilter = true; // Bat/Tat loc gio ngung vao lenh (Tat = bo qua toan bo Khung 1/2 ben duoi; chi chan VAO THEM lenh, KHONG dong lenh dang mo)
input ENUM_TIME_SOURCE InpFilterTimeSource = TIME_SOURCE_LOCAL;                                           // Nguon gio dung cho Khung gio ngung + gio tin nhap tay (Mac dinh = Gio VPS tuc gio Local cua may tinh)

input string _SP1 = "--- Khung 1: Dem 23:00 den 05:00 (cho phep qua nua dem; ngung vao them lenh) ---"; // ---
input bool InpPause1On = true;                                                                          // Bat/Tat Khung 1
input int InpPause1StartH = 23;                                                                         // Gio bat dau ngung
input int InpPause1StartM = 0;                                                                          // Phut bat dau ngung
input int InpPause1EndH = 5;                                                                            // Gio ket thuc ngung (nho hon gio bat dau = qua nua dem)
input int InpPause1EndM = 0;                                                                            // Phut ket thuc ngung

input string _SP2 = "--- Khung 2: 07:30 den 08:03 (ngung vao them lenh) ---"; // ---
input bool InpPause2On = true;                                                // Bat/Tat Khung 2
input int InpPause2StartH = 7;                                                // Gio bat dau ngung
input int InpPause2StartM = 30;                                               // Phut bat dau ngung
input int InpPause2EndH = 8;                                                  // Gio ket thuc ngung
input int InpPause2EndM = 3;                                                  // Phut ket thuc ngung (het phut nay la duoc vao lenh lai, VD 08:03:00)

input group "===== LOC TIN MANH (NEWS FILTER) =====" input bool InpUseNewsFilter = true; // Bat/Tat tranh giao dich quanh tin manh (chi chan VAO THEM lenh, KHONG dong lenh dang mo)
input int InpNewsBeforeMin = 30;                                                         // Ngung vao lenh TRUOC gio tin N phut (0..720)
input int InpNewsAfterMin = 5;                                                           // Ngung vao lenh SAU gio tin N phut (0..720)

input string _SN1 = "--- Loai tin tu dong (MT5: lay tu Lich kinh te MT5 | MT4: khong co lich, dung danh sach nhap tay ben duoi) ---"; // ---
input string InpNewsCurrency = "USD";                                                                                                 // Dong tien cua tin can tranh (MT5 tu dong)
input bool InpNewsCPI = true;                                                                                                         // Tin CPI (lam phat My: CPI, Core CPI, ...)
input bool InpNewsFed = true;                                                                                                         // Tin Fed (FOMC, quyet dinh lai suat, hop bao, bien ban, Chu tich Fed phat bieu)
input bool InpNewsNFP = true;                                                                                                         // Tin Nonfarm Payrolls (NFP - bang luong phi nong nghiep My)
input bool InpNewsAllHigh = false;                                                                                                    // Chan MOI tin muc anh huong CAO (High impact) cua dong tien tren
input string InpNewsExtraWords = "";                                                                                                  // Tu khoa ten tin bo sung, ngan bang dau ; (VD: PPI;Retail Sales;ISM)

input string _SN2 = "--- Tin nhap tay (MT4 + MT5): moi tin dang yyyy.mm.dd hh:mm, ngan bang dau ; theo Nguon gio da chon o tren ---"; // ---
input string InpNewsManual1 = "";                                                                                                     // Danh sach tin nhap tay 1 (VD: 2026.12.04 20:30;2026.12.10 20:30)
input string InpNewsManual2 = "";                                                                                                     // Danh sach tin nhap tay 2 (dung khi danh sach 1 qua dai)

//+------------------------------------------------------------------+
//| LOC GIO NGUNG VAO LENH + LOC TIN MANH                            |
//| Chi chan VAO THEM lenh (tin hieu moi, thu lai, bu lenh); KHONG   |
//| dong/sua lenh dang mo. Ack: time_block | news_block (ket qua cuoi,|
//| khong phai loi tam thoi nen Server khong giao lai de bu).        |
//+------------------------------------------------------------------+
datetime g_manNews[];     // tin nhap tay (da parse, theo Nguon gio da chon)
string g_blockWhy = "";   // ly do dang chan (de ghi Comment/log)
string g_blockLast = "?"; // trang thai lan truoc (chi Print khi doi)

datetime FtNow() {
    if (InpFilterTimeSource == TIME_SOURCE_UTC)
        return TimeGMT();
    if (InpFilterTimeSource == TIME_SOURCE_SERVER)
        return TimeCurrent();
    return TimeLocal();
}

bool InMinWindow(int nowMin, int sh, int sm, int eh, int em) {
    int s = MathMax(0, MathMin(23, sh)) * 60 + MathMax(0, MathMin(59, sm));
    int e = MathMax(0, MathMin(23, eh)) * 60 + MathMax(0, MathMin(59, em));
    if (s == e)
        return false; // trung nhau = khong co khung
    if (s < e)
        return (nowMin >= s && nowMin < e);
    return (nowMin >= s || nowMin < e); // qua nua dem (VD 23:00 -> 05:00)
}

string PauseBlockText() {
    if (!InpUsePauseFilter)
        return "";
    datetime ft = FtNow();
    int m = TimeHour(ft) * 60 + TimeMinute(ft);
    if (InpPause1On && InMinWindow(m, InpPause1StartH, InpPause1StartM, InpPause1EndH, InpPause1EndM))
        return StringFormat("Khung 1 %02d:%02d-%02d:%02d", InpPause1StartH, InpPause1StartM, InpPause1EndH, InpPause1EndM);
    if (InpPause2On && InMinWindow(m, InpPause2StartH, InpPause2StartM, InpPause2EndH, InpPause2EndM))
        return StringFormat("Khung 2 %02d:%02d-%02d:%02d", InpPause2StartH, InpPause2StartM, InpPause2EndH, InpPause2EndM);
    return "";
}

void AddManualNews(string s) {
    StringTrimLeft(s);
    StringTrimRight(s);
    if (s == "")
        return;
    if (StringLen(s) < 16 || StringGetCharacter(s, 4) != '.' || StringGetCharacter(s, 7) != '.') {
        Print("OceanRelay: tin nhap tay sai dinh dang, bo qua: '", s, "' (can yyyy.mm.dd hh:mm)");
        return;
    }
    datetime t = StringToTime(s);
    if (t <= 0) {
        Print("OceanRelay: tin nhap tay khong doc duoc, bo qua: '", s, "'");
        return;
    }
    int k = ArraySize(g_manNews);
    ArrayResize(g_manNews, k + 1);
    g_manNews[k] = t;
}

void ParseManualNews() {
    ArrayResize(g_manNews, 0);
    string all = InpNewsManual1 + ";" + InpNewsManual2;
    string tk[];
    int n = StringSplit(all, ';', tk);
    for (int i = 0; i < n; i++)
        AddManualNews(tk[i]);
    if (ArraySize(g_manNews) > 0)
        Print("OceanRelay: da nap ", ArraySize(g_manNews), " tin nhap tay (theo Nguon gio da chon)");
}

string ManualNewsBlockText() {
    int n = ArraySize(g_manNews);
    if (n == 0)
        return "";
    datetime ft = FtNow();
    int b = MathMax(0, MathMin(720, InpNewsBeforeMin)) * 60, a = MathMax(0, MathMin(720, InpNewsAfterMin)) * 60;
    for (int i = 0; i < n; i++)
        if (ft >= g_manNews[i] - b && ft < g_manNews[i] + a)
            return "Tin nhap tay " + TimeToString(g_manNews[i], TIME_DATE | TIME_MINUTES);
    return "";
}

string NewsBlockText() {
    if (!InpUseNewsFilter)
        return "";
    string r = "";
    if (r != "")
        return r;
    return ManualNewsBlockText();
}

// Tra ve "" = duoc vao lenh | "time_block" | "news_block". g_blockWhy = ly do. Print khi trang thai doi.
string EntryBlocked() {
    string code = "";
    g_blockWhy = PauseBlockText();
    if (g_blockWhy != "")
        code = "time_block";
    else {
        g_blockWhy = NewsBlockText();
        if (g_blockWhy != "")
            code = "news_block";
    }
    string st = code + "|" + g_blockWhy;
    if (st != g_blockLast) {
        g_blockLast = st;
        if (code != "")
            Print("OceanRelay: NGUNG VAO LENH (", code, ") - ", g_blockWhy);
        else
            Print("OceanRelay: het ngung, duoc vao lenh tro lai");
    }
    return code;
}

string TimeSourceLabel() {
    if (InpFilterTimeSource == TIME_SOURCE_UTC)
        return "gio UTC";
    if (InpFilterTimeSource == TIME_SOURCE_SERVER)
        return "gio Broker";
    return "gio VPS/Local";
}

string BlockLabel() {
    string p = !InpUsePauseFilter ? "TAT" : ((InpPause1On || InpPause2On) ? "BAT" : "BAT (ca 2 khung TAT)");
    string n = !InpUseNewsFilter ? "TAT" : (StringFormat("BAT (-%dp/+%dp)", InpNewsBeforeMin, InpNewsAfterMin));
    return "Loc gio: " + p + " [" + TimeSourceLabel() + "] | Loc tin: " + n + (g_blockWhy != "" ? "  >> DANG NGUNG: " + g_blockWhy : "");
}

string g_acks = ""; // "12:received,13:received" gui kem o ping ke tiep
ulong g_seen[64];   // id tin hieu da xu ly (tranh log lap khi Gateway giao lai truoc khi ack toi noi)
int g_seenN = 0;
uint g_nextPingMs = 0;
int g_fail = 0;
string g_last = "chua co tin hieu";
int g_pingN = 0; // dem nhip ping: cu moi 10 nhip gui kem cfg= (Setup cua EA)

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
    ParseManualNews();
    // Tre ngau nhien 0-2 giay truoc ping dau de nhieu EA khong ban cung luc.
    g_nextPingMs = GetTickCount() + (uint)(MathRand() % 2000);
    Print("OceanRelay ", EA_VER, " san sang. Gateway=", InpGateway, InpAllowTrading ? " | DANH LENH: BAT" : " | DANH LENH: TAT (chi theo doi)",
          " | BREAKEVEN: ", BeLabel(), " | BU LENH: ", MakeupLabel(), " | ", BlockLabel());
    if (InpAllowTrading && !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
        Print("OceanRelay: CANH BAO - Algo Trading dang tat tren terminal.");
    return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) {
    EventKillTimer();
    Comment("");
}

void OnTimer() {
    EntryBlocked();    // moi giay: cap nhat trang thai loc gio/tin (log khi doi)
    CleanupPending();  // moi giay: huy lenh bu qua han (lop du phong ngoai han cua san)
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
    body += "ord=" + BuildOrders() + "\n";
    if (g_pingN % 10 == 0)
        body += "cfg=" + BuildCfg() + "\n";
    g_pingN++;
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
string GvName(ulong id) {
    return "OCEAN_" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "_" + (string)id;
}
bool Done(ulong id) {
    return GlobalVariableCheck(GvName(id));
}
void MarkDone(ulong id) {
    GlobalVariableSet(GvName(id), (double)TimeCurrent());
}

//+------------------------------------------------------------------+
//| Dong tin hieu:                                                   |
//|  S|id|side|symbol|tf|entry|sl|tp1|tp2|tp3|ageSec                 |
//|  U|id|side|status|symbol|tf|entry|sl|tp|ageSec                   |
//| Ket qua ack: opened:N | pending:N | opened:D+pending:P |         |
//|  partial:D/N_<ly do> | trading_off | too_old | price_dev |        |
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
            // Server giao LAI tin hieu con do (ack cu: partial/loi tam thoi) de EA bu lenh. Chi lam khi: bat bu lenh, tin hieu da duoc
            // EA nay danh dau, va chua ket thuc han (ket qua cuoi khong con thieu).
            string r0 = "received";
            if (f[0] == "S" && nf >= 11 && MakeupOn() && Done(id) && !IsFinal(id))
                r0 = MakeupRedeliver(id, f[2], f[3], StringToDouble(f[5]), StringToDouble(f[6]),
                                     StringToDouble(f[7]), StringToDouble(f[8]), StringToDouble(f[9]), (int)StringToInteger(f[10]));
            AddAck(id, r0);
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

string SeqGv() {
    return "OCEANSEQ_" + (string)AccountInfoInteger(ACCOUNT_LOGIN);
}

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
//| BU LENH (MAKEUP)                                                 |
//| Chan TP1/2/3 con thieu (loi san/terminal, gia di xa Entry, tin   |
//| hieu den tre) thi DAT LENH CHO tai Entry:                        |
//|   MUA : Entry < Ask -> Buy Limit ; Entry > Ask -> Buy Stop       |
//|   BAN : Entry > Bid -> Sell Limit; Entry < Bid -> Sell Stop      |
//| (gia dang trong sai so InpMaxDevPoints cua Entry thi vao thi     |
//| truong nhu thuong). Lenh cho cung SL/TP/comment cua chan do, tu  |
//| huy sau N giay ke tu luc tin hieu phat ra. Moi chan duoc kiem    |
//| tra truoc (vi the, lenh cho, lich su 1 gio) nen khong mo lap.    |
//| Server giao LAI tin hieu con do (kiem tra ack); tin hieu do EA   |
//| doi cu xu ly (khong co so thu tu luu) thi bo qua khi nang cap.   |
//+------------------------------------------------------------------+
bool MakeupOn() {
    return InpAllowTrading && InpMakeupEnable;
}
int MakeupSec() {
    return MathMax(30, MathMin(1800, InpMakeupExpirySec));
}
string MakeupLabel() {
    if (!InpMakeupEnable)
        return "TAT";
    return (InpAllowTrading ? "BAT" : "BAT (nhung DANH LENH dang TAT)") + " (Limit/Stop, het han " + IntegerToString(MakeupSec()) + "s)";
}

string LoginStr() {
    return (string)AccountInfoInteger(ACCOUNT_LOGIN);
}
string IdGv(ulong id) {
    return "OCEANID_" + LoginStr() + "_" + (string)id;
} // = yyyymmdd*10000 + so thu tu lenh cua tin hieu
string FinGv(ulong id) {
    return "OCEANFIN_" + LoginStr() + "_" + (string)id;
} // tin hieu da xong han (khong con thieu)
string PxGv(ulong ticket) {
    return "OCEANPX_" + LoginStr() + "_" + (string)ticket;
} // gio server het han cua lenh cho
bool IsFinal(ulong id) {
    return GlobalVariableCheck(FinGv(id));
}

bool LookupSeq(ulong id, int& seq, int& day) {
    if (!GlobalVariableCheck(IdGv(id)))
        return false;
    double v = GlobalVariableGet(IdGv(id));
    day = (int)MathFloor(v / 10000.0);
    seq = (int)MathRound(v - (double)day * 10000.0);
    return seq > 0;
}

// Loi giao dich tam thoi (phai khop TRANSIENT_RC o src/shared/makeup.ts): 4 server ban, 6 mat ket noi, 8 qua nhieu yeu cau, 128 timeout,
// 135 gia doi, 136 off quotes, 137 broker ban, 138 requote, 141 qua nhieu yeu cau, 146 trade context ban.
bool IsTransientErr(int e) {
    return e == 4 || e == 6 || e == 8 || e == 128 || e == 135 || e == 136 || e == 137 || e == 138 || e == 141 || e == 146;
}
bool TransientReasonText(string r) {
    if (r == "no_connection" || r == "retry_timeout" || r == "no_quote")
        return true;
    if (StringFind(r, "failed:") == 0 || StringFind(r, "failed_") == 0)
        return IsTransientErr((int)StringToInteger(StringSubstr(r, 7)));
    return false;
}
// Ket qua ack co nghia "con thieu chan vi loi tam thoi" (Server se giao lai)? Phai khop isIncompleteResult o src/shared/makeup.ts.
bool EaIncomplete(string res) {
    if (StringFind(res, "retry:") == 0)
        return true;
    if (StringFind(res, "partial:") == 0) {
        int u = StringFind(res, "_");
        return u > 0 && TransientReasonText(StringSubstr(res, u + 1));
    }
    return TransientReasonText(res);
}
void MarkFinal(ulong id, string res) {
    if (!EaIncomplete(res))
        GlobalVariableSet(FinGv(id), (double)TimeCurrent());
}

bool IsPendingOp(int ty) {
    return ty == OP_BUYLIMIT || ty == OP_SELLLIMIT || ty == OP_BUYSTOP || ty == OP_SELLSTOP;
}

double TotalPendingLots() {
    double t = 0;
    for (int i = 0; i < OrdersTotal(); i++) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
            continue;
        if (OrderMagicNumber() != InpMagic || !IsPendingOp(OrderType()))
            continue;
        t += OrderLots();
    }
    return t;
}
// Lenh cho cung tinh vao han muc InpMaxTotalLots vi chung se thanh vi the khi khop.
double TotalExposureLots() {
    return TotalOpenLots() + TotalPendingLots();
}

// Trang thai chan TPn cua tin hieu (seq, day): 0 = chua co; 1 = da vao san (dang mo, hoac vua mo/dong trong 1 gio qua); 2 = dang co lenh CHO.
int LegState(int seq, int day, int tpn) {
    string want = StringFormat("%s#%d/TP%d", InpComment, seq, tpn);
    for (int i = OrdersTotal() - 1; i >= 0; i--) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
            continue;
        if (OrderMagicNumber() != InpMagic)
            continue;
        if (StringFind(OrderComment(), want) != 0)
            continue;
        if (DayOf(OrderOpenTime()) != day)
            continue;
        int ty = OrderType();
        return (ty == OP_BUY || ty == OP_SELL) ? 1 : 2;
    }
    datetime from = TimeCurrent() - 3600;
    for (int i = OrdersHistoryTotal() - 1; i >= 0; i--) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY))
            continue;
        if (OrderMagicNumber() != InpMagic)
            continue;
        int ty = OrderType();
        if (ty != OP_BUY && ty != OP_SELL)
            continue;
        if (OrderOpenTime() < from)
            continue;
        if (StringFind(OrderComment(), want) != 0)
            continue;
        if (DayOf(OrderOpenTime()) != day)
            continue;
        return 1;
    }
    return 0;
}

// Co lenh cho (Limit/Stop) cua nhom (seq, day) voi so TP <= upTo khong? (BreakEven chua toi luc khi con chan thap hon dang cho khop.)
bool HasPendingLeg(int seq, int day, int upTo) {
    for (int i = OrdersTotal() - 1; i >= 0; i--) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
            continue;
        if (OrderMagicNumber() != InpMagic || !IsPendingOp(OrderType()))
            continue;
        int ps = 0, tpn = 0;
        if (!ParseComment(OrderComment(), ps, tpn))
            continue;
        if (ps == seq && tpn <= upTo && DayOf(OrderOpenTime()) == day)
            return true;
    }
    return false;
}

// Dat 1 lenh cho tai Entry. true = da dat (ghi gio het han vao Global Variable). err = ma loi khi that bai.
bool PlacePending(string sym, bool buy, double lot, double entry, double sl, double tp, string cm, datetime expAt, double px, int& err) {
    int dg = (int)MarketInfo(sym, MODE_DIGITS);
    double en = NormalizeDouble(entry, dg);
    int cmd;
    if (buy)
        cmd = (en < px) ? OP_BUYLIMIT : OP_BUYSTOP;
    else
        cmd = (en > px) ? OP_SELLLIMIT : OP_SELLSTOP;
    for (int pass = 0; pass < 2; pass++) {
        datetime ex = (pass == 0) ? expAt : 0; // lan 2: san khong cho dat han lenh (147) thi dat khong han, EA tu huy (CleanupPending)
        ResetLastError();
        int tk = OrderSend(sym, cmd, lot, en, 0, NormalizeDouble(sl, dg), NormalizeDouble(tp, dg), cm, InpMagic, ex, clrNONE);
        if (tk > 0) {
            GlobalVariableSet(PxGv((ulong)tk), (double)expAt);
            return true;
        }
        err = GetLastError();
        if (!(pass == 0 && err == 147))
            break;
    }
    return false;
}

// Bu cac chan con thieu cua mot tin hieu da duoc danh dau (seq, day). Chan da co vi the/lenh cho thi bo qua (khong mo lap).
// why0 = ly do ban dau (neu khong dat/bu duoc chan nao thi ack = ly do nay). Tra ve chuoi ack:
//   opened:N | pending:P | opened:D+pending:P | partial:(D+P)/N_<ly do> | <ly do>
string MakeupLegs(ulong id, int seq, int day, bool buy, string sym, double entry, double sl,
                  double tp1, double tp2, double tp3, double lot, datetime recv, string why0) {
    int n = InpTP3Only ? 1 : 3;
    double tps[3];
    tps[0] = tp1;
    tps[1] = tp2;
    tps[2] = tp3;
    string why = why0;
    int d = 0, p = 0;
    bool stop = false;

    double ask = MarketInfo(sym, MODE_ASK), bid = MarketInfo(sym, MODE_BID), pt = MarketInfo(sym, MODE_POINT);
    int dg = (int)MarketInfo(sym, MODE_DIGITS);
    double px = buy ? ask : bid;
    double minDist = MarketInfo(sym, MODE_STOPLEVEL) * pt;
    double tol = InpMaxDevPoints > 0 ? InpMaxDevPoints * pt : 0.0;
    bool canTrade = true;
    string blk = EntryBlocked(); // khong dat lenh bu trong khung ngung / gan tin
    if (!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) {
        why = "trading_off";
        stop = true;
    } else if (blk != "") {
        why = blk;
        stop = true;
        Print("OceanRelay: bu lenh #", id, " bi chan - ", g_blockWhy);
    } else if (!TerminalInfoInteger(TERMINAL_CONNECTED)) {
        why = "no_connection";
        canTrade = false;
    } else if (ask <= 0 || bid <= 0 || pt <= 0) {
        why = "no_quote";
        canTrade = false;
    } else if ((int)(recv + MakeupSec() - TimeCurrent()) < 5) {
        why = "makeup_expired";
        stop = true;
        Print("OceanRelay: bu lenh #", id, " het cua so ", MakeupSec(), "s");
    } else if (buy ? (px <= sl) : (px >= sl)) {
        why = "bad_levels"; // gia da cham/vuot SL cua tin hieu: tin hieu vo hieu
        stop = true;
        Print("OceanRelay: bu lenh #", id, " gia da toi SL -> khong dat");
    }

    for (int k = 0; k < n; k++) {
        int tpn = InpTP3Only ? 3 : k + 1;
        int st = LegState(seq, day, tpn);
        if (st == 1) {
            d++;
            continue;
        }
        if (st == 2) {
            p++;
            continue;
        }
        if (stop || !canTrade)
            continue; // chan thieu: giu ly do da ghi o tren
        if (TotalExposureLots() + lot > InpMaxTotalLots + 1e-9) {
            why = "max_lots";
            stop = true;
            Print("OceanRelay: bu lenh #", id, " vuot InpMaxTotalLots");
            continue;
        }
        double tp = InpTP3Only ? tp3 : tps[k];
        string cm = StringFormat("%s#%d/TP%d", InpComment, seq, tpn);
        bool nearMkt = MathAbs(px - entry) <= MathMax(tol, minDist) + pt / 2; // dang sat Entry: vao thi truong nhu thuong
        int err = 0;
        bool sent = false;
        if (nearMkt) {
            if (!(buy ? (tp > px) : (tp < px))) {
                why = "bad_levels";
                continue;
            }
            if (MathAbs(tp - px) < minDist || MathAbs(px - sl) < minDist) {
                why = "bad_stops";
                continue;
            }
            ResetLastError();
            int tk = OrderSend(sym, buy ? OP_BUY : OP_SELL, lot, NormalizeDouble(px, dg), InpSlippagePts,
                               NormalizeDouble(sl, dg), NormalizeDouble(tp, dg), cm, InpMagic, 0, clrNONE);
            if (tk > 0) {
                d++;
                continue;
            }
            err = GetLastError();
        } else {
            // Lenh cho: SL va TP cua chan phai cach Entry it nhat stops level.
            if (MathAbs(entry - sl) < minDist || MathAbs(tp - entry) < minDist) {
                why = "bad_stops";
                continue;
            }
            sent = PlacePending(sym, buy, lot, entry, sl, tp, cm, recv + MakeupSec(), px, err);
            if (sent) {
                p++;
                Print("OceanRelay: BU LENH #", id, " chan TP", tpn, " dat lenh cho tai ", DoubleToString(entry, dg), " (gia hien tai ", DoubleToString(px, dg),
                      ", het han sau ", (int)(recv + MakeupSec() - TimeCurrent()), "s)");
                continue;
            }
        }
        why = "failed:" + (string)err;
        Print("OceanRelay: bu lenh #", id, " chan TP", tpn, " that bai retcode=", err, " ", ErrorDescription(err), IsTransientErr(err) ? " -> se bu lai khi Server giao lai" : "");
        if (IsTransientErr(err)) {
            canTrade = false; // dung luot nay; Server giao lai sau 15 giay
            continue;
        }
        if (err == 129 || err == 130)
            continue; // chi chan nay sai gia/muc (129 invalid price, 130 invalid stops), chan khac van thu
        stop = true;  // loi khong the khac phuc (het tien, qua nhieu lenh cho...): ngung
    }

    if (d + p == n) {
        if (p == 0)
            return "opened:" + (string)d;
        if (d == 0)
            return "pending:" + (string)p;
        return "opened:" + (string)d + "+pending:" + (string)p;
    }
    if (why == "")
        why = "retry_timeout";
    if (d + p == 0)
        return why;
    StringReplace(why, ":", "_");
    StringReplace(why, ",", "_");
    return "partial:" + (string)(d + p) + "/" + (string)n + "_" + why;
}

// Server giao lai tin hieu da duoc EA nay danh dau (con thieu chan): bu cac chan chua co vi the/lenh cho. Tra ve ket qua de ack.
string MakeupRedeliver(ulong id, string side, string symbol, double entry, double sl, double tp1, double tp2, double tp3, int ageSec) {
    int seq = 0, day = 0;
    if (!LookupSeq(id, seq, day))
        return "received"; // khong biet chan nao da vao (EA doi cu xu ly): khong dam bu, tranh mo lap
    if (ageSec > MakeupSec())
        return "received";
    string sym = ResolveSymbol(symbol);
    if (sym == "" || MarketInfo(sym, MODE_POINT) <= 0)
        return "no_symbol";
    bool buy = (side == "buy");
    bool ok = buy ? (sl < entry && entry < tp1 && tp1 <= tp2 && tp2 <= tp3) : (sl > entry && entry > tp1 && tp1 >= tp2 && tp2 >= tp3);
    if (!ok)
        return "bad_levels";
    double lot = NormVol(sym, InpTP3Only ? InpLotPerOrder * 3 : InpLotPerOrder);
    Print("OceanRelay: Server giao lai #", id, " (lenh so ", seq, ", ", ageSec, "s) -> kiem tra va bu chan con thieu");
    string res = MakeupLegs(id, seq, day, buy, sym, entry, sl, tp1, tp2, tp3, lot, TimeCurrent() - ageSec, "");
    MarkFinal(id, res);
    Print("OceanRelay: bu lenh #", id, " ket qua: ", res);
    return res;
}

// Moi giay: huy lenh cho cua EA da qua han (lop du phong, phong khi san khong ho tro han lenh).
void CleanupPending() {
    for (int i = OrdersTotal() - 1; i >= 0; i--) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
            continue;
        if (OrderMagicNumber() != InpMagic || !IsPendingOp(OrderType()))
            continue;
        int tk = OrderTicket();
        string nm = PxGv((ulong)tk);
        if (!GlobalVariableCheck(nm))
            continue;
        if (TimeCurrent() < (datetime)GlobalVariableGet(nm))
            continue;
        ResetLastError();
        if (OrderDelete(tk)) {
            Print("OceanRelay: da huy lenh cho bu ", tk, " (het han)");
            GlobalVariableDel(nm);
        } else {
            int err = GetLastError();
            Print("OceanRelay: KHONG huy duoc lenh cho ", tk, " retcode=", err, " ", ErrorDescription(err));
        }
    }
}

// Lenh cho gui len Server: ticket,symbol,type,vol,price,sl,tp,conLaiGiay;...  (type: buylimit|buystop|selllimit|sellstop)
string BuildOrders() {
    string s = "";
    int cnt = 0;
    for (int i = 0; i < OrdersTotal() && cnt < 50; i++) {
        if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
            continue;
        if (OrderMagicNumber() != InpMagic)
            continue;
        int ty = OrderType();
        string t = "";
        if (ty == OP_BUYLIMIT)
            t = "buylimit";
        else if (ty == OP_BUYSTOP)
            t = "buystop";
        else if (ty == OP_SELLLIMIT)
            t = "selllimit";
        else if (ty == OP_SELLSTOP)
            t = "sellstop";
        else
            continue;
        string sym0 = OrderSymbol();
        int dg = (int)MarketInfo(sym0, MODE_DIGITS);
        string sym = sym0;
        StringReplace(sym, ",", "_");
        StringReplace(sym, ";", "_");
        int tk = OrderTicket();
        string left = "";
        string nm = PxGv((ulong)tk);
        if (GlobalVariableCheck(nm))
            left = IntegerToString(MathMax(0, (int)((datetime)GlobalVariableGet(nm) - TimeCurrent())));
        s += StringFormat("%d,%s,%s,%.2f,%s,%s,%s,%s;", tk, sym, t, OrderLots(),
                          DoubleToString(OrderOpenPrice(), dg),
                          DoubleToString(OrderStopLoss(), dg),
                          DoubleToString(OrderTakeProfit(), dg), left);
        cnt++;
    }
    return s;
}

// Setup (input) gui len Server de hien tren giao dien va de Server biet EA co bat bu lenh khong. Khong gui dia chi Gateway/Terminal ID.
string CfgKv(string k, string v) {
    StringReplace(v, ";", " ");
    StringReplace(v, "=", " ");
    StringReplace(v, "\n", " ");
    StringReplace(v, "\r", " ");
    return k + "=" + v + ";";
}
string B01(bool v) {
    return v ? "1" : "0";
}
string BuildCfg() {
    string s = "";
    s += CfgKv("InpAllowTrading", B01(InpAllowTrading));
    s += CfgKv("InpLotPerOrder", DoubleToString(InpLotPerOrder, 2));
    s += CfgKv("InpMaxTotalLots", DoubleToString(InpMaxTotalLots, 2));
    s += CfgKv("InpMaxAgeSec", IntegerToString(InpMaxAgeSec));
    s += CfgKv("InpMaxDevPoints", IntegerToString(InpMaxDevPoints));
    s += CfgKv("InpSlippagePts", IntegerToString(InpSlippagePts));
    s += CfgKv("InpTP3Only", B01(InpTP3Only));
    s += CfgKv("InpMagic", IntegerToString(InpMagic));
    s += CfgKv("InpComment", InpComment);
    s += CfgKv("InpMakeupEnable", B01(InpMakeupEnable));
    s += CfgKv("InpMakeupExpirySec", IntegerToString(MakeupSec()));
    s += CfgKv("InpBEEnable", B01(InpBEEnable));
    s += CfgKv("InpBETrigger", IntegerToString((int)InpBETrigger));
    s += CfgKv("InpBEOffset", DoubleToString(InpBEOffset, 2));
    s += CfgKv("InpBEUnit", IntegerToString((int)InpBEUnit));
    s += CfgKv("InpBELockProfit", B01(InpBELockProfit));
    s += CfgKv("InpUsePauseFilter", B01(InpUsePauseFilter));
    s += CfgKv("InpUseNewsFilter", B01(InpUseNewsFilter));
    s += CfgKv("InpNewsBeforeMin", IntegerToString(InpNewsBeforeMin));
    s += CfgKv("InpNewsAfterMin", IntegerToString(InpNewsAfterMin));
    return s;
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
    string blkEntry = EntryBlocked();
    if (blkEntry != "") {
        Print("OceanRelay: bo #", id, " - ", g_blockWhy);
        return blkEntry;
    }
    // Tin hieu qua han thuong: neu bat bu lenh va con trong cua so N giay thi KHONG bo, chuyen sang dat bu lenh cho (Limit/Stop).
    bool stale = (ageSec > InpMaxAgeSec);
    if (stale && !(MakeupOn() && ageSec <= MakeupSec())) {
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

    // Thu tu muc theo Entry: mua SL < Entry < TP1 <= TP2 <= TP3, ban nguoc lai.
    bool ordOk = buy ? (sl < entry && entry < tp1 && tp1 <= tp2 && tp2 <= tp3) : (sl > entry && entry > tp1 && tp1 >= tp2 && tp2 >= tp3);
    if (!ordOk) {
        Print("OceanRelay: bo #", id, " SL/TP sai phia so voi Entry");
        return "bad_levels";
    }
    int n = InpTP3Only ? 1 : 3;
    double lotEach = NormVol(symbol, InpTP3Only ? InpLotPerOrder * 3 : InpLotPerOrder);
    if (TotalExposureLots() + lotEach * n > InpMaxTotalLots + 1e-9) {
        Print("OceanRelay: bo #", id, " vuot InpMaxTotalLots");
        return "max_lots";
    }

    bool dev = (InpMaxDevPoints > 0 && MathAbs(px - entry) > InpMaxDevPoints * pt);
    if (stale || dev) {
        if (!MakeupOn()) {
            Print("OceanRelay: bo #", id, " gia lech Entry ", DoubleToString(MathAbs(px - entry) / pt, 0), " point");
            return "price_dev";
        }
        // Tin hieu tre hoac gia da di xa Entry: khong duoi theo gia, dat lenh cho (Limit/Stop) tai Entry cho ca cac chan.
        MarkDone(id);
        int bday = 0;
        int bseq = NextSeq(bday);
        GlobalVariableSet(IdGv(id), (double)bday * 10000.0 + (double)bseq);
        Print("OceanRelay: tin hieu #", id, " -> lenh so ", bseq, " cua ngay ", bday, stale ? " (qua han thuong -> bu lenh)" : " (gia lech Entry -> bu lenh)");
        string rb = MakeupLegs(id, bseq, bday, buy, symbol, entry, sl, tp1, tp2, tp3, lotEach, TimeCurrent() - ageSec, stale ? "retry_timeout" : "price_dev");
        MarkFinal(id, rb);
        Print("OceanRelay: #", id, " (lenh so ", bseq, ") bu lenh: ", rb);
        return rb;
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

    // Ghi nho id TRUOC khi goi san: loi giua chung thi khong bao gio mo lap.
    MarkDone(id);
    int seqDay = 0;
    int seq = NextSeq(seqDay);
    GlobalVariableSet(IdGv(id), (double)seqDay * 10000.0 + (double)seq);
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
    string res;
    if (opened == n)
        res = "opened:" + (string)opened;
    else if (MakeupOn() && IsTransientErr(lastRc)) {
        // Loi tam thoi (mat ket noi, requote, timeout...): dat lenh cho tai Entry cho cac chan con thieu.
        res = MakeupLegs(id, seq, seqDay, buy, symbol, entry, sl, tp1, tp2, tp3, lotEach, TimeCurrent() - ageSec, "failed:" + (string)lastRc);
    } else if (opened == 0)
        res = "failed:" + (string)lastRc;
    else
        res = "partial:" + (string)opened + "/" + (string)n + "_failed_" + (string)lastRc;
    MarkFinal(id, res);
    return res;
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

ulong BeKeyOf(int day, int seq) {
    return (ulong)day * 10000 + (ulong)seq;
}
string BeGv(ulong key) {
    return "OCEANBE_" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "_" + (string)key;
}

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
    // Chan bu (lenh cho khop sau) co the mo muon hon cac chan khac toi InpMakeupExpirySec giay: noi rong cua so.
    long tol = 300 + (MakeupOn() ? (long)MakeupSec() : 0);
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
        if (MathAbs((long)OrderOpenTime() - (long)tRef) > tol)
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
        if (HasPendingLeg(g_bgSeqs[g], g_bgDays[g], trig))
            continue; // chan TP<=trig con dang cho khop (lenh bu): chua toi luc doi SL
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
            "Bu lenh: ", MakeupLabel(), "\n",
            BlockLabel(), "\n",
            "Tin hieu cuoi: ", g_last);
}