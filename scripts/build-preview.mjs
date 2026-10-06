/**
 * 预览生成器（开发用，不随插件加载）。
 *
 * 用与 lib/client.js 完全相同的样式字符串渲染面板与常驻控件，先看效果再决定是否装。
 * 样式从 lib/client.js 的 `const css = \`...\`` 里抠出来；官方主题变量（--dsw-*）
 * 在预览页里用浅色/深色两套替身值。
 *
 * 用法：node scripts/build-preview.mjs
 * 产物：preview/panel-preview.html
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

const cssMatch = source.match(/const css = `([\s\S]*?)`;/);
if (cssMatch === null) throw new Error("failed to extract the css template literal from lib/client.js");
const panelCss = cssMatch[1];

/** 面板宽度（与 lib/client.js 的 PANEL_W 一致）。 */
const PANEL_W = 300;

/** 官方主题变量的替身值（浅色 / 深色），仅供预览。 */
const themes = {
	light: {
		label: "浅色（官方 Light）",
		vars: {
			"--dsw-alias-bg-layer-2": "#ffffff",
			"--dsw-alias-border-l1": "#e6e6e6",
			"--dsw-alias-border-l2": "#e3e3e5",
			"--dsw-alias-label-primary": "#1a1a1a",
			"--dsw-alias-label-secondary": "#4d4d4d",
			"--dsw-alias-label-tertiary": "#8c8c8c",
			"--dsw-alias-label-caption": "#9a9a9a",
			"--dsw-alias-label-dimmed": "#c2c2c2",
			"--dsw-alias-interactive-bg-hover": "rgba(0,0,0,.05)",
			"--dsw-alias-state-error-primary": "#d92d20",
			"--dsw-alias-brand-primary": "#4d6bfe",
			"--dsw-radius-md": "10px",
			"--dsw-radius-sm": "6px",
			"--dsw-elevation-prominent": "0 8px 24px rgba(0,0,0,.12)",
			"--page-bg": "#f6f7f9"
		}
	},
	dark: {
		label: "深色（官方 Dark）",
		vars: {
			"--dsw-alias-bg-layer-2": "#2b2b2e",
			"--dsw-alias-border-l1": "#3a3a3e",
			"--dsw-alias-border-l2": "#454549",
			"--dsw-alias-label-primary": "#f2f2f3",
			"--dsw-alias-label-secondary": "#c8c8cc",
			"--dsw-alias-label-tertiary": "#8f8f96",
			"--dsw-alias-label-caption": "#8a8a92",
			"--dsw-alias-label-dimmed": "#5c5c62",
			"--dsw-alias-interactive-bg-hover": "rgba(255,255,255,.08)",
			"--dsw-alias-state-error-primary": "#ff6b6b",
			"--dsw-alias-brand-primary": "#6b83ff",
			"--dsw-radius-md": "10px",
			"--dsw-radius-sm": "6px",
			"--dsw-elevation-prominent": "0 8px 24px rgba(0,0,0,.45)",
			"--page-bg": "#1c1c1f"
		}
	}
};

/** 官方四档（DeepSeek 适配器实际广告的档位）。 */
const tiers = [
	{ id: "off", name: "Off" },
	{ id: "low", name: "Low" },
	{ id: "high", name: "High" },
	{ id: "max", name: "Max" }
];

/** 档位色相（与 lib/client.js 的 tierHue / hueCss 同一条曲线）。 */
function hue(z, spark) {
	const t = Math.min(1, Math.max(0, z));
	return 217 + (274 - 217) * (t * t * 0.55 + t * 0.45) + (spark ? 2 : 0);
}
function hueCss(z, spark) {
	return `oklch(0.62 0.19 ${hue(z, spark).toFixed(1)})`;
}

