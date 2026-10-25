// kordoc(Node 라이브러리)를 브라우저용 한 파일로 묶는다 → ../../vendor/kordoc/kordoc.js
// 사용: cd tools/kordoc && npm install --omit=optional && npm run build
// - Node 내장 모듈(fs, crypto …)과 OCR용 무거운 선택 모듈은 stub.mjs 로 대신한다(그림 속 글자 읽기는 안 됨)
// - 나눠 묶기: PDF 부품(pdf.js)은 PDF 를 열 때만 따로 내려받는다
// - zlib 은 fflate, Buffer/process 는 shim.mjs 로 채운다
// - ZIP 안 파일 읽기(readZipEntry)는 Node 스트림 대신 JSZip 의 async 로 바꾼다
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
const here = path.dirname(new URL(import.meta.url).pathname);
const stub = fs.readFileSync(path.join(here, 'stub.mjs'), 'utf8');
const NODE = /^(node:)?(fs|fs\/promises|child_process|os|crypto|path|url|module|util|stream|stream\/promises|worker_threads|process)$|^(onnxruntime-node|sharp|@hyzyla\/pdfium|@huggingface\/tokenizers)$/;
const ZIP_FROM = 'return new Promise((resolve, reject) => {\n    const chunks = [];';
const ZIP_TO = 'return file.async(type==="text"?"string":"uint8array").then(r=>{if(used+r.length>MAX_DECOMPRESS_SIZE)throw new ZipBombError("ZIP too large");return r;});\n  ' + ZIP_FROM;
let zipPatched = 0, pdfPatched = 0;
// PDF: pdf.js 는 같은 페이지에서(가짜 워커) 돌리고, 한글 글꼴용 cMap 은 CDN 에서 받는다
const PDFJS_VER = JSON.parse(fs.readFileSync(path.join(here, 'node_modules/pdfjs-dist/package.json'), 'utf8')).version;
const PDF_FROM = /try \{\n  const _require = createRequire\(import\.meta\.url\);\n  const pkgDir = [\s\S]*?\n\} catch \{\n\}/;
const PDF_TO = `pdfjsAssets.cMapUrl = "https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/cmaps/"; pdfjsAssets.cMapPacked = true; pdfjsAssets.standardFontDataUrl = "https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/standard_fonts/";`;
const outdir = path.join(here, '../../vendor/kordoc');
const r = await esbuild.build({
  entryPoints: [path.join(here, 'entry.mjs')], inject: [path.join(here, 'shim.mjs')],
  bundle: true, splitting: true, format: 'esm', platform: 'browser', minify: true, legalComments: 'eof', outdir, entryNames: 'kordoc', chunkNames: 'kd-[hash]', logLevel: 'error', metafile: true,
  plugins: [{ name: 'browser', setup(b) {
    b.onLoad({ filter: /kordoc[\/\\]dist[\/\\].*\.js$/ }, a => {
      let c = fs.readFileSync(a.path, 'utf8');
      if (c.includes('file.nodeStream(')) { c = c.replace(ZIP_FROM, ZIP_TO); zipPatched++; }
      if (PDF_FROM.test(c)) { c = c.replace(PDF_FROM, PDF_TO); pdfPatched++; }
      return { contents: c, loader: 'js' };
    });
    b.onResolve({ filter: /^(node:)?buffer$/ }, () => ({ path: path.join(here, 'node_modules/buffer/index.js') }));
    b.onResolve({ filter: /^(node:)?zlib$/ }, () => ({ path: path.join(here, 'zl.mjs') }));
    b.onResolve({ filter: NODE }, a => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub, loader: 'js', resolveDir: here }));
  } }],
});
if (!zipPatched) throw new Error('readZipEntry 를 바꾸지 못했습니다 — kordoc 버전이 달라졌는지 확인');
if (!pdfPatched) throw new Error('PDF cMap 경로를 바꾸지 못했습니다 — kordoc 버전이 달라졌는지 확인');
for (const [f, o] of Object.entries(r.metafile.outputs)) if (f.endsWith('.js')) console.log(path.basename(f), o.bytes);
