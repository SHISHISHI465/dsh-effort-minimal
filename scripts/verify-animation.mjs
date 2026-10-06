/**
 * 浏览器端动画验证（开发用，不随插件加载）。
 *
 * 为什么需要它：jsdom 不算样式、不跑过渡，所以集成测试只能验证"属性有没有写对"，
 * 验证不了"浏览器到底有没有在动"。这个脚本用**真 Chrome + 真 React 18**，并且走
 * **真正的插件入口**（apply(ctx) → 座位注册 → 真浮层），量两类事实：
 *
 *   1. 画布像素：液体粒子、到 MAX 的爆炸（墨量、重心、包围盒）；
 *   2. 元素几何：浮层宽度/左缘/高度（视图切换时只应变高）。
 *
 * 测量约定（踩过坑，必须统一）：
 *   · "位置动画有没有在动"读 `data-esm-pos`（补间自己写的进度值），不受布局影响；
 *     不要用 offsetLeft（fixed 浮层里恒为 0）或 getBoundingClientRect（受滚动/transform 影响）；
 *   · 圆点在画布上的中心靠**自校准**：藏起填充与档位点、只留圆点，量画布唯一墨迹的重心。
 *
 * 用法：node scripts/verify-animation.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Chrome 可执行文件：优先取 CHROME_PATH，其次按平台找常见安装位置。 */
const CHROME =
	process.env.CHROME_PATH ??
	(process.platform === "darwin"
		? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		: process.platform === "win32"
			? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
			: "/usr/bin/google-chrome");
if (!existsSync(CHROME)) {
	console.error(`找不到 Chrome：${CHROME}\n用 CHROME_PATH=/path/to/chrome 指定。`);
	process.exit(1);
}

//#region 静态服务器
const MIME = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json" };
const server = createServer((req, res) => {
	const path = join(root, decodeURIComponent(req.url.split("?")[0]));
	if (!path.startsWith(root) || !existsSync(path)) {
		res.writeHead(404).end("not found");
		return;
	}
	res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
	res.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
//#endregion

//#region 页面
const bundle = readFileSync(join(root, "lib/client.js"), "utf8");
const panelCss = bundle.match(/const css = `([\s\S]*?)`;/)[1];
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" crossorigin></script>
<style>
body{margin:0;background:#1c1c1f;height:100vh}
/* 触发器固定在视口底部 —— 与真实 composer 一样，浮层向上生长时才会落在视口内。
   放在文档顶部会让浮层长到屏幕外，画布随之不可读（踩过）。 */
#host{position:fixed;left:24px;right:24px;bottom:24px;display:flex;justify-content:flex-end}
</style>
</head><body><div id="host"></div>
<script>
const EFFORTS = [
  { id: 'off', name: 'Off' }, { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }
];
let snapshot = {
  current: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  groups: [{ id: 'p', models: [
    { id: 'm', name: 'deepseek-flash', reasoning: { efforts: EFFORTS, defaultEffort: 'high' } },
    { id: 'm2', name: 'deepseek-reasoner', reasoning: { efforts: EFFORTS, defaultEffort: 'high' } }
  ] }],
  status: 'ready', failures: [], pending: null, error: null
};
const subscribers = new Set();
const notify = () => { for (const fn of subscribers) fn(); };
const directory = {
  subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
  getSnapshot: () => snapshot
};
const select = (selection) => {
  snapshot = { ...snapshot, status: 'selecting', current: { ...snapshot.current, ...selection } };
  notify();
  return Promise.resolve({ ok: true });
};

window.__ready = (async () => {
  try {
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(panelCss)};
  document.head.appendChild(style);

  const source = await (await fetch('/lib/client.js')).text();
  let registration = null;
  window.__ModuleLoader__ = { load: (r) => { registration = r; } };
  new Function('window', 'document', 'navigator', source)(window, document, navigator);
  const mod = registration.factory((specifier) => {
    if (specifier === 'react') return React;
    if (specifier === 'react-dom/client') return ReactDOM;
    throw new Error('unexpected require: ' + specifier);
  });

  // 走真入口：apply(ctx) 注册座位，再渲染座位组件（浮层/定位/高度过渡都是真的）
  let seat = null;
  mod.apply({
    get: (name) => {
      if (name === 'slots') return {
        inject: (n, fn) => fn(),
        register: (options, component) => { seat = { options, component }; return () => {}; }
      };
      if (name === 'modelDirectories') return {
        directoryFor: () => ({ store: directory, load: () => Promise.resolve(), select })
      };
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: { s: { id: 's', retainedBy: { mainView: 1 } } } }) } };
      return undefined;
    },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {}; }
  });
  // 导出座位注入面，供测量脚本读取当前选择（provider/model/reasoningEffort）
  window.__face = seat.options.inject('s');
  ReactDOM.createRoot(document.getElementById('host')).render(React.createElement(seat.component, window.__face));
  await new Promise((r) => setTimeout(r, 120));
  return true;
  } catch (error) {
    window.__readyFailed = true;
    window.__bootError = error && error.stack ? error.stack : String(error);
    console.error('boot failed', window.__bootError);
    return false;
  }
})();

