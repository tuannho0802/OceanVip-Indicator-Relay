import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PARAM_KEYS, REMOTE_PARAMS, checkParam, paramsLine, parseValuesJson, pickSetup, sanitizeParamsItem, sanitizePatch, validateParamsLine } from '../src/shared/params'
import { sanitizeAccountReports } from '../src/shared/switch'

/**
 * Tuỳ chỉnh input EA từ xa — phần dùng chung: danh sách cho phép, kiểm giá trị, dòng P| gửi cho EA,
 * và các kiểm tra giữ cho EA (MQ5/MQ4) không lệch khỏi danh sách này.
 */
const spec = (k: string) => REMOTE_PARAMS.find((p) => p.key === k)!

describe('danh sách input được chỉnh từ xa', () => {
    it('không chứa các input nhạy cảm: công tắc tổng, địa chỉ Gateway, magic, comment, Terminal ID', () => {
        for (const k of ['InpAllowTrading', 'InpGateway', 'InpMagic', 'InpComment', 'InpTerminalId', 'InpPingSec', 'InpTimeoutMs', 'InpAutoSymbol', 'InpNewsExtraWords', 'InpNewsManual1']) {
            expect(PARAM_KEYS).not.toContain(k)
        }
    })

    it('khóa không trùng, khoảng giá trị hợp lý', () => {
        expect(new Set(PARAM_KEYS).size).toBe(PARAM_KEYS.length)
        for (const p of REMOTE_PARAMS) expect(p.min).toBeLessThanOrEqual(p.max)
    })
})

describe('checkParam', () => {
    it('bool: chỉ nhận true/false/0/1', () => {
        expect(checkParam(spec('InpTP3Only'), true)).toBe(1)
        expect(checkParam(spec('InpTP3Only'), 0)).toBe(0)
        expect(checkParam(spec('InpTP3Only'), '1')).toBe(1)
        expect(checkParam(spec('InpTP3Only'), 2)).toBeNull()
        expect(checkParam(spec('InpTP3Only'), 'yes')).toBeNull()
    })

    it('số thực: kẹp theo khoảng (ngoài khoảng là từ chối), làm tròn theo dp', () => {
        expect(checkParam(spec('InpLotPerOrder'), 0.0149)).toBe(0.01)
        expect(checkParam(spec('InpLotPerOrder'), 0)).toBeNull()
        expect(checkParam(spec('InpLotPerOrder'), 101)).toBeNull()
        expect(checkParam(spec('InpSLExtend'), -0.5)).toBe(-0.5)
        expect(checkParam(spec('InpSLExtend'), 'abc')).toBeNull()
        expect(checkParam(spec('InpSLExtend'), Number.NaN)).toBeNull()
        expect(checkParam(spec('InpSLExtend'), Number.POSITIVE_INFINITY)).toBeNull()
        expect(checkParam(spec('InpSLExtend'), '1e3')).toBeNull() // không nhận ký hiệu khoa học
    })

    it('số nguyên + liệt kê: phải là số nguyên và nằm trong tập cho phép', () => {
        expect(checkParam(spec('InpMaxAgeSec'), 60)).toBe(60)
        expect(checkParam(spec('InpMaxAgeSec'), 60.5)).toBeNull()
        expect(checkParam(spec('InpBETrigger'), 2)).toBe(2)
        expect(checkParam(spec('InpBETrigger'), 3)).toBeNull()
        expect(checkParam(spec('InpBETrigger'), 0)).toBeNull()
        expect(checkParam(spec('InpPause1StartH'), 24)).toBeNull()
        expect(checkParam(spec('InpPause1StartH'), 23)).toBe(23)
    })
})

