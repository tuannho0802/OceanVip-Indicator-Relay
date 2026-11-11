import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TRANSIENT_RC, isIncompleteResult, makeupWindow, parseCfgLine } from '../src/shared/makeup'

/**
 * EA (MQL4/MQL5) không biên dịch được trong CI, nên test này giữ "hợp đồng" giữa EA và Server ở mức văn bản:
 * khóa cfg mà Server đọc, dòng ord/cfg trong ping, danh sách mã lỗi tạm thời và định dạng ack bù lệnh.
 */
const EAS = { mq5: readFileSync('ea/OceanRelay.mq5', 'utf8'), mq4: readFileSync('ea/OceanRelay.mq4', 'utf8') }

describe.each(Object.entries(EAS))('EA %s', (_name, src) => {
  it('có input bù lệnh (mặc định TẮT) và báo khóa Server cần trong cfg', () => {
    expect(src).toMatch(/InpMakeupEnable\s*=\s*false/)
    expect(src).toMatch(/InpMakeupExpirySec\s*=\s*300/)
    for (const k of ['InpAllowTrading', 'InpMakeupEnable', 'InpMakeupExpirySec', 'InpLotPerOrder', 'InpBEEnable', 'InpBETrigger']) {
      expect(src, k).toContain(`CfgKv("${k}"`)
    }
  })
  it('ping có ord= mỗi nhịp và cfg= định kỳ', () => {
    expect(src).toContain('"ord=" + BuildOrders()')
    expect(src).toContain('"cfg=" + BuildCfg()')
  })
  it('bản EA_VER mới hơn bản không có bù lệnh', () => {
    const v = /#define EA_VER "(\d+\.\d+\.\d+)"/.exec(src)?.[1] ?? ''
    expect(v).toMatch(/^0\.[34]\.\d+$/)
  })
  it('chỉ gửi cfg không chứa địa chỉ Gateway/Terminal ID', () => {
    const fn = src.slice(src.indexOf('string BuildCfg()'), src.indexOf('return s;', src.indexOf('string BuildCfg()')))
    expect(fn).not.toContain('InpGateway')
    expect(fn).not.toContain('InpTerminalId')
  })
  it('ack bù lệnh đúng định dạng Server hiểu', () => {
    for (const fmt of ['"opened:"', '"pending:"', '"+pending:"', '"partial:"', '"retry_timeout"']) expect(src, fmt).toContain(fmt)
  })
})

describe('mã lỗi tạm thời MT4 khớp Server', () => {
  it('IsTransientErr của MQL4 = các mã < 1000 trong TRANSIENT_RC của Server', () => {
    const src = EAS.mq4
    const body = src.slice(src.indexOf('bool IsTransientErr'), src.indexOf('}', src.indexOf('bool IsTransientErr')))
    const codes = [...body.matchAll(/e == (\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
    expect(codes).toEqual([...TRANSIENT_RC].filter((c) => c < 1000).sort((a, b) => a - b))
  })
})

describe('Server hiểu ack mà EA sinh ra', () => {
  it('ack đã đủ/đã đặt bù thì không giao lại; còn dở vì lỗi tạm thời thì giao lại', () => {
    for (const r of ['opened:3', 'pending:3', 'opened:1+pending:2', 'partial:2/3_max_lots', 'partial:1/3_makeup_expired', 'partial:2/3_bad_stops']) expect(isIncompleteResult(r), r).toBe(false)
    for (const r of ['partial:1/3_no_connection', 'partial:2/3_failed_138', 'failed:6', 'retry_timeout', 'retry:1/3']) expect(isIncompleteResult(r), r).toBe(true)
  })
  it('cfg do EA gửi (đủ khóa) bật được bù lệnh', () => {
    const cfg = parseCfgLine('InpAllowTrading=1;InpMakeupEnable=1;InpMakeupExpirySec=300;InpLotPerOrder=0.01;InpComment=OCEAN;')
    expect(makeupWindow(cfg)).toBe(300)
  })
})
