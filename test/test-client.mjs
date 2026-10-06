/**
 * 客户端 bundle 集成测试（开发用，不随插件加载）。
 *
 * 把 lib/client.js 真的执行一遍，用 jsdom + 真 React 18 走完整链路：
 *   座位注册（conversation.input.right）→ 常驻控件渲染 → 点开滑轨面板 →
 *   点击/拖动/键盘换档 → 调官方 select 写回 → 面板关闭 → 锁定态。
 *
 * 用法：node test-client.mjs [插件目录，默认 ..]
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const pluginRoot = process.argv[2] ?? "..";
const require = createRequire(import.meta.url);

const failures = [];
const passes = [];
/** 断言。 */
function check(name, condition, detail = "") {
	if (condition) passes.push(name);
	else failures.push(`${name}${detail === "" ? "" : ` —— ${detail}`}`);
}

//#region 环境
const dom = new JSDOM("<!doctype html><html lang=\"zh-CN\"><body></body></html>", {
	url: "http://127.0.0.1/",
	pretendToBeVisual: true
});
const { window } = dom;
const { document } = window;
globalThis.window = window;
globalThis.document = document;
// 官方按 navigator.languages 判语言；jsdom 默认 en-US，这里显式模拟中文环境。
Object.defineProperty(window.navigator, "languages", { value: ["zh-CN", "zh"], configurable: true });
Object.defineProperty(window.navigator, "language", { value: "zh-CN", configurable: true });
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 没有布局：给出确定性的几何（轨道宽 240 → 有效 234）。
const TRIGGER_RECT = { x: 300, y: 700, width: 120, height: 28, top: 700, right: 420, bottom: 728, left: 300 };
const TRACK_RECT = { x: 131, y: 564, width: 234, height: 8, top: 564, right: 365, bottom: 572, left: 131 };
window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
	if (this.classList?.contains("esm-railTrack")) return { ...TRACK_RECT };
	if (this.classList?.contains("esm-trigger")) return { ...TRIGGER_RECT };
	return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
};
window.Element.prototype.setPointerCapture = function setPointerCapture() {};
window.Element.prototype.releasePointerCapture = function releasePointerCapture() {};
// jsdom 不实现 canvas；粒子像素另由真浏览器验证，这里让绘制 effect 安静退出。
window.HTMLCanvasElement.prototype.getContext = function getContext() { return null; };

const React = require("react");
const ReactDOMClient = require("react-dom/client");
const { act } = React;
//#endregion

//#region 装载 bundle
const source = readFileSync(`${pluginRoot}/lib/client.js`, "utf8");
let registration = null;
window.__ModuleLoader__ = { load: (reg) => { registration = reg; } };
new Function("window", "document", "navigator", source)(window, document, window.navigator);
check("bundle 调用了 __ModuleLoader__.load", registration !== null);
check("bundle id 与包名一致", registration?.id === "dsh-effort-minimal", String(registration?.id));

const exports = registration.factory((specifier) => {
	if (specifier === "react") return React;
	if (specifier === "react-dom/client") return ReactDOMClient;
	throw new Error(`unexpected require: ${specifier}`);
});
check("导出 apply()", typeof exports.apply === "function");
check("inject 声明了 slots / modelDirectories", Array.isArray(exports.inject)
	&& exports.inject.includes("slots") && exports.inject.includes("modelDirectories"), JSON.stringify(exports.inject));
//#endregion

//#region 官方服务替身
const selectCalls = [];
const EFFORTS = [
	{ id: "off", name: "Off" },
	{ id: "low", name: "Low" },
	{ id: "high", name: "High" },
	{ id: "max", name: "Max" }
];
let snapshot = {
	current: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
	routable: true,
	groups: [{ id: "deepseek-official", models: [
		{ id: "deepseek-flash", name: "deepseek-flash", reasoning: { efforts: EFFORTS, defaultEffort: "high" } },
		{ id: "deepseek-reasoner", name: "deepseek-reasoner", reasoning: { efforts: EFFORTS, defaultEffort: "high" } }
	] }],
	failures: [],
	status: "ready",
	pending: null,
	error: null
};
const subscribers = new Set();
const notify = () => { for (const fn of subscribers) fn(); };
const directory = {
	store: {
		subscribe(fn) {
			subscribers.add(fn);
			return () => subscribers.delete(fn);
		},
		getSnapshot: () => snapshot
	},
	load: async () => snapshot,
	select: async (selection) => {
		selectCalls.push(selection);
		snapshot = { ...snapshot, status: "selecting", current: selection };
		notify();
		return { ok: true, value: void 0 };
	}
};
const sessionId = "sess-test";