describe('sanitizePatch', () => {
    it('đặt + bỏ ghi đè trong một bản vá', () => {
        const r = sanitizePatch({ InpLotPerOrder: 0.05, InpBEEnable: true, InpMaxAgeSec: null })
        expect(r).toEqual({ ok: true, set: { InpLotPerOrder: 0.05, InpBEEnable: 1 }, unset: ['InpMaxAgeSec'] })
    })

    it('khóa lạ hoặc không được phép => từ chối CẢ bản vá (không áp nửa chừng)', () => {
        const a = sanitizePatch({ InpLotPerOrder: 0.05, InpAllowTrading: true })
        expect(a.ok).toBe(false)
        expect(sanitizePatch({ InpGateway: 'http://evil' }).ok).toBe(false)
        expect(sanitizePatch({ __proto__: 1, constructor: 2 } as never).ok).toBe(false)
        expect(sanitizePatch({ InpLotPerOrder: 999 }).ok).toBe(false)
        expect(sanitizePatch({ InpLotPerOrder: 0.05, InpMaxAgeSec: 0 }).ok).toBe(false)
    })

    it('không phải object / rỗng', () => {
        for (const v of [null, undefined, 5, 'x', [], {}]) expect(sanitizePatch(v).ok).toBe(false)
    })
})

describe('dòng P| gửi cho EA', () => {
    it('paramsLine -> validateParamsLine khép kín, theo thứ tự danh sách, số thực đủ chữ số', () => {
        const line = paramsLine(7, { InpMaxAgeSec: 90, InpLotPerOrder: 0.1, InpBEEnable: 1, InpSLExtend: -0.5 })
        expect(line).toBe('P|rev=7;InpLotPerOrder=0.10;InpMaxAgeSec=90;InpSLExtend=-0.50;InpBEEnable=1')
        expect(validateParamsLine(line)).toBe(line)
    })

    it('bộ rỗng vẫn hợp lệ: EA quay về input của chính nó', () => {
        expect(paramsLine(3, {})).toBe('P|rev=3')
        expect(validateParamsLine('P|rev=3')).toBe('P|rev=3')
    })

    it('Gateway từ chối dòng sai: khóa không cho phép, giá trị ngoài khoảng, ký hiệu khoa học, xuống dòng, thiếu rev', () => {
        for (const bad of [
            'P|rev=1;InpAllowTrading=1',
            'P|rev=1;InpGateway=1',
            'P|rev=1;InpLotPerOrder=100000',
            'P|rev=1;InpLotPerOrder=1e2',
            'P|rev=1;InpMaxAgeSec=1.5',
            'P|rev=1;InpBETrigger=9',
            'P|rev=1\nS|1|buy|XAUUSD|M3|1|1|1|1|1|0',
            'P|InpLotPerOrder=0.1',
            'P|rev=1;InpLotPerOrder=0.1;',
            'P|rev=x',
            'R|0',
        ]) expect(validateParamsLine(bad)).toBeNull()
    })
})

describe('bộ ghi đè đã lưu / lệnh từ Worker', () => {
    it('parseValuesJson bỏ khóa lạ và giá trị hỏng (an toàn khi đọc lại từ DB)', () => {
        expect(parseValuesJson('{"InpLotPerOrder":0.2,"InpAllowTrading":1,"InpMaxAgeSec":-5}')).toEqual({ InpLotPerOrder: 0.2 })
        expect(parseValuesJson('không phải json')).toEqual({})
        expect(parseValuesJson(null)).toEqual({})
    })

    it('sanitizeParamsItem: login chỉ chữ số, rev/at là số nguyên', () => {
        expect(sanitizeParamsItem({ login: '123', rev: 2, at: 10, values: { InpLotPerOrder: 0.1, InpMagic: 5 } })).toEqual({ login: '123', rev: 2, at: 10, values: { InpLotPerOrder: 0.1 } })
        expect(sanitizeParamsItem({ login: '12a', rev: 2, at: 10, values: {} })).toBeNull()
        expect(sanitizeParamsItem({ login: '123', rev: 0, at: 10, values: {} })).toBeNull()
        expect(sanitizeParamsItem({ login: '123', rev: 1.5, at: 10, values: {} })).toBeNull()
    })
})

