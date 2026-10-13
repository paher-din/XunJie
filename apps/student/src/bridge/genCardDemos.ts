/**
 * 生成交互卡的「沙箱内容」生成器（srcdoc 工厂，docs/prototypes/gen-cards/demos.js 的正式版移植）。
 * 每个演示都是一份自包含 HTML 文档（内联 CSS + JS，零外部资源），经 iframe.srcdoc 注入。
 * mock 阶段内容来自确定性剧本：同参数永远生成同一份文档，可复跑可截图。
 * 沙箱侧协议客户端（CLIENT）同样内联——真实实现里生成器会把协议客户端注进每个产物页。
 */

export interface GlitchOptions {
  /** 1 = 上个可用版本；2 = 新版（进阶按钮必崩，演示运行失败回滚）。 */
  version?: number
  /** 故意不回 ready（演示协议超时判死）。 */
  neverReady?: boolean
}

const ACCENT = '#007aff'

/* ---------- 沙箱内联的协议客户端（每个产物一份） ----------
 * 职责：收 init → 应用快照 → 回 ready(高度)；交互变化发 input(带高度)；
 *       收到 snapshot-request 回 snapshot(state+高度)；未捕获异常发 error。
 * 应用侧只需实现 window.__applyInit(payload) 与 window.__getState()。 */
const CLIENT = `
(function () {
  var C = { accent: '${ACCENT}', instance: '' };
  function send(type, payload) {
    /* mock 用 '*' 作 targetOrigin：srcdoc 页是 about:srcdoc，无真实 origin。
       生产版会给沙箱分配专用源（或一次性 token），宿主按源白名单投递。 */
    parent.postMessage({ gen: 1, type: type, instance: C.instance, payload: payload || {} }, '*');
  }
  window.__gen = {
    /* 首渲染完成后由应用调用：回报内容高度，宿主据此自适应（上限 480，超出内滚）。
       后台/隐藏页面布局是惰性的，scrollHeight 可能暂时为 0 —— 轮询到非零再回。 */
    ready: (function () {
      var tries = 0;
      function attempt(extra) {
        var el = document.documentElement;
        var h = el ? el.scrollHeight : 0;
        var vw = el ? el.clientWidth : 0;
        /* h>0 且 vw>0 才算拿到真布局：iframe 未进渲染树时内容会按 0 宽折行，高度是假的 */
        if ((h > 0 && vw > 0) || tries++ > 40) { send('ready', Object.assign({ height: h,
          /* 诊断字段：宿主忽略，排障用 */
          vw: vw }, extra || {})); return; }
        setTimeout(function () { attempt(extra); }, 50);
      }
      return attempt;
    })(),
    /* 交互变化：state 为可 JSON 化的快照数据；height 顺带解决交互引起的壳高变化 */
    input: function (state) {
      var h = document.documentElement ? document.documentElement.scrollHeight : 0;
      send('input', { state: state, height: h > 0 ? h : undefined });
    },
    state: function () { return window.__getState ? window.__getState() : {}; }
  };
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.gen !== 1) return;                 /* 结构 / 版本校验 */
    if (m.type === 'init') {
      C.instance = m.instance;                     /* 实例 id 在信封上，不在 payload 里 */
      if (m.payload.theme && m.payload.theme.accent) {
        C.accent = m.payload.theme.accent;
        document.documentElement.style.setProperty('--accent', C.accent);
      }
      if (window.__applyInit) window.__applyInit(m.payload);
      window.__gen.ready();                        /* init 的应答即 ready */
    } else if (m.type === 'snapshot-request') {
      send('snapshot', { req: m.payload.req, state: window.__gen.state(),
                         height: document.documentElement.scrollHeight });
    }
  });
  /* 未捕获异常 → error 消息（宿主兜底「上个可用版本」就靠它） */
  window.addEventListener('error', function (e) { send('error', { message: String((e && e.message) || e) }); });
})();
`