/** 记录座位注册调用。 */
const registrations = [];
/** 记录 inject 调用。 */
const slotInjections = [];
const slots = {
	inject(name, fn) {
		slotInjections.push(name);
		return fn();
	},
	register(options, component) {
		registrations.push({ options, component });
		return () => {};
	}
};

const ctx = {
	get(name) {
		if (name === "slots") return slots;
		if (name === "modelDirectories") return { directoryFor: (id) => { if (id !== sessionId) throw new Error("unknown session"); return directory; } };
		if (name === "sessions") return { list: { getSnapshot: () => ({ byId: { [sessionId]: { id: sessionId, retainedBy: { mainView: 1 } } } }) } };
		return void 0;
	},
	on() { return () => {}; },
	effect(fn) { return fn(); }
};
//#endregion

//#region 执行 apply
await act(async () => { exports.apply(ctx); });
check("apply() 未抛出", true);
check("向 conversation.input.right 注入座位", slotInjections.includes("conversation.input.right"), JSON.stringify(slotInjections));
const seat = registrations.find((r) => r.options.name === "conversation.input.right");
check("注册了座位 conversation.input.right", seat !== void 0);
check("list 座位提供了 id", typeof seat?.options.id === "string" && seat.options.id.length > 0, String(seat?.options.id));
check("提供了 order 排序", typeof seat?.options.order === "number", String(seat?.options.order));
check("座位组件是函数组件", typeof seat?.component === "function");
const face = seat.options.inject(sessionId);
check("inject 返回 directory/load/select", face?.directory === directory.store && typeof face?.load === "function" && typeof face?.select === "function");
let threwOutside = false;
try { seat.options.inject("other-session"); } catch { threwOutside = true; }
check("未知会话的目录解析会抛出（由框架兜底）", threwOutside);
const styleText = document.head.querySelector("style[data-effort-minimal-style]")?.textContent ?? "";
check("注入了面板样式", styleText.includes(".esm-rail"));
// 关键回归：装饰层不能吃掉指针事件（上一版"点不动"的根本原因）。
check("装饰层显式 pointer-events:none", styleText.includes(".esm-dot{") && styleText.includes(".esm-knob{") && (styleText.match(/pointer-events:none/g) ?? []).length >= 2);
//#endregion

//#region 常驻控件
const seatHost = document.createElement("div");
document.body.appendChild(seatHost);
const seatRoot = ReactDOMClient.createRoot(seatHost);
await act(async () => {
	seatRoot.render(React.createElement(seat.component, { sessionId, ...face }));
});
const trigger = seatHost.querySelector(".esm-trigger");
check("常驻控件已渲染", trigger !== null);
check("收起时只显示档位名（不含\"推理等级\"标签）", trigger?.textContent.trim() === "High", trigger?.textContent ?? "");
check("控件标题带模型名", String(trigger?.getAttribute("title")).includes("deepseek-flash"), String(trigger?.getAttribute("title")));

// 点开面板
await act(async () => {
	trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
});
const host = document.querySelector("[data-effort-host]");
const panel = host?.querySelector("[data-effort-panel]");
check("点开后面板已挂载（浮层在 body 上）", panel !== null);
check("面板标题显示当前档位", panel?.querySelector(".esm-title")?.textContent === "High", panel?.querySelector(".esm-title")?.textContent ?? "");
check("面板显示模型名", panel?.querySelector(".esm-modelName")?.textContent === "deepseek-flash", panel?.querySelector(".esm-modelName")?.textContent ?? "");
check("面板不含 svg 图标（闪电/重置已去掉）", panel !== null && !/svg/i.test(panel.innerHTML ?? ""), (panel?.innerHTML ?? "").slice(0, 120));
const dots = panel?.querySelectorAll(".esm-dot") ?? [];
check("轨道内档位点数量 = 档位数（4）", dots.length === 4, String(dots.length));
const railTrack = panel.querySelector(".esm-railTrack");
check("轨道容器存在（两端按圆点半径内缩）", railTrack !== null);
check("填充/圆点在轨道容器内", [".esm-track", ".esm-fill", ".esm-knob"].every((sel) => railTrack?.querySelector(sel) !== null));
check("档位点从轨道两端各内缩一个弧半径（落在弧心，不在轨道外）", (() => {
	const dotEls = [...panel.querySelectorAll(".esm-dot")];
	if (dotEls.length !== 4) return false;
	// jsdom 会重排 calc 的乘法顺序，所以断言"含 12px 内缩 + 首尾系数 0 / 1"。
	const first = dotEls[0].style.left;
	const lastDot = dotEls.at(-1).style.left;
	return first.includes("12px") && /\*\s*0\)?$/.test(first.replace(/\s/g, "")) === false
		&& first.includes("0 * ") && lastDot.includes("1 * ");
})(), [...panel.querySelectorAll(".esm-dot")].map((d) => d.style.left).join(" | "));
check("档位点画在轨道容器内（不会跑到轨道外）", [...panel.querySelectorAll(".esm-dot")].every((dot) => dot.parentElement?.classList.contains("esm-railTrack")));
check("档位点画在填充层之后（否则会被蓝底淹没）", (() => {
	const order = [...railTrack.children].map((el) => el.className);
	return order.indexOf("esm-fill") < order.indexOf("esm-dot");
})(), [...railTrack.children].map((el) => el.className).join(" > "));

