// Supabase Edge Function "pushcron" — 일정 관리 앱의 휴대폰 푸시 알림(앱을 닫아도 오는 알림)
//
// 1분마다 예약 작업(pg_cron)이 이 함수를 부른다 ──▶ 알릴 시각이 된 것을 찾아 ──(Web Push)──▶ 휴대폰·PC 브라우저
// 무엇을 언제 알릴지는 앱이 미리 계산해 pms_items 에 적어 둔다(반복 일정 계산을 서버에 두지 않으려고).
//   kind 'push_sub'  : 이 기기에 알림을 보낼 주소(브라우저가 준 구독 정보) — 기기마다 한 행
//   kind 'push_plan' : 앞으로 3주 동안 알릴 것 [{t: 알릴 시각(ms), title, body, tag}] — 사용자마다 한 행
//   kind 'push_sent' : 이미 보낸 tag 목록 — 이 함수만 쓴다(같은 알림을 두 번 보내지 않게)
//
// 알림 서명 키(VAPID)는 이 함수가 처음 돌 때 스스로 만들어 표 push_vapid 에 둔다(서비스 키로만 읽힌다).
// 앱은 ?key=1 로 공개 키만 받아 간다 — 비밀 키는 서버 밖으로 나가지 않는다. (Secrets 의 VAPID_PUBLIC_KEY·VAPID_PRIVATE_KEY 가 있으면 그것을 쓴다)
//
// 배포:
// 1) 대시보드 → Edge Functions → Deploy a new function → 이름 pushcron → 이 코드 → Deploy
// 2) 그 함수의 설정(Details)에서 "Verify JWT with legacy secret" 을 끈다 (예약 작업·앱이 로그인 없이 부른다.
//    누가 불러도 알릴 시각이 된 것만, 한 번씩만 보내므로 해가 없다)
// 3) SQL: create table push_vapid (id int primary key, pub text not null, priv text not null); alter table push_vapid enable row level security;
// 4) SQL Editor 에서 1분마다 부르는 예약 작업을 만든다 (앱의 알림 설정 창에 SQL 이 있다)
//
// 응답: ?key=1 → {key} / 그 밖 → {plans, due, sent, gone} 또는 {error}
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const LATE_MS = 15 * 60_000   // 예약 작업이 밀렸을 때 늦게라도 보내는 한도 — 그보다 지난 알림은 버린다
const EARLY_MS = 30_000       // 1분 간격이라 30초 일찍 보내는 것은 허용

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
let keys: { pub: string; priv: string } | null = null
async function vapid() {
  if (keys) return keys
  const ep = Deno.env.get('VAPID_PUBLIC_KEY'), ev = Deno.env.get('VAPID_PRIVATE_KEY')
  if (ep && ev) keys = { pub: ep, priv: ev }
  else {
    let { data } = await sb.from('push_vapid').select('pub,priv').eq('id', 1).maybeSingle()
    if (!data) {   // 처음 한 번 — 키를 만들어 둔다(동시에 두 번 돌면 먼저 넣은 것을 쓴다)
      const k = webpush.generateVAPIDKeys()
      await sb.from('push_vapid').upsert({ id: 1, pub: k.publicKey, priv: k.privateKey }, { onConflict: 'id', ignoreDuplicates: true })
      data = (await sb.from('push_vapid').select('pub,priv').eq('id', 1).single()).data
    }
    if (!data) throw new Error('push_vapid 표를 읽지 못했습니다')
    keys = data
  }
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:pms-push@example.com', keys.pub, keys.priv)
  return keys
}

type Item = { t: number; title: string; body?: string; tag: string }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try { const k = await vapid(); if (new URL(req.url).searchParams.has('key')) return json({ key: k.pub }) }
  catch (e) { return json({ error: String((e as Error).message || e) }, 500) }
  const now = Date.now()
  const { data: plans, error } = await sb.from('pms_items').select('user_id,data').eq('kind', 'push_plan').is('deleted_at', null)
  if (error) return json({ error: error.message }, 500)
  let due = 0, sent = 0, gone = 0
  for (const p of plans || []) {
    const items: Item[] = (p.data?.items || []).filter((i: Item) => i && i.t <= now + EARLY_MS && i.t > now - LATE_MS)
    if (!items.length) continue
    const { data: logRow } = await sb.from('pms_items').select('data').eq('user_id', p.user_id).eq('kind', 'push_sent').eq('item_id', 'sent').maybeSingle()
    const log: string[] = logRow?.data?.tags || []
    const todo = items.filter(i => !log.includes(i.tag))
    if (!todo.length) continue
    due += todo.length
    // 보내기 전에 먼저 적어 둔다 — 예약 작업이 겹쳐 돌아도 두 번 보내지 않게
    await sb.from('pms_items').upsert({ user_id: p.user_id, kind: 'push_sent', item_id: 'sent', data: { tags: [...log, ...todo.map(i => i.tag)].slice(-400) }, updated_at: new Date().toISOString(), deleted_at: null })
    const { data: subs } = await sb.from('pms_items').select('item_id,data').eq('user_id', p.user_id).eq('kind', 'push_sub').is('deleted_at', null)
    for (const s of subs || []) {
      for (const i of todo) {
        try {
          await webpush.sendNotification(s.data.sub, JSON.stringify({ title: i.title, body: i.body || '', tag: i.tag }), { TTL: 3600, urgency: 'high' })
          sent++
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode
          // 404·410 = 그 기기가 알림을 끊었거나 앱을 지움 → 주소를 지운다
          if (code === 404 || code === 410) { await sb.from('pms_items').delete().eq('user_id', p.user_id).eq('kind', 'push_sub').eq('item_id', s.item_id); gone++; break }
          console.error('push 실패', code, String((e as Error).message || e).slice(0, 200))
        }
      }
    }
  }
  return json({ plans: (plans || []).length, due, sent, gone })
})
