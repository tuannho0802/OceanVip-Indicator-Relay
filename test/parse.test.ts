import { describe, expect, it } from 'vitest'
import { dedupeKey, parseAlert, riskReward } from '../src/shared/parse'

const SELL =
  'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'
const BUY =
  'OCEAN VIP by Duong | BUY ENTRY | XAUUSD | M15 | Entry: 4100.000 | SL: 4092.000 | TP1 40%: 4106.400 | TP2 80%: 4112.800 | TP3 100%: 4116.000'

describe('parseAlert', () => {
  it('đọc SELL ENTRY đúng mẫu thật', () => {
    const p = parseAlert(SELL)
    expect(p).toMatchObject({ kind: 'entry', side: 'sell', symbol: 'XAUUSD', tf: 'M3', entry: 4118, sl: 4125.97 })
    if (p.kind !== 'entry') throw new Error()
    expect([p.tp1, p.tp2, p.tp3]).toEqual([4111.624, 4105.248, 4102.06])
    expect(riskReward(p)).toBeCloseTo(2, 3)
  })
  it('đọc BUY ENTRY', () => {
    expect(parseAlert(BUY)).toMatchObject({ kind: 'entry', side: 'buy', tf: 'M15', sl: 4092 })
  })
  it('đọc khuôn cập nhật (direction + closeStatus)', () => {
    const p = parseAlert('OCEAN VIP by Duong | SELL | TP1 HIT | XAUUSD | M3 | Entry: 4118.000 | SL: 4118.000 | TP: 4111.624')
    expect(p).toMatchObject({ kind: 'update', side: 'sell', status: 'TP1 HIT', tp: 4111.624 })
  })
  it('chịu được xuống dòng và khoảng trắng thừa', () => {
    expect(parseAlert(`  ${SELL.replace(/ \| /g, ' |\r\n ')}  `).kind).toBe('entry')
  })
  it('từ chối SL sai phía thay vì đoán', () => {
    const bad = SELL.replace('SL: 4125.970', 'SL: 4110.000')
    expect(parseAlert(bad)).toMatchObject({ kind: 'unknown' })
  })
  it('từ chối thiếu trường và ký tự lạ', () => {
    expect(parseAlert(SELL.replace(' | TP3 100%: 4102.060', '')).kind).toBe('unknown')
    expect(parseAlert(SELL.replace('XAUUSD', 'XAU;USD')).kind).toBe('unknown')
    expect(parseAlert('hello world').kind).toBe('unknown')
    expect(parseAlert('').kind).toBe('unknown')
  })
  it('khóa chống trùng ổn định', () => {
    const a = parseAlert(SELL)
    const b = parseAlert(SELL.replace('4118.000', '4118'))
    if (a.kind === 'unknown' || b.kind === 'unknown') throw new Error()
    expect(dedupeKey(a)).toBe(dedupeKey(b))
  })
})