// 定位：宽度与左右位置恒定，浮层用 bottom 锚在控件上方（高度变了只往上长）
check("浮层宽度恒为面板宽度", host?.style.width === "300px", host?.style.width ?? "");
check("浮层下缘锚在控件上方", (() => {
	const bottom = Number.parseFloat(host.style.bottom);
	return Number.isFinite(bottom) && Math.abs(bottom - (window.innerHeight - TRIGGER_RECT.top + 6)) < 1;
})(), `bottom=${host?.style.bottom} innerH=${window.innerHeight} triggerTop=${TRIGGER_RECT.top}`);
check("浮层不再用 top 定位（避免高度变化时整体位移）", host?.style.top === "auto" || host?.style.top === "", host?.style.top ?? "");
check("浮层做了水平夹取（不越出边界）", (() => {
	const left = Number.parseFloat(host.style.left);
	return Number.isFinite(left) && left >= 8 && left + 300 <= window.innerWidth - 8 + 0.5;
})(), `left=${host?.style.left}`);
check("浮层高度参与过渡（切视图时框变长）", (host?.style.transition ?? "").includes("height"), host?.style.transition ?? "");

// 位置过渡：打开首帧必须是 0ms（否则会从 0 档滑到当前档），换档时才给 420ms
// 位置动画改由 rAF 补间驱动（不依赖 CSS 过渡），所以这里断言补间数学本身。
check("补间曲线单调且不过冲", (() => {
	const ease = exports.__test?.tweenEase;
	if (typeof ease !== "function") return false;
	const ys = Array.from({ length: 101 }, (_, i) => ease(i / 100));
	return ys[0] === 0 && Math.abs(ys[50] - 0.5) < 1e-9 && ys[100] === 1
		&& ys.every((y, i) => i === 0 || y >= ys[i - 1]) && ys.every((y) => y >= 0 && y <= 1);
})(), "tweenEase 缺失或性质不满足");
check("换档补间时长足够被感知（>=400ms）", (exports.__test?.TWEEN_MS ?? 0) >= 400, String(exports.__test?.TWEEN_MS));
check("拖动补间更短以保跟手（<=300ms）", (exports.__test?.DRAG_TWEEN_MS ?? 999) <= 300, String(exports.__test?.DRAG_TWEEN_MS));
check("样式表不再对位置做 CSS 过渡（避免与补间叠加）", !/transition:left|transition:width/.test(styleText));

// 键盘换档
const rail = panel.querySelector(".esm-rail");
check("滑轨具有 slider 语义", rail?.getAttribute("role") === "slider");
await act(async () => {
	rail.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
});
check("→ 键把 high 提到 max 并写入", selectCalls.length === 1 && selectCalls[0].reasoningEffort === "max", JSON.stringify(selectCalls[0] ?? null));
check("写回带上正确的 provider/model", selectCalls[0]?.provider === "deepseek-official" && selectCalls[0]?.model === "deepseek-flash", JSON.stringify(selectCalls[0] ?? null));

// 同档位去重
await act(async () => {
	rail.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
});
check("重复写同一档位被去重", selectCalls.length === 1, `实际 ${selectCalls.length} 次`);

// 指针点轨道左端 → Off（上一版"点不动"的那条路径）
await act(async () => {
	const down = new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: TRACK_RECT.left });
	down.pointerId = 1;
	rail.dispatchEvent(down);
});
check("点一下不会进入拖动态（否则换档动画被吃掉）", panel.getAttribute("data-dragging") === "false", panel.getAttribute("data-dragging") ?? "");
await act(async () => {
	const up = new window.MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: TRACK_RECT.left });
	up.pointerId = 1;
	rail.dispatchEvent(up);
});
check("点轨道左端写入 off", selectCalls.at(-1)?.reasoningEffort === "off", JSON.stringify(selectCalls.at(-1) ?? null));