/* 沙箱公共样式：白底、hairline、跟随宿主题色变量 */
const BASE_CSS = `
html,body{margin:0;padding:0;background:#fff}
body{padding:14px 16px 12px;overflow:auto;color:#1f2328;
  font:13px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;
  -webkit-font-smoothing:antialiased}
.g-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.g-btn{border:1px solid #e0e0de;background:#1f2328;color:#fff;border-radius:8px;
  padding:7px 14px;font-size:12.5px;font:inherit;cursor:pointer}
.g-btn:active{transform:scale(.96)}
.g-btn.ghost{background:#fff;color:#42474d}
.g-sw{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#656d76;cursor:pointer;user-select:none}
.g-sw i{width:30px;height:17px;border-radius:99px;background:#dfe0de;position:relative;transition:background .18s}
.g-sw i::after{content:'';position:absolute;width:13px;height:13px;border-radius:50%;background:#fff;top:2px;left:2px;transition:left .18s;box-shadow:0 1px 3px #0002}
.g-sw.on i{background:var(--accent)}
.g-sw.on i::after{left:15px}
.g-ver{margin-left:auto;font-size:10px;color:#9ca0a6;border:1px solid #e8e8e6;border-radius:5px;padding:1px 7px;font-family:ui-monospace,Menlo,monospace}
.g-log{font-size:11.5px;color:#9ca0a6;margin-top:9px;min-height:18px}
`

/* 7 段数码管（纯 SVG，无外部资源） */
const SEG7_JS = `
var SEGMAP={0:'abcdef',1:'bc',2:'abdeg',3:'abcdg',4:'bcfg',5:'acdfg',6:'acdefg',7:'abc',8:'abcdefg',9:'abcdfg'};
var SEGPATHS={a:'M8 8h44',b:'M52 8v40',c:'M52 52v40',d:'M8 92h44',e:'M8 52v40',f:'M8 8v40',g:'M8 50h44'};
function seg7(n,on,off){on=on||'#1f2328';off=off||'#dfe3ea';
  return '<svg width="34" height="56" viewBox="0 0 60 100">'+Object.keys(SEGPATHS).map(function(k){
    return '<path d="'+SEGPATHS[k]+'" stroke="'+(SEGMAP[n].indexOf(k)>=0?on:off)+
      '" stroke-width="8" stroke-linecap="round" fill="none"/>'}).join('')+'</svg>';}
`

/* ================= 演示一：毛刺是什么？（按键消抖对比） =================
 * version: 1 = 上个可用版本（无进阶按钮）；2 = 新版（进阶按钮必崩，演示运行失败回滚）
 * neverReady: 故意不回 ready（演示协议超时判死） */
