// Giả lập EA khi chưa có MT5: gửi ping tới Gateway và in tín hiệu nhận được. Chạy: pnpm fake-ea
const gw = process.env.OCEAN_GATEWAY ?? 'http://127.0.0.1:47800'
const acks: string[] = []
const tick = async () => {
  const body = [
    'login=900001', 'server=Demo-Server', 'bal=10000', 'eq=10012.5', 'mg=120', 'fm=9892.5', 'ver=0.2.0-fake',
    'pos=555001,XAUUSD,buy,0.10,4100.00,4092.00,4116.00,12.50',
    `acks=${acks.splice(0).join(',')}`,
  ].join('\n')
  try {
    const r = await fetch(`${gw}/v1/ping`, { method: 'POST', body })
    const text = await r.text()
    for (const line of text.split('\n').slice(1)) {
      console.log('nhận:', line)
      const id = line.split('|')[1]
      if (id) acks.push(`${id}:received`)
    }
  } catch (e) {
    console.log('Gateway chưa chạy:', (e as Error).message)
  }
}
setInterval(tick, 5000)
void tick()