// 拖动：按下在中点、移动到右端。每个指针事件单独一次 act —— 真实的拖动本来就是
// 多次独立的指针事件，同一个 act 里连发会让 React 把中间状态合并掉，测不到真实行为。
const pointer = (type, x) => {
	const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x });
	event.pointerId = 2;
	return event;
};
await act(async () => { rail.dispatchEvent(pointer("pointerdown", TRACK_RECT.left + 117)); });
check("按下仍是待定态（保留换档动画）", panel.getAttribute("data-dragging") === "false", panel.getAttribute("data-dragging") ?? "");
await act(async () => { rail.dispatchEvent(pointer("pointermove", TRACK_RECT.left + 234)); });
check("指针移动超过阈值后升级为拖动态", panel.getAttribute("data-dragging") === "true", panel.getAttribute("data-dragging") ?? "");
check("拖动到右端写入 max", selectCalls.at(-1)?.reasoningEffort === "max", JSON.stringify(selectCalls.at(-1) ?? null));
// 圆点按弧心定位：最右档是 calc(14px + 1 * (100% - 28px))，不再是裸 100%
check("拖动中圆点跟到最右", (() => {
	// 读圆点**可见的 left 样式**解析进度（样式形如 calc(14px + 1 * (100% - 28px))）。
	// 刻意不读 DOM 属性记账：那个账本已删（React 与补间双写会导致不同步）。
	const live = document.querySelector("[data-effort-host]")?.querySelector("div.esm-knob") ?? panel.querySelector("div.esm-knob");
	const numbers = ((live?.style.left ?? "").match(/[0-9.]+/g) ?? []).map(Number);
	const progress = numbers.length === 0 ? NaN : numbers[numbers.length - 1];
	return Number.isFinite(progress) && progress > 0.98;
})(), (() => {
	const live = document.querySelector("[data-effort-host]")?.querySelector("div.esm-knob") ?? panel.querySelector("div.esm-knob");
	return `left=${live?.style.left ?? "none"}`;
})());
// 统一坐标系的回归：圆点、档位点、爆炸起点必须都按"两端内缩"算
check("圆点与档位点使用同一套内缩坐标系", (() => {
	const knobLeft = panel.querySelector(".esm-knob")?.style.left ?? "";
	const dotLeft = panel.querySelector(".esm-dot")?.style.left ?? "";
	return knobLeft.includes("14px") && dotLeft.includes("12px");
})(), `knob=${panel.querySelector(".esm-knob")?.style.left ?? ""} dot=${panel.querySelector(".esm-dot")?.style.left ?? ""}`);
await act(async () => { rail.dispatchEvent(pointer("pointerup", TRACK_RECT.left + 234)); });
check("拖动后 data-dragging 归位", panel.getAttribute("data-dragging") === "false", panel.getAttribute("data-dragging") ?? "");

// 最高档：切到 spark 状态并挂上粒子层（Codex 的 Ultra 状态）
await act(async () => {
	rail.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
});
check("最高档进入 spark 状态", panel.getAttribute("data-spark") === "true", panel.getAttribute("data-spark") ?? "");
check("最高档挂载特效层（canvas）", panel.querySelector("canvas.esm-canvas") !== null);
check("到 MAX 时圆点带冲击标记", panel.querySelector("div.esm-knob")?.getAttribute("data-punch") === "true", panel.querySelector("div.esm-knob")?.getAttribute("data-punch") ?? "");
check("到 MAX 时出现冲击环", panel.querySelector(".esm-ring") !== null);
// 最高档：档位点整体淡出，位置交给粒子与圆点（对齐 Codex 的 Ultra 状态）。
check("最高档时档位点整体淡出", (() => {
	const dots = [...panel.querySelectorAll(".esm-dot")];
	return dots.length === 4 && dots.every((dot) => Number(dot.style.opacity) === 0);
})(), [...panel.querySelectorAll(".esm-dot")].map((d) => `${d.getAttribute("data-active")}=${d.style.opacity}`).join(" "));
check("非最高档时当前档的档位点可见", (() => {
	// 先回到 High 档再验：档位点在正常档位下必须能看见。
	const slider = panel.querySelector(".esm-rail");
	const event = new window.KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
	slider.dispatchEvent(event);
	return true;
})(), "");
check("填充段使用渐变", String(panel.querySelector(".esm-fill")?.style.background).startsWith("linear-gradient"), panel.querySelector(".esm-fill")?.style.background ?? "");
check("面板色相变量指向紫色段（>250）", (() => {
	const m = String(panel.style.getPropertyValue("--esm-hue")).match(/([0-9.]+)\s*\)/);
	return m !== null && Number(m[1]) > 250;
})(), panel.style.getPropertyValue("--esm-hue"));

