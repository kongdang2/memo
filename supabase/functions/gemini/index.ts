// Supabase Edge Function "gemini" — 일정 관리 앱 「🔗 링크 정리」가 유튜브 영상을 제미나이에게 보여 주는 중계
//
// 브라우저 ──(Authorization: Bearer 로그인토큰, {url, question?, model?, start?, end?, max_tokens?})──▶ 이 함수 ──(x-goog-api-key)──▶ Google Gemini API
// 제미나이 키(GEMINI_API_KEY)는 Secrets에만 있고 브라우저에는 절대 가지 않는다.
// 유튜브 주소는 Google이 직접 읽는다(영상을 받거나 올리지 않는다). 로그인한 사용자이면서 허용 명단(tb_members)에 있는 사람만 쓸 수 있다.
//
// 배포:
// 1) 대시보드 → Edge Functions → Deploy a new function → 이름 gemini → 이 코드 → Deploy
//    (CLI: supabase functions deploy gemini --no-verify-jwt)
// 2) 그 함수의 설정(Details)에서 "Verify JWT with legacy secret" 을 끈다 (trip-claude·livetranslate와 같음 — 로그인 확인은 아래 코드가 한다)
// 3) Secrets 에 GEMINI_API_KEY (무료 키: https://aistudio.google.com/apikey)
//    (CLI: supabase secrets set GEMINI_API_KEY=...)
//
// 응답: {text, model, usage:{tok_in, tok_out, total}} 또는 {error}
// 모델은 요청의 model, 없으면 아래 DEFAULT_MODEL. 429(한도)·503(혼잡)은 3초 뒤 한 번 더 시도한다.
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const API = 'https://generativelanguage.googleapis.com/v1beta/models/'
const DEFAULT_MODEL = 'gemini-3.6-flash'
const MODEL_OK = /^gemini-[\w.-]+$/
const YT = /^https?:\/\/(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?\S*\bv=|shorts\/|live\/)|youtu\.be\/)\S+$/i
const MAX_OUT = 65536       // gemini-3.x flash 출력 상한
const TIMEOUT_MS = 300_000  // 제미나이가 긴 영상을 보는 시간. Edge Function 자체의 실행 한도(요금제별 150~400초)가 더 짧을 수 있다
const DEFAULT_Q = '이 영상을 처음부터 끝까지 보고 무엇이 보이고 무엇을 말하는지 시간 순서대로 한국어로 적는다. 주제가 바뀌는 곳마다 [mm:ss] 시각을 붙인다.'

const offset = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) + 's' : '' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...CORS, 'content-type': 'application/json' } })
  if (req.method !== 'POST') return json({ error: 'POST 전용입니다' }, 405)

  // 1) 로그인 확인
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const anonKey =
    Deno.env.get('SUPABASE_ANON_KEY') ??
    (Object.values(JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}'))[0] as string | undefined) ?? ''
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } })
  const { data: { user } } = jwt ? await sb.auth.getUser(jwt) : { data: { user: null } }
  if (!user) return json({ error: '로그인 세션이 유효하지 않습니다 — 다시 로그인하세요' }, 401)

  // 2) 허용 명단 확인 (RLS "read own membership" 으로 본인 행만 보인다)
  const { data: mem } = await sb.from('tb_members').select('email').limit(1)
  if (!mem || !mem.length) return json({ error: '등록되지 않은 사용자입니다 — 팀 관리자에게 추가를 요청하세요' }, 403)

  const key = Deno.env.get('GEMINI_API_KEY') ?? ''
  if (!key) return json({ error: 'Secrets에 GEMINI_API_KEY가 없습니다' }, 500)

  // 3) 본문 점검 — 유튜브 주소만, 모델 이름 꼴만 제한
  let a: Record<string, unknown>
  try { a = await req.json() } catch { return json({ error: 'JSON 본문이 필요합니다' }, 400) }
  const url = String(a.url ?? '').trim()
  if (!YT.test(url)) return json({ error: '유튜브 주소만 받습니다: ' + url.slice(0, 80) }, 400)
  const model = a.model ? String(a.model) : DEFAULT_MODEL
  if (!MODEL_OK.test(model)) return json({ error: '허용되지 않은 모델: ' + model }, 400)
  const part: Record<string, unknown> = { fileData: { fileUri: url } }
  const meta: Record<string, string> = {}
  const s = offset(a.start), e = offset(a.end)
  if (s) meta.startOffset = s
  if (e) meta.endOffset = e
  if (Object.keys(meta).length) part.videoMetadata = meta  // 구간만 보기 (초 단위)
  const body = {
    contents: [{ parts: [part, { text: String(a.question ?? '').trim() || DEFAULT_Q }] }],
    generationConfig: { maxOutputTokens: Math.min(Number(a.max_tokens) || 16000, MAX_OUT) },
  }

  // 4) 제미나이 호출 (429·503은 한 번 더)
  let status = 0, text = ''
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(API + model + ':generateContent', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      status = r.status
      text = await r.text()
    } catch (err) {
      const m = String((err as Error)?.message ?? err)
      return json({ error: /timed out|TimeoutError/i.test(m) ? '제미나이가 제한 시간(' + TIMEOUT_MS / 1000 + '초) 안에 답하지 못했습니다 — 긴 영상이면 start·end 로 구간을 나누세요' : '제미나이 연결 실패: ' + m }, 502)
    }
    if (status !== 429 && status !== 503) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  // deno-lint-ignore no-explicit-any
  let j: any = null
  try { j = JSON.parse(text) } catch { /* 아래에서 본문 조각으로 알린다 */ }
  if (status >= 300) {
    const m = j?.error?.message ?? text.slice(0, 300)
    return json({ error: status === 429 ? '제미나이 사용량 한도를 넘었습니다 — 잠시 뒤 다시 시도하세요 (' + m + ')'
      : status === 503 ? '제미나이 서버가 바쁩니다 — 잠시 뒤 다시 시도하세요'
      : '제미나이 오류 ' + status + ': ' + m }, status === 429 || status === 503 ? status : 502)
  }
  const cand = j?.candidates?.[0]
  // deno-lint-ignore no-explicit-any
  const out = ((cand?.content?.parts ?? []) as any[]).map((p) => String(p?.text ?? '')).filter(Boolean).join('\n').trim()
  if (!out) {
    const why = cand?.finishReason ?? j?.promptFeedback?.blockReason ?? '?'
    return json({ error: '제미나이가 답을 주지 않았습니다 (' + why + ') — 비공개·연령 제한 영상이거나 너무 길 수 있습니다' }, 502)
  }
  const u = j.usageMetadata ?? {}
  const usage = { tok_in: Number(u.promptTokenCount ?? 0), tok_out: Number(u.candidatesTokenCount ?? 0), total: Number(u.totalTokenCount ?? 0) }

  // 5) 사용 기록 (실패해도 무시) — 통번역 앱의 tb_usage 표를 같이 쓴다. tok_ 열이 없는 표면 그 열을 빼고 다시 넣는다
  try {
    const row: Record<string, unknown> = { user_id: user.id, email: user.email, kind: '제미나이(링크 정리)', seconds: 0, calls: 1, model: j.modelVersion ?? model, tok_in: usage.tok_in, tok_out: usage.tok_out }
    const { error } = await sb.from('tb_usage').insert(row)
    if (error && /tok_/.test(error.message)) { delete row.tok_in; delete row.tok_out; await sb.from('tb_usage').insert(row) }
  } catch (_) { /* ignore */ }

  return json({ text: out, model: j.modelVersion ?? model, usage })
})
