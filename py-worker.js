/* 답안 코드를 브라우저 안의 파이썬(Pyodide)으로 실행하는 워커.
   Pyodide 본체와 패키지는 이 페이지와 함께 py/ 아래에 올라가 있음 (외부 다운로드 없음). */
"use strict";
// 이 호스팅은 .whl·.zip 확장자를 내보내지 않아서 같은 파일을 이름 뒤에 .wasm을 붙여 올려 둠.
// Pyodide는 원래 이름(.whl)으로 요청하므로 요청 주소만 바꿔 줌. 파일 내용·이름·체크섬은 그대로.
const _fetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  const fixed = url.replace(/\.(whl|zip)(\?.*)?$/, ".$1.wasm$2");
  return _fetch(fixed === url ? input : fixed, init);
};

const BASE = new URL("./py/", self.location.href).href;
const WORK = "/home/pyodide/work";
const SHIM = "/home/pyodide/shim";
// FastAPI와 TestClient가 쓰는 패키지. lock의 depends에 다 적혀 있지 않아 직접 불러옴
const WEB_PKGS = ["fastapi","starlette","pydantic","httpx","httpcore","h11","idna","certifi","sniffio","anyio","pytest"];
let py = null, booting = null, webReady = false, quiet = false, runSeq = 0;
let outBuf = [], flushTimer = null;

function post(type, data){ self.postMessage(Object.assign({ type }, data || {})); }
function out(stream, text){
  if(quiet) return;
  outBuf.push({ stream, text });
  if(!flushTimer) flushTimer = setTimeout(flush, 60);
}
function flush(){
  clearTimeout(flushTimer); flushTimer = null;
  if(outBuf.length){ post("out", { chunks: outBuf }); outBuf = []; }
}
const silent = { messageCallback: () => {}, errorCallback: m => out("stderr", m + "\n") };

async function boot(){
  if(py) return py;
  if(!booting){
    booting = (async () => {
      post("status", { text: "파이썬 실행 환경을 불러오는 중이에요. 처음 한 번만 오래 걸려요." });
      importScripts(BASE + "pyodide.js");
      const p = await self.loadPyodide({ indexURL: BASE });
      // 받은 바이트를 그대로 넘김. batched는 flush마다 줄을 바꿔서 pytest의 점(.)이 한 줄에 하나씩 찍혔음
      const decOut = new TextDecoder(), decErr = new TextDecoder();
      p.setStdout({ write: buf => { out("stdout", decOut.decode(buf, { stream:true })); return buf.length; } });
      p.setStderr({ write: buf => { out("stderr", decErr.decode(buf, { stream:true })); return buf.length; } });
      p.FS.mkdirTree(SHIM);
      for(const [name, file] of [["_shim.py","_shim.txt"],["_hidden_runner.py","_hidden_runner.txt"]]){
        const r = await _fetch(BASE + file);
        if(!r.ok) throw new Error(file + " 을 불러오지 못했어요 (" + r.status + ")");
        p.FS.writeFile(SHIM + "/" + name, await r.text());
      }
      p.runPython(`import sys\nif ${JSON.stringify(SHIM)} not in sys.path: sys.path.insert(0, ${JSON.stringify(SHIM)})`);
      py = p;
      return p;
    })();
  }
  return booting;
}

async function prepareWeb(p){
  if(webReady) return;
  post("status", { text: "FastAPI 환경을 불러오는 중이에요." });
  await p.loadPackage(WEB_PKGS, silent);
  p.runPython("import _shim");  // 스레드 없이 FastAPI·TestClient가 돌도록 바꿔 줌
  webReady = true;
}

function writeFiles(p, files){
  p.runPython(`
import os, shutil
# 지난 실행이 작업 폴더 안으로 cd 해 둔 상태면 폴더를 지울 수 없어서(Resource busy) 먼저 밖으로 나감
os.chdir("/home/pyodide")
if os.path.exists(${JSON.stringify(WORK)}):
    shutil.rmtree(${JSON.stringify(WORK)})
os.makedirs(${JSON.stringify(WORK)}, exist_ok=True)
`);
  for(const [name, body] of Object.entries(files)){
    const path = WORK + "/" + name;
    p.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    p.FS.writeFile(path, body);
  }
}

const PREP_PY = `
import os, sys
os.chdir(${JSON.stringify(WORK)})
if ${JSON.stringify(WORK)} not in sys.path:
    sys.path.insert(0, ${JSON.stringify(WORK)})
for _m in list(sys.modules):
    _f = getattr(sys.modules[_m], "__file__", None) or ""
    if _f.startswith(${JSON.stringify(WORK)}):
        del sys.modules[_m]
`;

async function run(msg){
  const p = await boot();
  const files = msg.files || {};
  writeFiles(p, files);
  const userPy = Object.entries(files).filter(([n]) => n.endsWith(".py")).map(([, b]) => b).join("\n");
  const allPy = userPy + "\n" + (msg.hidden || "");
  post("status", { text: "필요한 패키지를 확인하는 중이에요." });
  await p.loadPackagesFromImports(allPy, {
    messageCallback: m => { if(/^Loading /.test(m)) post("status", { text: "불러오는 중: " + m.slice(8) }); },
    errorCallback: m => out("stderr", m + "\n"),
  });
  if(msg.cmd === "hidden" || /\b(fastapi|starlette|httpx|TestClient)\b/.test(userPy)) await prepareWeb(p);
  if(msg.cmd === "test") await p.loadPackage("pytest", silent);
  p.runPython(PREP_PY);

  if(msg.cmd === "hidden"){
    const name = "hidden_check_" + (++runSeq) + ".py";
    p.FS.writeFile(WORK + "/" + name, msg.hidden);
    post("status", { text: "숨은 테스트를 돌리는 중이에요." });
    post("started", {});
    quiet = true;
    try{
      const json = await p.runPythonAsync(`import _hidden_runner\n_hidden_runner.run_hidden(${JSON.stringify(WORK + "/" + name)})`);
      quiet = false;
      post("hidden", { rows: JSON.parse(json) });
    }catch(e){
      quiet = false;
      post("hidden", { rows: [{ name: "__error__", outcome: "failed", msg: String(e && e.message || e).slice(-600) }] });
    }
    return;
  }

  post("status", { text: msg.cmd === "test" ? "테스트 실행 중" : "실행 중" });
  post("started", {});
  const t0 = performance.now();
  let code = 0;
  try{
    const ret = await p.runPythonAsync(`
import runpy
_rc = 0
if ${JSON.stringify(msg.cmd)} == "test":
    import pytest
    _rc = int(pytest.main(["-q", "-p", "no:cacheprovider", "-W", "ignore::pytest.PytestAssertRewriteWarning", ${JSON.stringify(WORK)}]))
else:
    try:
        runpy.run_path(${JSON.stringify(msg.entry || "main.py")}, run_name="__main__")
    except SystemExit as _e:
        _rc = _e.code if isinstance(_e.code, int) else (0 if _e.code is None else 1)
_rc
`);
    code = Number(ret) || 0;
  }catch(e){
    out("stderr", String(e && e.message || e) + "\n");
    code = 1;
  }
  flush();
  post("done", { code, ms: Math.round(performance.now() - t0) });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try{
    if(msg.type === "run") await run(msg);
  }catch(e){
    quiet = false;
    flush();
    post("fail", { text: String(e && e.message || e) });
  }
};