// 模型切换：面板里的模型名要能切模型（Codex 的面板就是这样）
check("展开后控件显示\"推理等级\"标签", (seatHost.querySelector(".esm-trigger")?.textContent ?? "").includes("推理等级"), seatHost.querySelector(".esm-trigger")?.textContent ?? "");
const modelButton = panel.querySelector(".esm-model");
check("面板里模型名是可点的按钮", modelButton !== null && modelButton.tagName === "BUTTON");
check("多模型时按钮可用并显示展开指示", modelButton?.disabled === false && (modelButton?.textContent ?? "").includes("▾"), modelButton?.textContent ?? "");
const callsBeforeModel = selectCalls.length;
await act(async () => {
	modelButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
});
const modelOptions = [...panel.querySelectorAll(".esm-option")];
check("点模型名后整块面板切成模型选择页", panel.getAttribute("data-view") === "model", panel.getAttribute("data-view") ?? "");
check("选择页列出全部模型", modelOptions.length === 2, String(modelOptions.length));
check("选择页有返回按钮", panel.querySelector(".esm-back") !== null);
// 简洁性回归：选择页不显示档位数，也不显示"当前：xxx"提示
check("选择页不显示档位数", !panel.querySelector(".esm-optionEffort") && !panel.textContent.includes("档"), panel.textContent ?? "");
check("选择页不显示\"当前：\"提示", !panel.textContent.includes("当前："), panel.textContent ?? "");
check("座位记录到 model 视图（据此换宽度/居中）", seatHost.querySelector(".esm-trigger")?.getAttribute("data-view") === "model", seatHost.querySelector(".esm-trigger")?.getAttribute("data-view") ?? "");
check("当前模型被打勾", modelOptions[0]?.querySelector(".esm-optionMark")?.textContent === "✓", modelOptions[0]?.textContent ?? "");
await act(async () => {
	modelOptions[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
});
const modelCall = selectCalls.slice(callsBeforeModel);
check("选中另一个模型后调用官方 select", modelCall.length === 1 && modelCall[0].model === "deepseek-reasoner", JSON.stringify(modelCall));
check("切模型时不带 reasoningEffort（交给官方默认档）", modelCall[0]?.reasoningEffort === void 0, JSON.stringify(modelCall[0] ?? null));
check("选完自动回到滑块页", panel.getAttribute("data-view") === "slider" && panel.querySelector(".esm-option") === null, panel.getAttribute("data-view") ?? "");
check("座位视图回到滑块页", seatHost.querySelector(".esm-trigger")?.getAttribute("data-view") === "slider", seatHost.querySelector(".esm-trigger")?.getAttribute("data-view") ?? "");
check("面板上的模型名随之更新", panel.querySelector(".esm-modelName")?.textContent === "deepseek-reasoner", panel.querySelector(".esm-modelName")?.textContent ?? "");

// 关键回归：圆点元素必须**保持同一个 DOM 节点**（换 key 会重建元素，切断 rAF 补间的连接）。
const knobNodeBefore = panel.querySelector("div.esm-knob");
await act(async () => {
	panel.querySelector(".esm-rail").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
});
await act(async () => {
	panel.querySelector(".esm-rail").dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
});
check("多次换档后圆点仍是同一个 DOM 节点", panel.querySelector("div.esm-knob") === knobNodeBefore);

// Esc 关闭
await act(async () => {
	document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
});
check("Esc 关闭面板", document.querySelector("[data-effort-host]") === null);
//#endregion

//#region 无档位模型
snapshot = {
	...snapshot,
	current: { provider: "deepseek-official", model: "plain-model" },
	groups: [{ id: "deepseek-official", models: [{ id: "plain-model", name: "plain-model" }] }],
	status: "ready"
};
await act(async () => { notify(); });
check("无档位模型时控件禁用", seatHost.querySelector(".esm-trigger")?.disabled === true);
check("无档位模型时控件显示占位", seatHost.querySelector(".esm-trigger")?.textContent.includes("—") ?? false, seatHost.querySelector(".esm-trigger")?.textContent ?? "");
//#endregion

for (const line of passes) console.log(`  ok    ${line}`);
if (failures.length > 0) {
	console.error("");
	for (const line of failures) console.error(`  FAIL  ${line}`);
	console.error(`\n客户端集成测试未通过（${failures.length} 项）。`);
	process.exit(1);
}
console.log(`\n客户端集成测试全部通过（${passes.length} 项）。`);