describe('báo cáo tài khoản có setup', () => {
    it('chỉ giữ khóa tuỳ chỉnh được; khóa khác (Gateway, Magic...) không lên Worker', () => {
        const r = sanitizeAccountReports([{ login: '1', broker: 'X', enabled: true, rev: 0, params_rev: 2, ea_rev: 1, setup: { InpLotPerOrder: '0.10', InpMagic: '20261109', InpComment: 'OCEAN', InpAllowTrading: '1', InpMaxAgeSec: 'abc' } }])
        expect(r).toEqual([{ login: '1', broker: 'X', enabled: true, rev: 0, params_rev: 2, ea_rev: 1, setup: { InpLotPerOrder: '0.10' } }])
    })

    it('Server đời cũ (không có trường mới) vẫn đọc được', () => {
        expect(sanitizeAccountReports([{ login: '1', broker: null, enabled: true, rev: 0 }])).toEqual([{ login: '1', broker: null, enabled: true, rev: 0 }])
    })

    it('pickSetup lọc theo danh sách và định dạng lại', () => {
        expect(pickSetup({ InpMaxDevPips: '10.0', InpMagic: '1' })).toEqual({ InpMaxDevPips: '10.0' })
        expect(pickSetup(null)).toEqual({})
    })
})

describe('EA không lệch khỏi danh sách cho phép (MQ5 + MQ4)', () => {
    const ea = { mq5: readFileSync('ea/OceanRelay.mq5', 'utf8'), mq4: readFileSync('ea/OceanRelay.mq4', 'utf8') }

    for (const [name, src] of Object.entries(ea)) {
        it(`${name}: RvSet chỉ chứa khóa của danh sách, khoảng giá trị khớp, và không có InpAllowTrading`, () => {
            const re = /k == "(Inp\w+)"\)\s*rv_\1 = (?:\((?:ENUM_\w+)\))?Rv([DIB])\(v(?:, (-?[\d.]+), (-?[\d.]+))?\)/g
            const found = [...src.matchAll(re)]
            expect(found.length).toBeGreaterThan(30)
            for (const m of found) {
                const p = spec(m[1] as string)
                expect(p, `${m[1]} không có trong REMOTE_PARAMS`).toBeDefined()
                const kind = m[2]
                expect(kind).toBe(p.type === 'bool' ? 'B' : p.type === 'int' ? 'I' : 'D')
                if (kind !== 'B') {
                    expect(Number(m[3])).toBe(p.min)
                    expect(Number(m[4])).toBe(p.max)
                }
            }
            expect(src).not.toMatch(/k == "InpAllowTrading"/)
            expect(src).not.toMatch(/k == "InpGateway"/)
            expect(src).not.toMatch(/k == "InpMagic"/)
        })

        it(`${name}: có đường nhận dòng P|, báo prev=, và áp xong gửi cfg= ngay`, () => {
            expect(src).toContain('StringFind(lines[i], "P|") == 0')
            expect(src).toContain('ApplyRemoteParams(StringSubstr(lines[i], 2))')
            expect(src).toContain('body += "prev=" + IntegerToString(g_paramsRev)')
            expect(src).toMatch(/g_pingN = 0;/)
        })

        it(`${name}: mọi lần dùng input chỉnh được đều đi qua bản sao rv_ (trừ khai báo và RvReset)`, () => {
            const keys = [...src.matchAll(/k == "(Inp\w+)"\)\s*rv_/g)].map((m) => m[1] as string)
            const lines = src.replace(/\r/g, '').split('\n')
            for (const k of keys) {
                const re = new RegExp(`(?<![\\w"])${k}\\b`)
                for (const [i, raw] of lines.entries()) {
                    const ln = raw.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/, '')
                    if (!re.test(ln)) continue
                    const ok = /^\s*input\b/.test(raw) || new RegExp(`^\\s*rv_${k} = ${k};`).test(raw)
                    expect(ok, `${name}:${i + 1} còn dùng thẳng ${k}: ${raw.trim().slice(0, 80)}`).toBe(true)
                }
            }
        })
    }

    it('MQ5 báo đủ mọi khóa của danh sách trong cfg= (để Server/Worker thấy giá trị đang dùng)', () => {
        for (const k of PARAM_KEYS) expect(ea.mq5, k).toContain(`CfgKv("${k}"`)
    })
})