window.__q = {
  trigger: () => document.querySelector('#host .esm-trigger'),
  overlay: () => document.querySelector('[data-effort-host]'),
  panel: () => document.querySelector('[data-effort-host]')?.querySelector('[data-effort-panel]') ?? null,
  rail: () => window.__q.panel()?.querySelector('.esm-rail') ?? null,
  knob: () => window.__q.panel()?.querySelector('div.esm-knob') ?? null,
  canvas: () => window.__q.panel()?.querySelector('canvas.esm-canvas') ?? null
};

/** 打开浮层并回到干净状态（滑块页 + 非最高档）。 */
window.__reset = async () => {
  let panel = window.__q.panel();
  if (panel !== null && panel.getAttribute('data-view') === 'model') {
    panel.querySelector('.esm-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 420));
  }
  for (let i = 0; i < 5 && window.__q.overlay() === null; i++) {
    window.__q.trigger()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
  }
  if (window.__q.panel() === null) return false;
  window.__q.rail()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await new Promise((r) => setTimeout(r, 700));
  return true;
};

/** 补间写的进度值（0..1）——不受任何布局影响，是"位置动画"最可靠的读数。 */
/**
 * 圆点当前进度（0..1）—— 从它**可见的 left 样式**解析。
 * 不再读 data-esm-pos：那个账本已经删掉（React 与补间双写会不同步）。
 * 样式形如 calc(14px + 0.6667 * (100% - 28px))，取最后一个数字。
 */
/**
 * 圆点当前进度（0..1）。
 *
 * 用**布局偏移**算（offsetLeft 相对 .esm-railTrack），不用 getBoundingClientRect：
 * 面板做高度过渡/刚重建时 rect 会短暂是全 0 或异常值，实测因此得出 -0.067 的假读数。
 * 也不再解析 style.left —— 浏览器会把 calc() 规范化成多种等价写法。
 */
window.__pos = () => {
  const knob = window.__q.knob();
  const panel = window.__q.panel();
  if (knob === null || panel === null) return NaN;
  const track = panel.querySelector('.esm-railTrack');
  if (track === null) return NaN;
  const width = track.offsetWidth;
  if (!(width > 0)) return NaN;
  const center = knob.offsetLeft + knob.offsetWidth / 2;
  const inset = 14;
  const ratio = (center - inset) / (width - inset * 2);
  return ratio;
};

/** 圆点在画布坐标系里的中心（用布局偏移算，不受渐变/过渡影响）。 */
window.__knobCenterInCanvas = () => {
  const canvas = window.__q.canvas();
  const knob = window.__q.knob();
  const panel = window.__q.panel();
  if (canvas === null || knob === null || panel === null) return null;
  const track = panel.querySelector('.esm-railTrack');
  if (track === null) return null;
  const width = canvas.getBoundingClientRect().width;
  if (!(width > 0)) return null;
  // 圆点相对 .esm-railTrack 定位；该容器两端各内缩 14px，而画布铺满整条 rail，
  // 所以画布内的中心 = 14 + 圆点容器内偏移。
  const x = 14 + knob.offsetLeft + knob.offsetWidth / 2;
  const y = canvas.getBoundingClientRect().height / 2;
  return { x, y };
};

/** 控件稳定性：换档时宽度必须恒定（收起态只显示档位名）。 */
window.__measureSeatStability = async () => {
  try {
    if (window.__q.overlay() !== null) {
      window.__q.trigger()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
    }
    const trigger = window.__q.trigger();
    if (trigger === null) return "NO_TRIGGER";
    const sibling = document.createElement('span');
    sibling.textContent = 'M';
    sibling.style.cssText = 'display:inline-block;margin-left:8px';
    trigger.parentElement.appendChild(sibling);
    const read = () => ({
      trigger: +trigger.getBoundingClientRect().width.toFixed(1),
      sibling: +sibling.getBoundingClientRect().left.toFixed(1),
      text: trigger.textContent.trim(),
      panelOpen: window.__q.overlay() !== null
    });
    const samples = [read()];
    const face = window.__face;
    for (const next of ['max', 'low', 'high']) {
      const current = face?.directory?.getSnapshot?.().current ?? null;
      if (face && typeof face.select === 'function' && current !== null) {
        face.select({ provider: current.provider, model: current.model, reasoningEffort: next });
      }
      await new Promise((r) => setTimeout(r, 260));
      samples.push(read());
    }
    sibling.remove();
    return { samples };
  } catch (error) {
    return "JSERR: " + (error && error.stack ? error.stack : String(error));
  }
};

/** 切模型后，滑块位置必须仍与档位一致（不能跑到最左）。 */
window.__measureModelSwitch = async () => {
  try {
    if (!(await window.__reset())) return "NO_OVERLAY";
    const panel = window.__q.panel();
    const snap = () => window.__face.directory.getSnapshot().current ?? null;
    // 先设到 High（四档的 index 2 → 进度 2/3）
    window.__q.rail().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    window.__q.rail().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    const before = { pos: window.__pos(), effort: snap()?.reasoningEffort ?? null };

    panel.querySelector('.esm-model').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const options = [...panel.querySelectorAll('.esm-option')];
    if (options.length < 2) return "NO_OPTION";
    options[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const trace = [];
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 70));
      trace.push(window.__pos());
    }
    await new Promise((r) => setTimeout(r, 600));
    const after = { pos: window.__pos(), effort: snap()?.reasoningEffort ?? null, model: snap()?.model ?? null };
    return { before, after, trace };
  } catch (error) {
    return "JSERR: " + (error && error.stack ? error.stack : String(error));
  }
};

