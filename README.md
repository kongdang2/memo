# 일정 관리 — 통번역 앱에서 분리한 코드

예전 개인 업무 관리(PMS)의 일정 기능만 떼어 낸 단독 앱입니다. 원본 PMS 전체 코드는 `kongdang2/record` 커밋 60aeac1에 있습니다.

## 들어 있는 파일

| 파일 | 내용 |
|---|---|
| `index.html` | 바로 열리는 일정 관리 앱 (v1.0). 로그인 → 월간·주간·목록 달력 |
| `cal.config.js` | 서버 설정. 비워 두면 로컬 모드(브라우저 저장), Supabase 값을 넣으면 클라우드 동기화 |
| `supabase/functions/webdigest/index.ts` | Edge Function `webdigest` — 「🔗 링크 정리」의 유튜브 정보·자막·장면 그림판, 블로그 글, 그림 받기 중계. 유튜브가 서버 접속을 막으면 여러 방식(안드로이드·아이폰·TV·웹 임베드·웹 페이지)으로 차례로 묻고, 각 결과를 `diag` 로 돌려준다 |
| `supabase/functions/gemini/index.ts` | Edge Function `gemini` — 「🔗 링크 정리」가 유튜브 영상을 제미나이에게 보여 주는 중계(v2.7). 키는 서버 Secrets 에만 |

## 🔗 링크 정리 — 유튜브를 제미나이가 직접 본다 (v2.7)

일정 메모에 유튜브 링크를 넣고 「🔗 링크 정리」를 누르면 두 단계로 읽습니다.

1. **제미나이 시청** — Edge Function `gemini` 가 유튜브 주소를 Google 제미나이에 넘기고, 제미나이가 영상(화면+소리)을 처음부터 끝까지 보고 `[mm:ss]` 시각이 붙은 메모를 돌려줍니다. 자막이 없는 영상도 됩니다. 영상을 받거나 올리지 않습니다(주소만 보냄).
2. **자막·장면** — 전처럼 `webdigest` 가 자막·설명·장면 그림판을 받아 옵니다.

두 결과를 Claude(`claude` 함수)가 기존 양식(요약·주요 내용·핵심 수치·시사점)으로 정리하고 장면 캡처를 넣습니다. 출처 줄에 「제미나이 시청」이 붙으면 1단계가 들어간 것입니다. `gemini` 함수가 없거나 실패하면 전처럼 자막만으로 정리하고, 그 이유는 브라우저 콘솔에만 남깁니다.

**배포(한 번만)** — Supabase 대시보드 → Edge Functions:

