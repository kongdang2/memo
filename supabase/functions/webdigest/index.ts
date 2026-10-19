// Supabase Edge Function "webdigest" — 일정 앱의 「🔗 링크 정리」가 쓰는 웹 읽기 도우미
//
// 브라우저는 유튜브·블로그를 직접 읽지 못한다(다른 사이트 접근 차단, CORS). 이 함수가 대신 가져다 준다.
//   action 'yt'   {url}  → 유튜브 제목·채널·길이·설명·자막(시각 포함)·장면 미리보기 그림판(storyboard) 정보
//   action 'page' {url}  → 블로그·기사 HTML (네이버 블로그는 본문이 보이는 모바일 주소로 바꿔 읽음)
//   action 'img'  {url}  → 그림 한 장을 base64로 (장면 캡처·본문 사진을 앱에서 자르고 저장하려고)
//
// 배포: 대시보드 → Edge Functions → Deploy a new function → 이름 webdigest → 이 코드 전체 붙여넣기 → Deploy
// 비밀 키는 필요 없다(로그인한 사용자만 쓸 수 있게 Authorization 만 확인한다)
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
const MAX_IMG = 6 * 1024 * 1024
const MAX_HTML = 3 * 1024 * 1024

// 사내망·자기 자신으로 가는 주소는 막는다
function safeUrl(u: string): URL {
  let x: URL
  try { x = new URL(u) } catch { throw new Error('주소가 올바르지 않습니다') }
  if (!/^https?:$/.test(x.protocol)) throw new Error('http(s) 주소만 읽을 수 있습니다')
  const h = x.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h === '[::1]')
    throw new Error('이 주소는 읽을 수 없습니다')
  return x
}

function b64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf); let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