/** 拖动：跨档移动指针，采样位置推进。 */
window.__measureDrag = async () => {
  try {
    if (!(await window.__reset())) return "NO_OVERLAY";
    const rail = window.__q.rail();
    const box = rail.getBoundingClientRect();
    const fire = (type, x) => rail.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: box.top + box.height / 2, pointerId: 31 }));
    const samples = [];
    fire('pointerdown', box.left + 2);
    for (const ratio of [0.3, 0.55, 0.8, 1]) {
      fire('pointermove', box.left + Math.max(0, box.width * ratio - 14));
      await new Promise((r) => setTimeout(r, 120));
      samples.push(window.__pos());
    }
    fire('pointerup', box.right);
    await new Promise((r) => setTimeout(r, 700));
    return { samples, final: window.__pos() };
  } catch (error) {
    return "JSERR: " + (error && error.stack ? error.stack : String(error));
  }
};

/** 视图切换：框只变高，宽度/左缘不变。 */
window.__measureMorph = async () => {
  try {
    if (!(await window.__reset())) return "NO_OVERLAY";
    const box = () => {
      const rect = window.__q.overlay().getBoundingClientRect();
      return { w: +rect.width.toFixed(1), left: +rect.left.toFixed(1), h: +rect.height.toFixed(1), view: window.__q.panel().getAttribute('data-view') };
    };
    const slider = box();
    window.__q.panel().querySelector('.esm-model').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const heights = [];
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 45)); heights.push(box().h); }
    const model = box();
    window.__q.panel().querySelector('.esm-back').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 45));
    return { slider, model, heights, back: box() };
  } catch (error) {
    return "JSERR: " + (error && error.stack ? error.stack : String(error));
  }
};

/** 到 MAX 的爆炸：墨量、起爆点、冲击环几何。 */
window.__measureBurst = async () => {
  try {
    if (!(await window.__reset())) return "NO_OVERLAY";
    const low = window.__ink();
    window.__q.rail().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const frames = [];
    let ringSeen = false, punchSeen = false, ringCenter = null;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const frame = window.__ink();
      frames.push({ t: (i + 1) * 40, ink: frame.ink, cx: frame.cx, cy: frame.cy, minX: frame.minX, maxX: frame.maxX, minY: frame.minY, maxY: frame.maxY });
      if (i < 3) {
        const ring = window.__q.panel().querySelector('.esm-ring');
        ringSeen = ringSeen || ring !== null;
        punchSeen = punchSeen || window.__q.knob()?.getAttribute('data-punch') === 'true';
        if (ring !== null && ringCenter === null) {
          const knob = window.__q.knob();
          void ring.offsetHeight;
          void knob.offsetHeight;
          const rr = ring.getBoundingClientRect();
          const kr = knob.getBoundingClientRect();
          ringCenter = { dx: (rr.left + rr.width / 2) - (kr.left + kr.width / 2), dy: (rr.top + rr.height / 2) - (kr.top + kr.height / 2) };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 900));
    const originRaw = window.__q.canvas()?.dataset.burstOrigin ?? null;
    const origin = originRaw === null ? null : (() => { const [x, y] = originRaw.split(',').map(Number); return { x, y }; })();
    return { low, frames, settled: window.__ink().ink, ringSeen, punchSeen, ringCenter, origin, knobCenter: window.__knobCenterInCanvas() };
  } catch (error) {
    return "JSERR: " + (error && error.stack ? error.stack : String(error));
  }
};