/** 渲染滑轨面板（结构与 lib/client.js 的 EffortPanel 输出一致）。 */
function panelPanel(active, dragging) {
	const last = tiers.length - 1;
	const percent = active / last;
	const spark = active === last;
	const dots = tiers.map((tier, i) => {
		const z = i / last;
		const isActive = i === active;
		const sparkFactor = spark ? 0 : 1;
		const opacity = (isActive ? 0.9 : 0.42 + 0.22 * percent) * sparkFactor;
		return `<div class="esm-dot" data-active="${isActive}" style="left:calc(12px + (100% - 24px) * ${z.toFixed(6)});opacity:${opacity}"></div>`;
	}).join("");
	// 预览里粒子是静态的（真插件是 canvas 动画）：用固定种子的点模拟布局观感。
	const grains = spark ? [[6, 42], [14, 62], [23, 35], [31, 58], [39, 45], [46, 66], [54, 38], [62, 55], [70, 44], [78, 60], [86, 40], [93, 52]]
		.map(([xp, yp], i) => `<span style="position:absolute;left:${xp}%;top:${yp}%;width:${(1 + (i % 3) * 0.7).toFixed(1)}px;height:${(1 + (i % 3) * 0.7).toFixed(1)}px;border-radius:50%;background:#fff;opacity:${(0.45 + (i % 4) * 0.15).toFixed(2)}"></span>`).join("") : "";
	return `<div class="esm-panel" data-effort-panel="true" data-dragging="${dragging}" data-spark="${spark}" style="width:${PANEL_W}px;--esm-hue:${hueCss(percent, spark)};--esm-spark:${spark ? 1 : 0};--esm-t:${percent.toFixed(4)}">
	<div class="esm-title">${tiers[active].name}</div>
	<div class="esm-model">deepseek-flash</div>
	<div class="esm-rail" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="${last}" aria-valuenow="${active}" aria-valuetext="${tiers[active].name}">
		<div class="esm-railTrack">
			<div class="esm-track"></div>
			<div class="esm-fill" style="width:${(percent * 100).toFixed(4)}%;background:linear-gradient(90deg, ${hueCss(percent * 0.62, spark)}, ${hueCss(1, spark)})">${grains}</div>
			<div class="esm-knob" style="left:${(percent * 100).toFixed(4)}%"></div>
			${dots}
		</div>
	</div>
</div>`;
}

/** 渲染输入框里的常驻控件。 */
function seat(level, disabled = false) {
	return `<button type="button" class="esm-trigger"${disabled ? " disabled" : ""}>
		<span class="esm-triggerName">推理等级</span>
		<span class="esm-triggerLevel">${level}</span>
	</button>`;
}

/** 预览页专用样式（不属于插件）。 */
const pageCss = `
body{margin:0;padding:26px;background:var(--page-bg);font-family:-apple-system,"SF Pro Text","PingFang SC",sans-serif;color:var(--dsw-alias-label-primary)}
h1{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary);margin:0 0 16px}
.theme{display:inline-block;vertical-align:top;margin:0 26px 26px 0}
.theme > h2{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);margin:0 0 10px}
.case{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-bottom:18px}
.cap{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.composer{box-sizing:border-box;width:430px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.composerInput{flex:1;min-width:120px;font-size:13px;color:var(--dsw-alias-label-caption)}
.composerHint{font-size:10px;color:var(--dsw-alias-label-tertiary);margin:2px 0 4px}
`;

const sections = Object.entries(themes).map(([, theme]) => {
	const vars = Object.entries(theme.vars).map(([k, v]) => `${k}:${v}`).join(";");
	const cases = [0, 1, 2, 3, 2].map((active, i) => {
		const dragging = i === 4;
		const caption = dragging ? "拖拽中（圆点随手移动）" : `档位 ${tiers[active].name}`;
		return `<div class="case"><span class="cap">${caption}</span>${panelPanel(active, dragging)}</div>`;
	}).join("");
	return `<section class="theme" style="${vars}">
		<h2>${theme.label}</h2>
		<div class="case">
			<span class="cap">输入框里的常驻控件（点它弹出面板）—— 只剩档位名，没有闪电 / 没有重置</span>
			<div class="composer">
				<span class="composerInput">输入消息…</span>
				${seat("High")}
			</div>
			<div class="composerHint">四个档位下的控件文字：</div>
			<div class="composer">
				<span class="composerInput">输入消息…</span>
				${["Off", "Low", "High", "Max"].map((l) => seat(l)).join("")}
			</div>
			<div class="composerHint">无档位模型（控件禁用）：</div>
			<div class="composer"><span class="composerInput">输入消息…</span>${seat("—", true)}</div>
		</div>
		${cases}
	</section>`;
}).join("");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-effort-minimal 预览</title>
<style>${panelCss}${pageCss}</style>
</head>
<body>
<h1>dsh-effort-minimal · 常驻控件 + 滑轨面板（样式与 lib/client.js 同源）</h1>
${sections}
</body>
</html>
`;

mkdirSync(join(root, "preview"), { recursive: true });
writeFileSync(join(root, "preview", "panel-preview.html"), html, "utf8");
console.log("wrote preview/panel-preview.html");
