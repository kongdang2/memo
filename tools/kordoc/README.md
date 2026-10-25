# 코독(kordoc) 브라우저 묶음

`vendor/kordoc/kordoc.js` 를 만드는 곳입니다. 앱은 메모의 「📥 문서」·「📤 한글」을 처음 누를 때만 이 파일을 내려받습니다.

- 원본: https://github.com/chrisryugj/kordoc (MIT) — 저작권·제3자 고지는 `vendor/kordoc/LICENSE`, `NOTICE`
- 되는 것: HWP·HWPX·DOCX·XLSX·XLS·PPTX → 마크다운, 마크다운 → HWPX
- 빠진 것: PDF·그림 속 글자 읽기(무거운 모듈이라 뺐음)
- 다시 만들기: `npm install --omit=optional && npm run build`