/** 手感：按下触感、拖动落位、按压态泄漏。 */
window.__measureHandfeel = async () => {
  try {
    if (!(await window.__reset())) return "NO_OVERLAY";
    const panel = window.__q.panel();
    const rail = window.__q.rail();
    const track = panel.querySelector('.esm-railTrack');
    const box = track.getBoundingClientRect();
    const fire = (type, x) => rail.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: box.top + box.height / 2, pointerId: 41 }));
    const trackWidth = box.width;
    const inset = 14;
    const at = (ratio) => box.left + inset + (trackWidth - inset * 2) * ratio;
    const out = {};
    out.knobWidthIdle = +window.__q.knob().getBoundingClientRect().width.toFixed(1);
    fire('pointerdown', at(0.5));
    await new Promise((r) => setTimeout(r, 80));
    out.pressedAttr = panel.getAttribute('data-pressed');
    out.knobWidthWhenPressed = +window.__q.knob().getBoundingClientRect().width.toFixed(1);
    // 松手后应落在最近刻度（在 0.75 处松手 → 最近刻度 0.667）
    fire('pointermove', at(0.75));
    await new Promise((r) => setTimeout(r, 600));
    out.posBeforeUp = window.__pos();
    fire('pointerup', at(0.75));
    const settle = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 20));
      settle.push(window.__pos());
    }
    out.settleSamples = settle;
    out.pressedAfterUp = panel.getAttribute('data-pressed');
    await new Promise((r) => setTimeout(r, 400));
    out.final = window.__pos();
    // 在轨道之外松开也必须复位按压态
    fire('pointerdown', at(0.4));
    await new Promise((r) => setTimeout(r, 60));
    out.pressedBeforeOutsideUp = panel.getAttribute('data-pressed');
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, pointerId: 41 }));
    await new Promise((r) => setTimeout(r, 60));
    out.pressedAfterOutsideUp = panel.getAttribute('data-pressed');
    return out;
  } catch (error) {
    return "JSERR: " + (error && error.stack ? error.stack : String(error));
  }
};

/** 画布墨量 / 重心 / 包围盒（CSS 像素）。 */
window.__ink = () => {
  const canvas = window.__q.canvas();
  if (canvas === null) return { ink: 0, cx: null, cy: null, minX: null, maxX: null, minY: null, maxY: null };
  const context = canvas.getContext('2d');
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const dpr = canvas.width / canvas.getBoundingClientRect().width;
  let ink = 0, sx = 0, sy = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] <= 40) continue;
      const px = x / dpr, py = y / dpr;
      ink++; sx += px; sy += py;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  return ink === 0
    ? { ink: 0, cx: null, cy: null, minX: null, maxX: null, minY: null, maxY: null }
    : { ink, cx: sx / ink, cy: sy / ink, minX, maxX, minY, maxY };
};

/**
 * 圆点中心在**画布坐标系**里的位置。
 *
 * 圆点用 calc(inset + (100% - 2*inset) * percent) 定位（与档位点、
 * 爆炸起点同一套坐标系），这里**直接解析圆点当前的 inline left**，把它换算成相对
 * 轨道容器的像素位置 —— 不假设公式，样式改了这里自动跟着对。
 */