1. **Deploy a new function** → 이름 `gemini` → `supabase/functions/gemini/index.ts` 내용 붙여넣기 → Deploy
2. 그 함수의 **Details** 에서 "Verify JWT with legacy secret" 을 끕니다(`claude`·`livetranslate` 와 같음. 로그인 확인은 함수 코드가 합니다)
3. **Edge Functions → Secrets** 에 `GEMINI_API_KEY` 추가 (무료 키: https://aistudio.google.com/apikey)

CLI 를 쓰면 저장소 루트에서 `supabase functions deploy gemini --no-verify-jwt` 와 `supabase secrets set GEMINI_API_KEY=...` 입니다.

- 쓸 수 있는 사람: 로그인했고 `tb_members` 에 있는 계정(다른 함수와 같은 규칙). 사용량은 `tb_usage` 에 `제미나이(링크 정리)` 로 남습니다.
- 모델: 기본 `gemini-3.6-flash`. 팀 설정(`tb_config.data.geminiModel`)으로 바꿀 수 있습니다. 2026-10 기준 `gemini-3.7-flash`·`3.8-flash` 는 응답이 자주 끊겨 3.6 을 기본으로 두었습니다.
- 긴 영상: 제미나이 응답 제한 300초, Edge Function 실행 한도(요금제별 150~400초)에 걸리면 「제한 시간」 오류가 납니다. 함수는 `start`·`end`(초)로 구간만 보기를 지원하지만 앱 화면에는 아직 구간 입력이 없습니다.
- 로컬 시험 기록(2026-10-19): Deno 2.9 에서 함수를 그대로 띄우고(supabase-js 만 가짜) 19초 영상으로 401·400·정상·구간 응답을 확인했습니다.

## 장면 캡처가 적게 들어갈 때 (v2.7.1)

유튜브가 서버(데이터센터)에서 오는 요청에 장면 그림판(storyboard)을 주지 않으면 장면을 오려 낼 수 없습니다. 그때는 유튜브가 모든 영상에 만들어 두는 자동 미리보기(대표 그림, 영상의 약 1/4·2/4·3/4 지점)로 최대 4장을 대신 넣고, 정리 후 알림에 이유를 적습니다. 브라우저 콘솔의 `[링크 정리] 장면` 줄에 `diag`(어느 방식이 어떤 답을 받았는지)가 남습니다.

## 출처

현재 통번역 앱(index.html v10.13)에는 일정 화면 코드가 이미 없습니다. 그래서 일정 기능이 온전히 남아 있던 마지막 버전인 2026-09-25 PMS(`kongdang2/record` 커밋 60aeac1)에서 뽑았습니다. 저장소 기록상 그 뒤로 일정 기능이 바뀐 커밋은 없습니다.

## index.html 안의 구성

| 블록 | 내용 |
|---|---|
| React · Babel · 디자인 시스템 | 원본 그대로 (파일 크기 대부분) |
| 저장·인증 계층 (`Store`) | Supabase 또는 localStorage, 행 단위 저장(`pms_items`), 휴지통 30일, 다른 기기 변경 받아 오기 |
| 공용 | 공휴일(`HOLIDAYS`), ICS 내보내기·가져오기(`toICS`/`fromICS`), 반복 일정 펼치기(`expandEvents`), 마크다운, 알림(`Notify`) |
| 로그인 + 설정 | 설정 탭은 「저장/계정」, 「알림」 두 개만 남김 |
| 일정 화면 (`CalendarView`) | 월간·주간·목록, 카테고리 색, 기간 일정, 드래그 이동, 🗑 칸에 놓아 지우기, 상태(예정·진행중·완료), 반복(매일·매주·매월) |
| 앱 셸 (`CalApp`) | 헤더, 되돌리기·다시하기(Ctrl+Z/Y), JSON 백업, 휴지통, 일정 임박·아침 요약 알림, 새 버전 알림 |

일정 한 건의 모양:
```
{id, title, date:'YYYY-MM-DD', dateEnd, start:'HH:MM', end, cal:'work'|'personal',
 status:'todo'|'doing'|'done', category, repeat:'none'|'daily'|'weekly'|'monthly', notes(마크다운)}
```

## 원본에서 뺀 것

메일(Gmail·회사 .eml 폴더), 지식/노트·LLM 위키·옵시디언 내보내기, 통역·녹음·전사, Claude 호출, 첨부 파일, 메일·노트로 보내기 버튼, 폰 하단 영역 전환 막대.

## 바꾼 것

- 앱 이름 「일정 관리」, 버전 v1.0
- 브라우저 저장 키 `pms.*` → `cal.*`, 설정 파일 `pms.config.js` → `cal.config.js`(`window.CAL_CONFIG`). 같은 kongdang2.github.io 주소에 올려도 통번역 앱 설정과 섞이지 않게 하려는 것입니다.
- 첫 로그인 예시 데이터는 일정 7건만

## 새 프로젝트에서 정할 것

- **서버**: 통번역 앱과 같은 Supabase를 쓰면 일정은 `pms_items` 테이블에 `kind='events'`로 들어가고 통번역 기록(`kind='tbrec'`)과 나란히 저장됩니다. 따로 쓰려면 새 Supabase 프로젝트를 만들고 설정 › 저장/계정의 SQL을 실행하세요.
- **로그인**: 통번역 Supabase는 새 가입을 막아 두었을 수 있습니다. 그러면 기존 계정(이메일+비밀번호)으로만 들어갈 수 있습니다.
- **남은 군더더기**: 설정의 진단·휴지통 라벨과 저장 계층 주석에 「메일·노트」라는 말과 `mails`/`notes` 분기가 조금 남아 있습니다. 동작에는 영향이 없습니다.

## 확인한 것

로컬 모드에서 헤드리스 크롬으로 열어 봤습니다. 로그인, 월간 달력, 일정 열기, 목록, 설정 두 탭, 휴지통, 폰 폭 화면에서 콘솔 오류가 없었습니다. Supabase 연결 상태로는 아직 열어 보지 않았습니다.