export function glitch(opts: GlitchOptions = {}): string {
  const ver = opts.version || 1
  const extraBtn = ver >= 2 ? `<button class="g-btn ghost" id="adv">进阶 · 连击 ×5</button>` : ''
  /* neverReady：吞掉 CLIENT 对 init 的 ready 应答，演示协议超时判死（内容照常渲染） */
  const boot = opts.neverReady ? `window.__gen.ready = function () {};` : ''

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
${BASE_CSS}
.g-meters{display:flex;gap:26px;margin:13px 0 9px}
.g-meter{display:flex;flex-direction:column;align-items:center;gap:3px}
.g-meter .lab{font-size:10.5px;color:#9ca0a6}
#gly{width:100%;height:88px;display:block;border:1px solid #eff0f2;border-radius:8px;background:#fbfbfc}
</style></head><body>
<div class="g-row">
  <button class="g-btn" id="key">模拟按下 KEY</button>
  <span class="g-sw on" id="sw"><i></i>消抖</span>
  ${extraBtn}
  <span class="g-ver">v${ver}</span>
</div>
<div class="g-meters">
  <div class="g-meter"><span id="rawSeg"></span><span class="lab">未消抖采样</span></div>
  <div class="g-meter"><span id="debSeg"></span><span class="lab">消抖后认定</span></div>
</div>
<canvas id="gly" width="560" height="88"></canvas>
<div class="g-log" id="log">点「模拟按下 KEY」，观察一次机械抖动被采成几次。</div>
<script>${CLIENT}${SEG7_JS}
/* ---- 应用状态：全部可 JSON 化，整个对象就是快照 ---- */
var S = { count: 0, deb: 0, clean: true, presses: 0, wave: [], bouncing: false, ver: ${ver} };
window.__getState = function () { return JSON.parse(JSON.stringify(S)); };
window.__applyInit = function (p) {
  if (p.snapshot) { S = Object.assign(S, JSON.parse(JSON.stringify(p.snapshot))); paint(); }
};
var KEY = document.getElementById('key'), SW = document.getElementById('sw'),
    RAW = document.getElementById('rawSeg'), DEB = document.getElementById('debSeg'),
    LOG = document.getElementById('log'), CV = document.getElementById('gly'), CX = CV.getContext('2d');

function paint() {
  RAW.innerHTML = seg7(S.count % 10, '#c25a4e');
  DEB.innerHTML = seg7(S.deb % 10);
  SW.classList.toggle('on', S.clean);
  drawWave();
}
/* 波形：最近 N 个采样画阶梯线，弹跳未落定区间淡红 */
function drawWave() {
  var W = CV.width, H = CV.height, n = S.wave.length, show = S.wave.slice(-90);
  CX.clearRect(0, 0, W, H);
  CX.strokeStyle = '#c9ccd2'; CX.lineWidth = 1;
  CX.beginPath(); CX.moveTo(6, H - 18); CX.lineTo(W - 6, H - 18); CX.stroke(); /* 稳定电平参考线 */
  if (!show.length) { CX.fillStyle = '#b9bdc4'; CX.font = '11px sans-serif';
    CX.fillText('（还没有采样）', 10, 22); return; }
  var settleAt = S.wave.length - show.length + settleIdx(show);
  var x0 = 10, x1 = W - 10, yh = 22, yl = H - 30;
  function y(v) { return v ? yh : yl; }
  /* 未落定区淡红 */
  var si = settleIdx(show);
  if (si < show.length - 1) { CX.fillStyle = 'rgba(255,59,48,.07)';
    CX.fillRect(x0, 8, (x1 - x0) * si / (show.length - 1), H - 34); }
  CX.strokeStyle = '#1f2328'; CX.lineWidth = 1.6; CX.beginPath();
  show.forEach(function (v, i) {
    var x = x0 + (x1 - x0) * i / Math.max(1, show.length - 1);
    if (i === 0) { CX.moveTo(x, y(v)); return; }
    var px = x0 + (x1 - x0) * (i - 1) / Math.max(1, show.length - 1);
    CX.lineTo(x, y(show[i - 1])); CX.lineTo(x, y(v));
  });
  CX.stroke();
  CX.fillStyle = '#9ca0a6'; CX.font = '10px ui-monospace,Menlo,monospace';
  CX.fillText('raw key', 10, yh - 8);
  CX.fillStyle = '#c25a4e';
  if (S.bouncing) CX.fillText('弹跳中…', W - 66, yh - 8);
}
function settleIdx(arr) { /* 最后一个跳变之后即「落定」 */
  for (var i = arr.length - 1; i > 0; i--) if (arr[i] !== arr[i - 1]) return i;
  return 0;
}
/* 一次按下 = 确定性伪随机弹跳序列（mock 剧本，可复跑） */
function press() {
  if (S.bouncing) return;
  S.bouncing = true; S.presses++;
  var flips = 2 + (S.presses % 3);                 /* 2–4 次附加跳变 */
  var seq = [{ t: 0, v: 1 }], t = 0;
  for (var i = 1; i <= flips; i++) {
    t += 26 + ((S.presses * 37 + i * 53) % 46);
    seq.push({ t: t, v: seq[i - 1].v ? 0 : 1 });
  }
  var total = t + 60, start = performance.now(), rawInc = 0;
  (function tick(now) {
    var el = now - start, v = 0;
    for (var k = 0; k < seq.length; k++) if (el >= seq[k].t) v = seq[k].v;
    if (!S.wave.length || S.wave[S.wave.length - 1] !== v) {
      S.wave.push(v); if (S.wave.length > 240) S.wave.shift();
      if (v === 1) { S.count = (S.count + 1) % 10; rawInc++; }  /* 每个上升沿都被采样 → 跳数 */
    }
    paint();
    if (el < total) { requestAnimationFrame(tick); return; }
    S.bouncing = false;
    if (S.clean) S.deb = (S.deb + 1) % 10;         /* 稳定后才认定一次按下 */
    else S.deb = S.count;
    LOG.textContent = '第 ' + S.presses + ' 次按下：原始信号弹跳 ' + flips +
      ' 次 → 未消抖 +' + rawInc + '，消抖后 ' + (S.clean ? '+1' : '跟随未消抖');
    paint(); window.__gen.input(S);
  })(start);
}
KEY.onclick = press;
SW.onclick = function () {
  if (S.bouncing) return;
  S.clean = !S.clean;
  LOG.textContent = '消抖 ' + (S.clean ? '开：等信号稳定 60ms 才认定按下' : '关：每个上升沿直接计数');
  paint(); window.__gen.input(S);
};
${opts.neverReady ? '' : `
var adv = document.getElementById('adv');
if (adv) adv.onclick = function () {              /* 运行失败演示：v2 的进阶功能必崩 */
  LOG.textContent = '进阶模式启动…';
  setTimeout(function () { throw new Error('glitch-demo v2: 连击计数器越界（模拟缺陷）'); }, 260);
};`}
paint();
${boot}
</script></body></html>`
}

/* ================= 演示二：建立时间与保持时间 ================= */
export function setupHold(): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
${BASE_CSS}
.g-pane{display:flex;gap:18px;align-items:flex-start;margin-top:12px}
#gly{width:100%;max-width:330px;height:150px;border:1px solid #eff0f2;border-radius:8px;background:#fbfbfc}
.g-side{flex:1;min-width:150px}
.g-slider{margin:10px 0}
.g-slider label{display:flex;justify-content:space-between;font-size:11.5px;color:#656d76;margin-bottom:4px}
.g-slider input{width:100%;accent-color:var(--accent)}
.g-judge{font-size:12px;margin-top:10px;line-height:1.7}
.g-judge.ok{color:#3f7a52}.g-judge.bad{color:#b04a3e}
.g-q{display:inline-block;min-width:20px;text-align:center;border:1px solid #e8e8e6;border-radius:6px;padding:1px 6px;font-family:ui-monospace,Menlo,monospace}
</style></head><body>
<div class="g-row"><span style="font-size:12px;color:#656d76">拖动滑块改变数据跳变位置，看 D 触发器什么时候采到非法值。</span><span class="g-ver">v1</span></div>
<div class="g-pane">
  <canvas id="gly" width="330" height="150"></canvas>
  <div class="g-side">
    <div class="g-slider">
      <label><span>数据跳变相对时钟沿</span><b id="tdLab">−40</b></label>
      <input type="range" id="td" min="-80" max="80" value="-40">
    </div>
    <div class="g-judge ok" id="judge"></div>
    <div style="font-size:11px;color:#9ca0a6;margin-top:8px">输出 q = <span class="g-q" id="q">1</span></div>
  </div>
</div>
<script>${CLIENT}
var S = { td: -40 };
window.__getState = function () { return { td: S.td }; };
window.__applyInit = function (p) {
  if (p.snapshot && p.snapshot.td !== undefined) { S.td = p.snapshot.td; render(); }
};
var CV = document.getElementById('gly'), CX = CV.getContext('2d'),
    SL = document.getElementById('td'), LAB = document.getElementById('tdLab'),
    J = document.getElementById('judge'), Q = document.getElementById('q');
function judge(td) {
  if (td > -20 && td <= 0)  return { ok: false, why: '违反建立时间：数据在沿前 ' + (-td) + 'ns 才变化，需要 ≥ 20ns。' };
  if (td > 0 && td < 10)    return { ok: false, why: '违反保持时间：数据在沿后 ' + td + 'ns 就变化，需要 ≥ 10ns。' };
  return { ok: true, why: '满足建立 / 保持要求，沿上采到稳定值。' };
}
function render() {
  var td = S.td, W = CV.width, H = CV.height, edge = W * .5, dx = edge + td * 1.1;
  LAB.textContent = (td < 0 ? '−' : '+') + Math.abs(td) + ' ns';
  var j = judge(td); J.textContent = j.why; J.className = 'g-judge ' + (j.ok ? 'ok' : 'bad');
  Q.textContent = j.ok ? '1' : '?'; Q.style.color = j.ok ? '#1f2328' : '#b04a3e';
  CX.clearRect(0, 0, W, H);
  /* 建立 / 保持窗口 */
  CX.fillStyle = 'rgba(255,159,10,.10)'; CX.fillRect(edge - 22, 6, 22, H - 42);   /* 建立窗口 */
  CX.fillStyle = 'rgba(255,59,48,.08)';  CX.fillRect(edge, 6, 11, H - 42);        /* 保持窗口 */
  CX.strokeStyle = '#c9ccd2'; CX.setLineDash([3, 3]); CX.beginPath();
  CX.moveTo(edge, 6); CX.lineTo(edge, H - 12); CX.stroke(); CX.setLineDash([]);
  /* clk：沿在 edge */
  CX.strokeStyle = '#8b93a1'; CX.lineWidth = 1.6; CX.beginPath();
  CX.moveTo(8, 32); CX.lineTo(edge, 32); CX.lineTo(edge, 18); CX.lineTo(W - 8, 18); CX.stroke();
  /* data：dx 处 0→1 */
  CX.strokeStyle = '#1f2328'; CX.beginPath();
  CX.moveTo(8, 66); CX.lineTo(dx, 66); CX.lineTo(dx, 52); CX.lineTo(W - 8, 52); CX.stroke();
  /* q：违规画虚线 + 亚稳态标记 */
  CX.lineWidth = 1.4;
  if (j.ok) { CX.strokeStyle = '#3f7a52'; CX.setLineDash([]); CX.beginPath();
    CX.moveTo(8, 106); CX.lineTo(edge, 106); CX.lineTo(edge, 92); CX.lineTo(W - 8, 92); CX.stroke();
  } else { CX.strokeStyle = '#b04a3e'; CX.setLineDash([4, 3]); CX.beginPath();
    CX.moveTo(8, 106); CX.lineTo(W - 8, 106); CX.stroke(); CX.setLineDash([]);
    CX.fillStyle = '#b04a3e'; CX.font = '10px sans-serif';
    CX.fillText('亚稳态', Math.min(Math.max(dx + 4, edge + 14), W - 44), 88);
  }
  CX.fillStyle = '#9ca0a6'; CX.font = '10px ui-monospace,Menlo,monospace';
  CX.fillText('clk', 8, 14); CX.fillText('data', 8, 48); CX.fillText('q', 8, 90);
  CX.fillText('建立 ≥20', edge - 22, H - 16); CX.fillText('保持 ≥10', edge + 2, H - 2);
}
SL.oninput = function () { S.td = +SL.value; render(); window.__gen.input(S); };
SL.value = S.td; render();
</script></body></html>`
}

/* ================= 演示三：消抖前后对比（壳上标「仿真结果」） ================= */
export function simCompare(): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
${BASE_CSS}
#gly{width:100%;height:120px;display:block;border:1px solid #eff0f2;border-radius:8px;background:#fbfbfc;margin-top:12px}
</style></head><body>
<div class="g-row">
  <button class="g-btn" id="run">运行仿真</button>
  <span style="font-size:11.5px;color:#9ca0a6">固定激励：一次 180ms 机械抖动 · 确定性结果</span>
  <span class="g-ver">sim v1</span>
</div>
<canvas id="gly" width="560" height="120"></canvas>
<div class="g-log" id="log">上：原始 key　下：消抖后认定　（按下后自动播放）</div>
<script>${CLIENT}${SEG7_JS}
var S = { runs: 0 };
window.__getState = function () { return { runs: S.runs }; };
window.__applyInit = function (p) { if (p.snapshot) S.runs = p.snapshot.runs || 0; };
var CV = document.getElementById('gly'), CX = CV.getContext('2d'), LOG = document.getElementById('log');
var RAWSEQ = [1,0,1,0,1,0,1];   /* 确定性弹跳剧本：7 个电平 */
function draw(prog) {
  var W = CV.width, H = CV.height, rawY = 30, debY = 92;
  CX.clearRect(0, 0, W, H);
  [rawY, debY].forEach(function (y) { CX.strokeStyle = '#e4e5e3'; CX.beginPath();
    CX.moveTo(8, y + 9); CX.lineTo(W - 8, y + 9); CX.stroke(); });
  var xs = function (i) { return 14 + (W - 28) * i / 6; };
  /* 原始：剧本按播放进度展开 */
  CX.strokeStyle = '#c25a4e'; CX.lineWidth = 1.6;
  var upto = prog * 6;
  CX.beginPath();
  for (var i = 0; i <= 6; i++) {
    if (i > upto + 0.001) break;
    var x = xs(i), yy = RAWSEQ[i] ? rawY - 9 : rawY + 9;
    if (i === 0) CX.moveTo(x, yy);
    else { CX.lineTo(x, RAWSEQ[i - 1] ? rawY - 9 : rawY + 9); CX.lineTo(x, yy); }
  }
  CX.stroke();
  /* 消抖后：剧本走完（信号稳定）才认定一次 */
  CX.strokeStyle = '#1f2328'; CX.beginPath();
  CX.moveTo(14, debY + 9);
  if (prog >= 1) { CX.lineTo(W - 40, debY + 9); CX.lineTo(W - 40, debY - 9); CX.lineTo(W - 8, debY - 9); }
  else CX.lineTo(W - 8, debY + 9);
  CX.stroke();
  CX.fillStyle = '#9ca0a6'; CX.font = '10px ui-monospace,Menlo,monospace';
  CX.fillText('raw key', 10, 12); CX.fillText('debounced', 10, 74);
  if (prog >= 1) { CX.fillStyle = '#3f7a52'; CX.fillText('认定 1 次', W - 76, 74); }
}
document.getElementById('run').onclick = function () {
  S.runs++; var start = performance.now();
  LOG.textContent = '仿真运行中…';
  (function tick(now) {
    var p = Math.min(1, (now - start) / 900); draw(p);
    if (p < 1) requestAnimationFrame(tick);
    else { LOG.textContent = '结果：原始信号 7 个电平 → 未消抖会计 4 次；消抖后认定 1 次。'; window.__gen.input(S); }
  })(start);
};
draw(0);
</script></body></html>`
}