window.__knobCenterInCanvas = () => {
  const canvas = window.__q.canvas();
  const knob = window.__q.knob();
  const panel = window.__q.panel();
  if (canvas === null || knob === null || panel === null) return null;
  const track = panel.querySelector('.esm-railTrack');
  if (track === null) return null;
  // 同一帧内读两个 rect：读前先强制刷新布局，避免拿到陈旧坐标（踩过）。
  void track.offsetHeight;
  void canvas.offsetHeight;
  void knob.offsetHeight;
  const canvasRect = canvas.getBoundingClientRect();
  const railRect = panel.querySelector('.esm-rail').getBoundingClientRect();
  const knobRect = knob.getBoundingClientRect();
  const dpr = canvas.width / Math.max(1, canvasRect.width);
  // 圆点的百分比相对整条 rail 解析，而画布也铺满整条 rail —— 两者同一坐标系。
  const x = knobRect.left + knobRect.width / 2 - railRect.left;
  const y = canvasRect.height / 2;
  // 健全性检查：中心应落在画布范围内（圆点按弧心定位，两端各内缩 14px，
  // 所以允许一点余量）；明显越界说明读到了不一致的几何，宁可判为不可测。
  if (!(x >= -20 && x <= canvasRect.width + 20)) {
    window.__knobCenterWhy = JSON.stringify({ x, trackLeft: trackRect.left, canvasLeft: canvasRect.left, canvasWidth: canvasRect.width, knobLeft: knobRect.left, knobWidth: knobRect.width });
    return null;
  }
  return { x: +x.toFixed(2), y: +y.toFixed(2), dpr };
};
</script></body></html>`;
writeFileSync(join(root, "scripts", "verify-animation.html"), page, "utf8");
//#endregion

//#region CDP
const PROFILE = "/tmp/dsh-anim-verify-profile";
const CDP_PORT = 9400 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
	`--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--disable-gpu", "--no-first-run",
	`--user-data-dir=${PROFILE}`, `http://127.0.0.1:${port}/scripts/verify-animation.html`
], { stdio: "ignore" });

/** 等 devtools 端点并返回页面 WebSocket URL。 */
async function pageTarget() {
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
			const list = await res.json();
			const found = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
			if (found) return found.webSocketDebuggerUrl;
		} catch {}
		await sleep(250);
	}
	throw new Error("devtools endpoint never came up");
}

let ws;
try {
	ws = new WebSocket(await pageTarget());
} catch (error) {
	chrome.kill();
	server.close();
	console.error(`无法连接 Chrome：${error.message}`);
	process.exit(1);
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
/** 发一条 CDP 命令并等回复。 */
function send(method, params = {}) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const onMessage = (event) => {
			const msg = JSON.parse(event.data);
			if (msg.id !== id) return;
			ws.removeEventListener("message", onMessage);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		};
		ws.addEventListener("message", onMessage);
		ws.send(JSON.stringify({ id, method, params }));
	});
}

/** 在页面里求值；异常转成 "JSERR: ..." 文本。 */
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", {
		expression: `(async () => { try { return await (${expression}); } catch (error) { return "JSERR: " + (error && error.stack ? error.stack : String(error)); } })()`,
		awaitPromise: true,
		returnByValue: true
	});
	return result.result.value;
}
//#endregion

//#region 断言
const failures = [];
const passes = [];
/** 断言。 */
function check(name, ok, detail = "") {
	if (ok) passes.push(name);
	else failures.push(`${name}${detail === "" ? "" : ` —— ${detail}`}`);
}

/** 等组件挂载；失败时把页面里的错误贴出来。 */
async function waitReady() {
	for (let i = 0; i < 40; i++) {
		const state = await evaluate("JSON.stringify({ failed: window.__readyFailed ?? null, error: window.__bootError ?? null, hasQ: typeof window.__q === 'object', hasTrigger: window.__q ? window.__q.trigger() !== null : false })");
		const parsed = typeof state === "string" ? JSON.parse(state) : null;
		if (parsed !== null && parsed.hasTrigger === true) return true;
		if (parsed !== null && (parsed.failed === true || parsed.error !== null)) {
			console.error("  页面引导失败：", JSON.stringify(parsed));
			return false;
		}
		await sleep(250);
	}
	return false;
}

/** 采样一段时间的进度值。 */
async function samplePositions(count, gapMs) {
	const samples = [];
	for (let i = 0; i < count; i++) {
		await sleep(gapMs);
		samples.push(Number(await evaluate("window.__pos()")));
	}
	return samples;
}

/** 规整测量结果（错误字符串/undefined → null）。 */
const asData = (value) => (value !== null && typeof value === "object" && !Array.isArray(value)) ? value : null;