// ── 유튜브 ──
function ytId(u: string): string {
  const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/.exec(u)
  if (!m) throw new Error('유튜브 영상 주소에서 영상 번호를 찾지 못했습니다')
  return m[1]
}
// 서버(데이터센터)에서 묻는 것은 유튜브가 자주 막는다("로봇 확인"). 여러 클라이언트로 차례로 묻고,
// 자막과 장면 그림판(storyboard)이 둘 다 나오면 멈춘다. 각 시도의 결과는 diag 로 돌려준다(앱 콘솔에서 확인)
const CLIENTS = [
  { name: 'ANDROID', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 } },
  { name: 'IOS', ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' } },
  { name: 'TV_EMBED', ua: UA, client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' },
    extra: { thirdParty: { embedUrl: 'https://www.youtube.com/' } } },
  { name: 'WEB_EMBED', ua: UA, client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250310.01.00' },
    extra: { thirdParty: { embedUrl: 'https://www.youtube.com/' } } },
]
const hasSb = (r: any) => !!(r && r.storyboards && r.storyboards.playerStoryboardSpecRenderer && r.storyboards.playerStoryboardSpecRenderer.spec)
const hasCap = (r: any) => !!(r && r.captions && r.captions.playerCaptionsTracklistRenderer && (r.captions.playerCaptionsTracklistRenderer.captionTracks || []).length)
async function ytPlayer(id: string): Promise<{ rs: any[]; diag: string[] }> {
  const rs: any[] = [], diag: string[] = []
  const note = (name: string, r: any, http = 200) =>
    diag.push(name + ':' + (http !== 200 ? 'HTTP ' + http : (r?.playabilityStatus?.status || '?')) + (hasSb(r) ? ' 그림판' : '') + (hasCap(r) ? ' 자막' : ''))
  const enough = () => rs.some(hasSb) && rs.some(hasCap)
  for (const c of CLIENTS) {
    if (enough()) break
    try {
      const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua, 'X-Goog-Api-Format-Version': '2', Origin: 'https://www.youtube.com' },
        body: JSON.stringify({ videoId: id, contentCheckOk: true, racyCheckOk: true,
          context: { client: { ...c.client, hl: 'ko', gl: 'KR' }, ...(c.extra || {}) } }),
      })
      if (!r.ok) { note(c.name, null, r.status); continue }
      const j = await r.json(); note(c.name, j); rs.push(j)
    } catch (e) { diag.push(c.name + ':' + String((e as Error)?.message || e).slice(0, 60)) }
  }
  if (!enough()) {
    try {
      const r = await fetch('https://www.youtube.com/watch?v=' + id + '&hl=ko&gl=KR&has_verified=1', {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8', Cookie: 'CONSENT=YES+cb; SOCS=CAI' },
      })
      const html = await r.text()
      const m = /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script>)/s.exec(html)
      if (m) { const j = JSON.parse(m[1]); note('WATCH', j); rs.push(j) } else note('WATCH', null, r.status)
    } catch (e) { diag.push('WATCH:' + String((e as Error)?.message || e).slice(0, 60)) }
  }
  // 그림판·자막이 있는 응답을 앞으로
  rs.sort((a, b) => (+hasSb(b) + +hasCap(b)) - (+hasSb(a) + +hasCap(a)))
  return { rs, diag }
}
type Cue = { t: number; text: string }
async function ytCaptions(tracks: any[]): Promise<{ lang: string; auto: boolean; cues: Cue[] } | null> {
  if (!tracks.length) return null
  const score = (t: any) => (t.kind === 'asr' ? 0 : 10) + (/^ko/.test(t.languageCode) ? 5 : 0) + (/^(en|zh|ja)/.test(t.languageCode) ? 1 : 0)
  for (const t of [...tracks].sort((a, b) => score(b) - score(a))) {
    try {
      const r = await fetch(t.baseUrl + '&fmt=json3', { headers: { 'User-Agent': UA } })
      const txt = await r.text()
      let cues: Cue[] = []
      if (txt.trim().startsWith('{')) {
        const j = JSON.parse(txt)
        cues = (j.events || []).filter((e: any) => e.segs).map((e: any) => ({ t: Math.round((e.tStartMs || 0) / 1000), text: e.segs.map((s: any) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim() })).filter((c: Cue) => c.text)
      } else {
        const re = /<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g; let m
        while ((m = re.exec(txt))) cues.push({ t: Math.round(+m[1]), text: m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() })
      }
      if (cues.length) return { lang: t.languageCode, auto: t.kind === 'asr', cues }
    } catch (_) { /* 다음 자막 */ }
  }
  return null
}
// "url|w#h#count#cols#rows#interval#name#sigh|…" → 단계별 그림판 정보
function ytStoryboard(spec: string, dur: number) {
  if (!spec) return null
  const [base, ...lv] = spec.split('|')
  const levels = lv.map((s, L) => {
    const [w, h, count, cols, rows, interval, name, sigh] = s.split('#')
    const n = +count || 0
    return { L, w: +w, h: +h, count: n, cols: +cols, rows: +rows, interval: +interval || (n ? Math.ceil(dur * 1000 / n) : 0), name, sigh,
      url: base.replace('$L', String(L)).replace('$N', name) + (sigh ? (base.includes('?') ? '&' : '?') + 'sigh=' + sigh : '') }
  }).filter(x => x.w && x.count)
  return levels.length ? levels : null
}
async function yt(url: string) {
  const id = ytId(url)
  const { rs, diag } = await ytPlayer(id)
  if (!rs.length) throw new Error('유튜브에서 영상 정보를 받지 못했습니다 (' + diag.join(', ') + ')')
  const vd = rs.map(r => r.videoDetails).find(Boolean) || {}
  const mf = rs.map(r => r.microformat && r.microformat.playerMicroformatRenderer).find(Boolean) || {}
  const st = rs.map(r => r.playabilityStatus && r.playabilityStatus.status).find(x => x === 'OK') || rs.map(r => r.playabilityStatus && r.playabilityStatus.status).find(Boolean)
  const tracks = rs.flatMap(r => (r.captions && r.captions.playerCaptionsTracklistRenderer && r.captions.playerCaptionsTracklistRenderer.captionTracks) || [])
  const dur = +(vd.lengthSeconds || mf.lengthSeconds || 0)
  const spec = rs.map(r => r.storyboards && r.storyboards.playerStoryboardSpecRenderer && r.storyboards.playerStoryboardSpecRenderer.spec).find(Boolean) || ''
  const cap = await ytCaptions(tracks)
  // 장(챕터)은 설명란의 "0:00 제목" 줄에서
  const desc = String(vd.shortDescription || (mf.description && mf.description.simpleText) || '')
  return {
    id, url: 'https://www.youtube.com/watch?v=' + id, status: st || '',
    title: vd.title || (mf.title && mf.title.simpleText) || '', channel: vd.author || mf.ownerChannelName || '',
    published: mf.publishDate || mf.uploadDate || '', duration: dur, views: vd.viewCount || '',
    description: desc.slice(0, 6000), captions: cap,
    storyboard: ytStoryboard(spec, dur), diag,
    thumb: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg', thumbAlt: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
  }
}

// ── 블로그·기사 ──
async function page(url: string) {
  let u = safeUrl(url)
  // 네이버 블로그 PC 주소는 본문이 iframe 안에 있다 → 모바일 주소로
  if (/(^|\.)blog\.naver\.com$/.test(u.hostname) && !/^m\./.test(u.hostname)) {
    const q = u.searchParams; const p = u.pathname.split('/').filter(Boolean)
    const id = q.get('blogId') || p[0]; const no = q.get('logNo') || p[1]
    if (id && no && /^\d+$/.test(no)) u = new URL('https://m.blog.naver.com/' + id + '/' + no)
  }
  const r = await fetch(u.toString(), { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8', Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' })
  if (!r.ok) throw new Error('페이지를 열지 못했습니다 (' + r.status + ')')
  const buf = await r.arrayBuffer()
  if (buf.byteLength > MAX_HTML) throw new Error('페이지가 너무 큽니다')
  // 글자 인코딩(euc-kr 등) 맞추기
  const ct = r.headers.get('content-type') || ''
  let cs = (/charset=([\w-]+)/i.exec(ct) || [])[1] || ''
  if (!cs) { const head = new TextDecoder('latin1').decode(buf.slice(0, 4000)); cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || 'utf-8' }
  let html = ''
  try { html = new TextDecoder(cs.toLowerCase()).decode(buf) } catch { html = new TextDecoder().decode(buf) }
  return { url: r.url || u.toString(), html }
}

async function img(url: string) {
  const u = safeUrl(url)
  const r = await fetch(u.toString(), { headers: { 'User-Agent': UA, Referer: u.origin + '/', Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*' } })
  if (!r.ok) throw new Error('그림을 받지 못했습니다 (' + r.status + ')')
  const buf = await r.arrayBuffer()
  if (buf.byteLength > MAX_IMG) throw new Error('그림이 너무 큽니다')
  return { mime: (r.headers.get('content-type') || 'image/jpeg').split(';')[0], b64: b64(buf) }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST만 허용' }, 405)
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: '로그인이 필요합니다' }, 401)
  const anonKey =
    Deno.env.get('SUPABASE_ANON_KEY') ??
    (Object.values(JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}'))[0] as string | undefined) ?? ''
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, anonKey)
  const { data: { user }, error: authErr } = await sb.auth.getUser(token)
  if (authErr || !user) return json({ error: '로그인 세션이 유효하지 않습니다 — 다시 로그인하세요' }, 401)

  let body: { action?: string; url?: string }
  try { body = await req.json() } catch { return json({ error: 'JSON 본문이 필요합니다' }, 400) }
  try {
    const url = String(body.url || '')
    if (body.action === 'yt') return json(await yt(url))
    if (body.action === 'page') return json(await page(url))
    if (body.action === 'img') return json(await img(url))
    return json({ error: 'action은 yt · page · img 중 하나' }, 400)
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 200)
  }
})