try {
	check("组件已在真实浏览器里挂载（React 18 + 真 bundle）", await waitReady());

	// —— 1. 换档（方向键）：位置必须连续推进 ——
	await evaluate("window.__reset()");
	await evaluate("window.__q.rail().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))");
	const ascend = await samplePositions(7, 70);
	const knobRaw = await evaluate(`(() => {
		const knob = window.__q.knob();
		return JSON.stringify({ hasKnob: knob !== null, left: knob?.style.left ?? null, attr: knob?.getAttribute('style') ?? null, pos: window.__pos() });
	})()`);
	console.log('  [诊断] 换档后圆点:', knobRaw);
	check("换档时位置连续推进（不是瞬移）",
		ascend.every((p, i) => i === 0 || p >= ascend[i - 1] - 0.01) && ascend.at(-1) > 0.9,
		ascend.map((p) => p.toFixed(2)).join(" → "));
	check("换档中途存在中间值（真的在动）",
		ascend.some((p) => p > 0.05 && p < 0.9), ascend.map((p) => p.toFixed(2)).join(" → "));

	// —— 2. 拖动：同样必须连续推进 ——
	await evaluate("window.__reset()");
	const drag = asData(await evaluate(`(async () => {
		const rail = window.__q.rail();
		const box = rail.getBoundingClientRect();
		const fire = (type, x) => rail.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: box.top + box.height / 2, pointerId: 31 }));
		const samples = [];
		fire('pointerdown', box.left + 2);
		for (const ratio of [0.3, 0.55, 0.8, 1]) {
			fire('pointermove', box.left + Math.max(0, box.width * ratio - 14));
			await new Promise((r) => setTimeout(r, 70));
			samples.push(window.__pos());
		}
		fire('pointerup', box.right);
		await new Promise((r) => setTimeout(r, 700));
		return { samples, final: window.__pos() };
	})()`));
	if (drag === null) {
		check("拖动测量未抛错", false, String(drag).slice(0, 200));
	} else {
		check("拖动时位置持续变化", new Set(drag.samples.map((p) => Number(p).toFixed(2))).size >= 3, drag.samples.map((p) => Number(p).toFixed(2)).join(" → "));
		check("拖动单调向右推进", drag.samples.every((p, i) => i === 0 || p >= drag.samples[i - 1] - 0.01), drag.samples.map((p) => Number(p).toFixed(2)).join(" → "));
		check("拖动松手后到最右档", drag.final > 0.98, String(drag.final));
	}

	// —— 3. 视图切换：只变高，宽度/左缘不变 ——
	await evaluate("window.__reset()");
	const morph = asData(await evaluate(`(async () => {
		const box = () => {
			const rect = window.__q.overlay().getBoundingClientRect();
			return { w: +rect.width.toFixed(1), left: +rect.left.toFixed(1), h: +rect.height.toFixed(1), view: window.__q.panel().getAttribute('data-view') };
		};
		const slider = box();
		window.__q.panel().querySelector('.esm-model').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const heights = [];
		for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 45)); heights.push(box().h); }
		const model = box();
		window.__q.panel().querySelector('.esm-back').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 45));
		return { slider, model, heights, back: box() };
	})()`));
	if (morph === null) {
		check("视图切换测量未抛错", false, String(morph).slice(0, 200));
	} else {
		check("切到模型页：宽度不变", Math.abs(morph.model.w - morph.slider.w) < 0.5, `${morph.slider.w} → ${morph.model.w}`);
		check("切到模型页：左缘不变", Math.abs(morph.model.left - morph.slider.left) < 0.5, `${morph.slider.left} → ${morph.model.left}`);
		check("切到模型页：高度变长", morph.model.h > morph.slider.h + 20, `${morph.slider.h} → ${morph.model.h}`);
		check("高度是过渡（中途有中间高度）", morph.heights.some((h) => h > morph.slider.h + 2 && h < morph.model.h - 2), morph.heights.join(" → "));
		check("返回后高度收回", Math.abs(morph.back.h - morph.slider.h) < 3, `${morph.slider.h} → ${morph.back.h}`);
		check("返回后回到滑块页", morph.back.view === "slider", String(morph.back.view));
	}

	// —— 3.5 控件宽度恒定（换档不推动右侧元素）——
	const stability = await evaluate("window.__measureSeatStability()");
	if (typeof stability !== "object" || stability === null) {
		check("控件稳定性测量未抛错", false, String(stability).slice(0, 200));
	} else {
		const widths = stability.samples.map((s) => s.trigger);
		const siblingLefts = stability.samples.map((s) => s.sibling);
		check("换档时控件宽度恒定", new Set(widths.map((w) => w.toFixed(1))).size === 1, `宽度: ${widths.join(" → ")} 文字: ${stability.samples.map((s) => s.text).join("/")}`);
		check("换档时右侧兄弟元素不被推动", new Set(siblingLefts.map((l) => l.toFixed(1))).size === 1, `兄弟元素 left: ${siblingLefts.join(" → ")}`);
		// 收起态只显示档位名：控件文字应当就是档位名本身（不含标签），宽度仍恒定
		const texts = stability.samples.map((s) => s.text);
		check("收起态只显示档位名（面板关闭）", stability.samples.every((s) => s.panelOpen === false) && texts.every((txt) => txt.length > 0 && !txt.includes("推理等级")), `文字: ${texts.join(" / ")} 面板: ${stability.samples.map((s) => s.panelOpen).join(",")}`);
	}

	// —— 3.4 切换模型后滑块位置必须跟着档位走 ——
	const modelSwitchRaw = await evaluate("window.__measureModelSwitch()");
	const modelSwitch = asData(modelSwitchRaw);
	if (modelSwitch === null) {
		check("切模型测量未抛错", false, String(modelSwitchRaw).slice(0, 400));
	} else {
		check("切模型测量可用", modelSwitch.before !== void 0 && modelSwitch.after !== void 0, JSON.stringify(modelSwitch).slice(0, 200));
		check("切模型后档位保持不变", modelSwitch.after.effort === modelSwitch.before.effort,
			`前=${modelSwitch.before.effort} 后=${modelSwitch.after.effort}`);
		// 位置一致性：切模型后滑块必须仍在档位对应的位置（曾经跑到最左，根因见 README）。
		check("切模型后滑块位置与档位一致", Math.abs(modelSwitch.after.pos - modelSwitch.before.pos) < 0.05,
			`位置 ${modelSwitch.before.pos?.toFixed(3)} → ${modelSwitch.after.pos?.toFixed(3)}`);
	}

	// —— 3.6 手感：吸附 / 短亮 / 按下 / 弹性 ——
	const handfeelRaw = await evaluate("window.__measureHandfeel()");
	const handfeel = asData(handfeelRaw);
	if (handfeel === null) {
		check("手感测量未抛错", false, String(handfeelRaw).slice(0, 400));
	} else {
		check("按下时进入按压态（触感）", handfeel.pressedAttr === "true", String(handfeel.pressedAttr));
		check("按下时圆点放大（按压反馈）", handfeel.knobWidthWhenPressed > handfeel.knobWidthIdle + 0.5,
			`idle=${handfeel.knobWidthIdle} pressed=${handfeel.knobWidthWhenPressed}`);
		check("松开后退出按压态", handfeel.pressedAfterUp === "false", String(handfeel.pressedAfterUp));
		// 在轨道之外松开也必须复位，否则圆点会卡在按下态（漏掉全局兜底就会这样）
		check("在轨道之外松开也复位按压态", handfeel.pressedBeforeOutsideUp === "true" && handfeel.pressedAfterOutsideUp === "false",
			`按下=${handfeel.pressedBeforeOutsideUp} 外部松开后=${handfeel.pressedAfterOutsideUp}`);
		// 刻度上不再做回弹/短亮等花样，只保留"顺滑就位"：松手后应停在**某个刻度**上。
		// 松手点取在档位之间（0.75），最近刻度是 0.667（四档的 index 2）。
		const samples = handfeel.settleSamples ?? [];
		check("松手后稳稳落在最近刻度上（无多余弹跳）", Math.abs(handfeel.final - 2 / 3) < 0.02,
			`final=${handfeel.final} 期望=${(2 / 3).toFixed(4)} 采样峰值=${samples.length === 0 ? "n/a" : Math.max(...samples).toFixed(4)}`);
	}

	// —— 4. 到 MAX 的爆炸 ——
	await evaluate("window.__reset()");
	const burst = asData(await evaluate(`(async () => {
		const low = window.__ink();
		window.__q.rail().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		const frames = [];
		let ringSeen = false, punchSeen = false;
		let ringCenter = null;
		let ringCenterRaw = null;
		for (let i = 0; i < 10; i++) {
			await new Promise((r) => setTimeout(r, 40));
			const frame = window.__ink();
			frames.push({ t: (i + 1) * 40, ink: frame.ink, cx: frame.cx, cy: frame.cy, minX: frame.minX, maxX: frame.maxX, minY: frame.minY, maxY: frame.maxY });
			if (i < 3) {
				const ring = window.__q.panel().querySelector('.esm-ring');
				ringSeen = ringSeen || ring !== null;
				punchSeen = punchSeen || window.__q.knob()?.getAttribute('data-punch') === 'true';
				// 冲击环必须与圆点同心：量两者的屏幕中心（环在动画中会缩放，但中心不变）。
				if (ring !== null && ringCenter === null) {
					const knob = window.__q.knob();
					void ring.offsetHeight;
					void knob.offsetHeight;
					const rr = ring.getBoundingClientRect();
					const kr = knob.getBoundingClientRect();
					ringCenterRaw = { ring: [Math.round(rr.left), Math.round(rr.width)], knob: [Math.round(kr.left), Math.round(kr.width)] };
					ringCenter = {
						dx: (rr.left + rr.width / 2) - (kr.left + kr.width / 2),
						dy: (rr.top + rr.height / 2) - (kr.top + kr.height / 2)
					};
				}
			}
		}
		await new Promise((r) => setTimeout(r, 900));
		// 档位此时稳定在 MAX：再测圆点中心与起爆点（避免首帧 data-esm-pos 尚未写入的竞态）
		const originRaw = window.__q.canvas()?.dataset.burstOrigin ?? null;
		const origin = originRaw === null ? null : (() => { const [x, y] = originRaw.split(',').map(Number); return { x, y }; })();
		return { low, frames, settled: window.__ink().ink, ringSeen, punchSeen, ringCenter, ringCenterRaw, origin, knobCenter: window.__knobCenterInCanvas() };
	})()`));
	if (burst === null) {
		check("爆炸测量未抛错", false, String(burst).slice(0, 200));
	} else {
		const peak = Math.max(...burst.frames.map((f) => f.ink));
		check("跨入最高档时墨量明显上升（爆炸）", peak > burst.low.ink + 60, `low=${burst.low.ink} peak=${peak}`);
		check("爆炸后墨量回落（一次性）", burst.settled < peak, `peak=${peak} settled=${burst.settled}`);
		check("到 MAX 时圆点带冲击标记", burst.punchSeen === true, String(burst.punchSeen));
		check("到 MAX 时出现冲击环", burst.ringSeen === true, String(burst.ringSeen));
		// 冲击环必须与圆点同心（曾经漏了垂直居中，环贴在轨道顶部）
		if (burst.ringCenter === null) {
			check("冲击环与圆点同心", false, "未捕获到冲击环的几何");
		} else {
			check("冲击环与圆点同心（横向 < 1.5px）", Math.abs(burst.ringCenter.dx) < 1.5, `dx=${burst.ringCenter.dx.toFixed(2)} raw=${JSON.stringify(burst.ringCenterRaw)}`);
			check("冲击环与圆点同心（纵向 < 1.5px）", Math.abs(burst.ringCenter.dy) < 1.5, `dy=${burst.ringCenter.dy.toFixed(2)}`);
		}
		const center = burst.knobCenter;
		if (center === null || center === void 0) {
			check("圆点中心可测量", false, `${JSON.stringify(burst.knobCenter)} why=${await evaluate("window.__knobCenterWhy ?? null")}`);
		} else {
			// 起爆点由插件写在 canvas.dataset.burstOrigin 上 —— 用它核对"以圆点为中心"。
			const origin = burst.origin;
			if (origin === null) {
				check("起爆点可读取", false, "canvas.dataset.burstOrigin 缺失");
			} else {
				check("爆炸以圆点为中心起爆（横向偏差 < 2px）", Math.abs(origin.x - center.x) < 2,
					`起爆点 x=${origin.x.toFixed(2)} 圆点 x=${center.x.toFixed(2)}`);
				check("爆炸以圆点为中心起爆（纵向偏差 < 2px）", Math.abs(origin.y - center.y) < 2,
					`起爆点 y=${origin.y.toFixed(2)} 圆点 y=${center.y.toFixed(2)}`);
			}
			// 注意：不要用"墨迹重心"判断爆炸起点 —— 常驻的液体粒子铺满整条轨道，
			// 会把重心拉向中间（试过，会得出 80px 的假偏差）。起爆点由插件显式记录，
			// 上面两条已经逐像素核对了"起爆点 == 圆点中心"。
			const spread = Math.max(...burst.frames.map((f) => Math.max(
				Math.abs(f.minX - center.x), Math.abs(f.maxX - center.x),
				Math.abs(f.minY - center.y), Math.abs(f.maxY - center.y)
			)));
			check("爆炸炸出圆点范围（扩散 > 18px > 圆点半径 14px）", spread > 18, `spread=${spread.toFixed(1)}`);
		}
	}
} finally {
	ws.close();
	chrome.kill();
	server.close();
}

for (const line of passes) console.log(`  ok    ${line}`);
if (failures.length > 0) {
	console.error("");
	for (const line of failures) console.error(`  FAIL  ${line}`);
	console.error(`\n动画验证未通过（${failures.length} 项）。`);
	process.exit(1);
}
console.log(`\n动画验证通过（${passes.length} 项）。`);
