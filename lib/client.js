/**
 * dsh-effort-minimal — 浏览器端实现。
 *
 * 目标：推理档位不再藏在「模型选择器 → 推理等级」的二级菜单里，而是**常驻在输入框**
 * （官方 list 座位 `conversation.input.right`，与官方模型座位同一行）。点一下档位名，
 * 弹出一条克制的滑轨：档位文字 + 模型名 + 细轨 / 档位点 / 圆点，版式参照 Codex 的
 * 推理强度面板，但**不带**左上角闪电图标、**不带**右上角重置图标。
 *
 * 数据流全部走官方服务与官方 API（与官方模型菜单同一份目录）：
 *   - ctx.get("modelDirectories").directoryFor(sessionId)   读模型目录 / 当前档位
 *   - directory.store.subscribe / getSnapshot                订阅目录快照
 *   - directory.select({provider, model, reasoningEffort})   写推理档位
 *   - ctx.slots.inject(...) / ctx.slots.register(...)        注册常驻控件（list 座位）
 *   - ctx.on("theme/change")                                 主题切换时重渲染
 *
 * 历史教训（写在这里避免重犯）：
 *   1. 声明了 dsh.client 就必须有 exports["./client"]，否则 required 插件 modules
 *      激活失败、整个应用起不来（scripts/preflight.mjs 已把这条固化成检查）；
 *   2. 刻度和档位文字那一层必须 pointer-events:none —— 它压在轨道下半部分上，
 *      会吃掉指针事件，表现就是"点不动 / 拖不动"；
 *   3. 别用与 React 根节点同名的 data 属性（HTML 属性名不区分大小写，会撞车）。
 */

window.__ModuleLoader__.load({
	id: "dsh-effort-minimal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_dom_client = require("react-dom/client");
		let react = require("react");

		//#region 文案
		/**
		 * 是否使用中文文案。判定顺序对齐官方 `dsh-client-locale` 的
		 * detectBrowserLocale：navigator.languages（有序）→ navigator.language，
		 * 两者都没给出结论时再看 <html lang>。
		 */
		function prefersChinese() {
			const tags = [];
			if (typeof navigator !== "undefined") {
				if (Array.isArray(navigator.languages)) tags.push(...navigator.languages);
				if (typeof navigator.language === "string") tags.push(navigator.language);
			}
			if (tags.length === 0 && typeof document !== "undefined") {
				const lang = document.documentElement?.lang;
				if (typeof lang === "string") tags.push(lang);
			}
			return tags.some((tag) => String(tag).toLowerCase().startsWith("zh"));
		}

		/** 取当前界面语言的一套文案。 */
		function resolveText() {
			return prefersChinese() ? {
				effort: "推理等级",
				loading: "模型目录加载中…",
				noTiers: "当前模型不提供多档推理等级",
				failed: (message) => `模型目录加载失败：${message}`,
				seatTitle: (model, level) => `推理等级：${model} · ${level}`,
				dragHint: "点击或拖动选择推理等级"
			} : {
				effort: "Effort",
				loading: "Loading model catalog…",
				noTiers: "This model exposes no reasoning tiers",
				failed: (message) => `Failed to load model catalog: ${message}`,
				seatTitle: (model, level) => `Reasoning effort: ${model} · ${level}`,
				dragHint: "Click or drag to pick a reasoning level"
			};
		}
		//#endregion

		//#region 样式
		/** 滑块页的面板宽度（定位与 CSS 必须一致）。 */
		const PANEL_W = 300;
		/** 圆点直径（与 CSS .esm-knob 必须一致）。轨道两端按它的一半内缩，圆点才不会被裁。 */
		const KNOB = 28;
		/** 轨道两端内缩量 = 圆点半径。 */
		const INSET = KNOB / 2;
		/**
		 * 胶囊弧半径 = 轨道高度的一半（与 CSS `.esm-railTrack` 的 height/2、
		 * 以及 `.esm-track` 的 border-radius 必须一致）。档位点从轨道两端各内缩
		 * 这么多，0% / 100% 才是弧心而不是轨道外面。
		 */
		const ARC = 12;
		/**
		 * 圆点（以及冲击环、爆炸起点）相对轨道容器两端的内缩量。
		 * 与 INSET 同一个值，单列出来是为了让"所有会动的东西共用一套坐标"这件事在代码里显式可见：
		 * 统一公式 `calc(KNOB_INSET + (100% - 2 * KNOB_INSET) * percent)`。
		 */
		const KNOB_INSET = INSET;

		/**
		 * 面板实例自增种子。
		 *
		 * 模型下拉重渲染时面板**实例会被重建**，新旧实例并存期间，
		 * 老实例卸载的 ref 回调（null）会清掉新实例刚装上的圆点引用 ——
		 * 补间于是写到不存在的元素上，页面上的圆点没有 left、永远贴在最左。
		 * 每个实例领一个 id 用于"认领"自己的元素，null 回调只清自己装的。
		 */
		let panelInstanceSeed = 0;

		/**
		 * 面板与常驻控件的样式。几何算式与定位共用一套：
		 *   轨道整体 `left:3px; right:3px`，圆点半径 8px；
		 *   圆点停在系数 p 时 `left: calc(3px + (100% - 6px) * p)`，档位小点用同一算式，
		 *   因此圆点永远精确落在档位点上，两端也不溢出。
		 *
		 * 配色全部用官方主题变量（--dsw-*），官方切浅色/深色时自动跟随。
		 *
		 * ⚠️ `.esm-ticks` 这类覆盖在轨道上的装饰层必须 pointer-events:none，
		 *    否则会吃掉指针事件（上一版"点不到"就是这个原因）。
		 */
		/**
		 * 面板与常驻控件的样式。
		 *
		 * 视觉规则（对齐 Codex 的两套状态）：
		 *   · 轨道两端是胶囊圆头（8px 高、圆角 4px），圆点（22px）比轨道粗得多，压在轨道上；
		 *   · 正常档：轨道蓝色实心，档位点随档位推进逐渐变实，当前档的点更亮；
		 *   · 最高档（Ultra）：轨道换成本档专属色 + 渐变，档位点淡出，填充段内跑一层
		 *     白色粒子（canvas 绘制，见 TrackFx）—— 像液体里悬浮抖动，到最高档还会炸一下。
		 *
		 * 色相由 React 按当前档位写进 `--esm-hue`（最低档偏青蓝、最高档偏紫），
		 * 其余颜色一律 `color-mix(in oklab, var(--esm-hue) …)` 推出来，所以新增/减少档位
		 * 不需要改 CSS。`--esm-spark` 只表示"最高档"，非最高档为 0。
		 *
		 * 配色基准仍取自官方主题变量（--dsw-*），官方切浅色/深色时自动跟随。
		 *
		 * ⚠️ 覆盖在轨道上的装饰层必须 pointer-events:none，否则会吃掉指针事件
		 *    （"点不动 / 拖不动"就是这么来的）。
		 */
		const css = `
.esm-panel{box-sizing:border-box;width:100%;padding:16px 18px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent);user-select:none;-webkit-user-select:none;display:flex;flex-direction:column}
.esm-title{display:flex;align-items:center;justify-content:center;min-height:20px;font-size:13px;font-weight:600;line-height:18px;color:var(--esm-hue)}
.esm-modelRow{display:flex;justify-content:center;margin-top:2px;min-width:0}
.esm-model{display:inline-flex;align-items:center;gap:3px;max-width:100%;padding:1px 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer;min-width:0}
.esm-model:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.esm-model:disabled{cursor:default}
.esm-model:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--esm-hue))}
.esm-modelName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.esm-modelChevron{flex:none;font-size:9px;line-height:1;opacity:.8}
.esm-rail{position:relative;height:52px;margin-top:10px;cursor:pointer;touch-action:none}
.esm-railTrack{position:absolute;left:14px;right:14px;top:50%;height:24px;margin-top:-12px}
.esm-track{position:absolute;inset:0;border-radius:12px;background:var(--dsw-alias-border-l2)}
.esm-fill{position:absolute;left:0;top:0;bottom:0;border-radius:12px;background:var(--esm-hue);overflow:hidden;transition:background .28s ease}
/* 画布铺满**整条** rail（不放在 .esm-railTrack 里 —— 那是内缩后的容器，会把爆炸裁在 24px 的窄条里）。 */
.esm-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.esm-dot{position:absolute;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:rgba(255,255,255,.62);pointer-events:none;transition:opacity .28s ease}
.esm-dot[data-active="true"]{background:#fff}
.esm-knob{position:absolute;top:50%;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.3),0 0 0 1px rgba(0,0,0,.05);transition:box-shadow .28s ease,transform .16s ease;pointer-events:none}
.esm-panel[data-pressed="true"] .esm-knob{transform:scale(1.08)}
/* 按下时圆点的光晕扩散得更开，松开收回 —— 这是"触感"里最容易感知的一半。 */
.esm-panel[data-pressed="true"] .esm-knob{box-shadow:0 1px 5px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.05),0 0 22px 5px color-mix(in oklab, var(--esm-hue) 55%, transparent)}
/* 圆点滑到 MAX 的那一下：先胀后收（配合 canvas 粒子爆炸 + 冲击环）。 */
.esm-knob[data-punch="true"]{animation:esm-punch .42s cubic-bezier(.3,1.4,.4,1)}
@keyframes esm-punch{0%{transform:scale(1)}28%{transform:scale(1.34)}100%{transform:scale(1)}}
/* 冲击环：从圆点向外扩散并淡出（只画环，不填实心）。 */
/**
 * 冲击环：挂在**圆点内部**，用 left/top 50% + 负 margin 居中。
 * 这样"与圆点同心"是结构性保证 —— 不再依赖百分比基准、内缩量、坐标换算
 * （之前放在轨道容器里，环与圆点的坐标基准不同，实测偏了整整一条 rail 的宽度）。
 */
.esm-ring{position:absolute;left:50%;top:50%;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;border:2px solid var(--esm-hue);box-sizing:border-box;pointer-events:none;animation:esm-ring .5s cubic-bezier(.2,.9,.3,1) forwards}
@keyframes esm-ring{0%{transform:scale(.55);opacity:.85}100%{transform:scale(2);opacity:0}}
.esm-panel[data-spark="true"] .esm-knob{box-shadow:0 1px 5px rgba(0,0,0,.3),0 0 0 1px rgba(0,0,0,.05),0 0 18px 3px color-mix(in oklab, var(--esm-hue) 58%, transparent)}
.esm-rail:hover .esm-knob{box-shadow:0 1px 6px rgba(0,0,0,.34),0 0 0 1px rgba(0,0,0,.05)}
.esm-rail:focus-visible{outline:none}
.esm-rail:focus-visible .esm-knob{box-shadow:0 0 0 3px var(--dsw-focus-ring-color,var(--esm-hue))}
.esm-msg{text-align:center;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:10px}
.esm-error{color:var(--dsw-alias-state-error-primary)}
.esm-viewHead{display:flex;align-items:center;gap:6px;min-height:28px;flex:none}
.esm-back{display:grid;place-items:center;width:26px;height:26px;margin-left:-6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1;cursor:pointer;flex:none}
.esm-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.esm-back:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--esm-hue))}
.esm-viewTitle{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.esm-modelList{max-height:min(46vh,340px);overflow-y:auto;margin:0 -4px;padding:0 4px}
.esm-groupLabel{padding:8px 6px 3px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-caption)}
.esm-option{display:flex;align-items:center;gap:8px;width:100%;min-height:42px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.esm-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.esm-option[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover)}
.esm-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.esm-optionName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.esm-optionMark{flex:none;width:14px;text-align:center;color:var(--esm-hue);font-size:12px}
.esm-trigger{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer}
.esm-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.esm-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.esm-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--esm-hue))}
.esm-triggerName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}
/**
 * 档位文字**预留固定宽度**：各档名称长度不一（High / Max / Medium …），若让文字撑开宽度，
 * 每次换档整个控件都会伸缩，右侧的官方模型按钮跟着左右位移 —— 观感上就是"字体位置在抖"。
 * 这里按最长档名留位（默认容得下 6 个字符），文字在里面左对齐，控件宽度因而恒定。
 */
.esm-triggerLevel{color:var(--esm-hue);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none;min-width:var(--esm-level-w,0px);text-align:left}
`;
		//#endregion

		//#region 工具
		/**
		 * 解析当前主视图会话 id。
		 *
		 * 官方 0.1.6-alpha.2 起把「视图选择」移出 sessions 控制器，`list.current` 被删，
		 * 当前会话改为「被主视图 retain 的会话」；这里两代兼容：先读 list.current，
		 * 取不到再按 retainedBy.mainView 判定（与官方 ui-layout / ui-session 同款）。
		 */
		function currentSessionId(sessions) {
			const list = sessions?.list?.getSnapshot?.();
			if (list === void 0 || list === null) return void 0;
			if (typeof list.current === "string") return list.current;
			const byId = list.byId;
			if (byId === void 0 || byId === null) return void 0;
			for (const row of Object.values(byId)) if ((row?.retainedBy?.mainView ?? 0) > 0) return row.id;
			return void 0;
		}

		/**
		 * 档位色相：最低档偏青蓝，最高档偏紫。
		 *
		 * t=0 → 225°（青蓝）、t=1 → 272°（紫）；z 再往前拉一点，让最低档的青蓝更正，
		 * 最高档同时叠一层提饱和，做出 Codex 那种"到顶了颜色就不一样"的观感。
		 *
		 * @param z - 档位进度（0..1，可以略小于 0 或大于 1）。
		 * @param spark - 是否最高档（只影响饱和/亮度的轻微加成）。
		 * @returns 色相角（度）。
		 */
		function tierHue(z, spark) {
			const start = 217;
			const end = 274;
			const t = Math.min(1, Math.max(0, z));
			return start + (end - start) * (t * t * 0.55 + t * 0.45) + (spark ? 2 : 0);
		}

		/**
		 * 把色相角变成可用的 CSS 颜色。
		 * @param hue - 色相角（度）。
		 * @returns `oklch()` 颜色字符串（面板内部所有颜色都从它推导）。
		 */
		function hueCss(hue) {
			return `oklch(0.62 0.19 ${hue.toFixed(1)})`;
		}

		/**
		 * 从模型目录快照里解出「目标选择 + 档位列表 + 当前档位下标」。
		 *
		 * 会话还没选过模型时（current 为 null）回落到目录里第一个模型，与官方菜单一致
		 * —— 否则新会话里控件会是死状态。
		 */
		function readEffort(state) {
			const fallback = state !== null && (state.groups?.length ?? 0) > 0 && (state.groups[0].models?.length ?? 0) > 0
				? { provider: state.groups[0].id, model: state.groups[0].models[0].id }
				: null;
			const current = state?.current ?? fallback;
			const group = current === null || current === void 0 ? void 0 : state?.groups?.find((entry) => entry.id === current.provider);
			const model = group?.models?.find((entry) => entry.id === current?.model);
			const tiers = model?.reasoning?.efforts ?? [];
			const currentId = current?.reasoningEffort ?? model?.reasoning?.defaultEffort;
			const index = currentId === void 0 ? -1 : tiers.findIndex((tier) => tier.id === currentId);
			return {
				current: current ?? null,
				modelName: model?.name ?? current?.model ?? "",
				tiers,
				index,
				locked: state === null || current === void 0 || current === null || tiers.length < 2
			};
		}
		//#endregion

		//#region 目录订阅
		/**
		 * 接入当前会话的模型目录。保留最近一次成功数据：官方会在
		 * llm/adapters-updated / settings/document-updated / connection/reset 时刷新目录
		 * （快照短暂变 loading），那不是「现在不能用」，不该让控件闪成加载中。
		 *
		 * @param store - 目录快照 store（subscribe / getSnapshot）。
		 * @param load - 触发一次目录加载（官方座位的 load 面）。
		 */
		function useDirectory(store, load) {
			const snapshot = react.useSyncExternalStore(
				(fn) => (store === null ? () => {} : store.subscribe(fn)),
				() => (store === null ? void 0 : store.getSnapshot())
			);
			react.useEffect(() => {
				if (load !== null) load();
			}, [load]);
			const lastGoodRef = react.useRef(null);
			if (store === null) return { state: null, error: "会话未就绪" };
			const hasData = snapshot !== void 0 && snapshot.current !== null && (snapshot.groups?.length ?? 0) > 0;
			if (snapshot.status === "ready" || snapshot.status === "selecting") {
				if (hasData) lastGoodRef.current = snapshot;
				return { state: snapshot, error: void 0 };
			}
			if (lastGoodRef.current === null) {
				return { state: null, error: snapshot.status === "error" ? snapshot.error ?? "load failed" : void 0 };
			}
			return { state: hasData ? snapshot : lastGoodRef.current, error: void 0 };
		}
		//#endregion


		/** 换档（点击 / 方向键）的补间时长（ms）：给足一点，"挪过去"看得清。 */
		const TWEEN_MS = 540;

		const DRAG_TWEEN_MS = 240;

		const tweenPos = new WeakMap();

		/**
		 * 从 `calc(14px + 0.667 * (100% - 28px))` 这样的样式值里取出缩放系数。
		 * 浏览器可能把它规范成别的等价写法，取不到时返回 NaN（调用方会走布局兜底）。
		 * @param styleValue - 元素的 inline left/width。
		 * @returns 比例 0..1，取不到则 NaN。
		 */
		function percentFromCalc(styleValue) {
			const parts = String(styleValue).split("*");
			for (const part of parts) {
				const numbers = part.match(/[0-9.]+/g);
				if (numbers === null) continue;
				for (const raw of numbers) {
					const value = Number(raw);
					if (value > 0 && value <= 1) return value;
				}
			}
			return Number.NaN;
		}

		/**
		 * 量出一组文字的渲染宽度（用真实字体，挂在 body 上量完即删）。
		 * 用于给"档位名"预留固定宽度 —— 否则各档名长度不同会让控件宽度伸缩，
		 * 把右侧的官方按钮推来推去（用户报的"字体位置在抖"）。
		 *
		 * @param texts - 待测量的文字。
		 * @param className - 量具要带的类名（继承同样的字号/字重）。
		 * @returns 最宽的一条的像素宽度（测量失败返回 0）。
		 */
		function measureTextWidth(texts, font) {
			if (typeof document === "undefined" || texts.length === 0) return 0;
			const probe = document.createElement("span");
			// 用内联样式量，不借用组件类名 —— 否则量具上的样式会被"放大"到真实控件上。
			probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;white-space:nowrap;top:-9999px;left:-9999px;font:${font};`;
			document.body.appendChild(probe);
			let widest = 0;
			try {
				for (const text of texts) {
					probe.textContent = text;
					const width = probe.getBoundingClientRect().width;
					if (width > widest) widest = width;
				}
			} catch (measureError) {
				console.warn("[effort-minimal] measure failed:", measureError);
			} finally {
				probe.remove();
			}
			return widest;
		}

		/**
		 * 圆点（与冲击环、爆炸起点）在轨道容器坐标系里的水平位置。
		 * 统一公式，避免圆点与爆炸起点各算一套（踩过 14px 偏差的坑）。
		 * @param ratio - 档位进度 0..1。
		 */
		function knobLeft(ratio) {
			return `calc(${KNOB_INSET}px + (100% - ${KNOB_INSET * 2}px) * ${ratio})`;
		}

		/** easeInOutCubic：起步与收尾都平缓，中间快 —— 挪动感清楚，且不过冲。 */
		function tweenEase(t) {
			return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
		}
		/**
		 * 位置补间：把圆点与填充从"当前值"平滑推到"目标值"，**直接写 DOM**。
		 *
		 * 为什么不用 CSS transition：位置是由 React 每次渲染写进 style 的，只要 React 因为
		 * 任何原因重建了这两个元素（element 身份变化），CSS 过渡就不会发生 —— 观察到的
		 * 现象就是"点了没动画"，而且极难从代码上看出来。改成 rAF 补间后，动画与 React 的
		 * 渲染方式彻底解耦：元素重建了也会从当前位置继续补间（位置存在 ref 里）。
		 *
		 * 时长刻意给足（540ms + easeInOutCubic），并让填充的宽度与圆点的位置用同一条曲线，
		 * 这样"点与点之间的挪动"是看得见、感受得到的。
		 *
		 * @param knob - 圆点元素（可能为 null：面板处于锁定态时没有滑轨）。
		 * @param fill - 填充元素。
		 * @param target - 目标档位进度（0..1）。
		 * @param animate - false 时直接落位（打开首帧、拖动中）。
		 * @returns 清理函数。
		 */
		/** 换档（点击 / 方向键）的补间时长（ms）：给足一点，"挪过去"看得清。 */
		/**
		 * 拖动时的补间时长（ms）：明显更短 —— 拖动要"跟手"，540ms 会让人觉得黏。
		 * 这是用户实测反馈后的取值（"动画快一点点，有点不跟手"）：先试 300ms 仍觉偏黏，
		 * 收到 240ms；实测"松手到位"约 330~360ms（拖动中指针持续移动、补间不断重启，
		 * 所以比标称值略长）。
		 */
		/**
		 * 补间自己的位置账本：元素 → 当前进度（0..1）。
		 *
		 * 刻意**不用 DOM 属性记账**（曾经用 data-esm-pos）：React 每次渲染都会把它算出的
		 * `left` 写进元素样式，而补间用的是自己的进度；两者一旦不同步，补间就会误判
		 * "已经到了"而停住（实测出现过 left=100% 但进度停在 66.7% 的僵局）。
		 * 用模块内 WeakMap 记账后，补间的位置状态与 React 的渲染彻底无关。
		 */

		/**
		 * 从 `calc(14px + 0.667 * (100% - 28px))` 这样的样式值里取出缩放系数。
		 * 浏览器可能把它规范成别的等价写法，取不到时返回 NaN（调用方会走布局兜底）。
		 * @param styleValue - 元素的 inline left/width。
		 * @returns 比例 0..1，取不到则 NaN。
		 */
		function percentFromCalc(styleValue) {
			const parts = String(styleValue).split("*");
			for (const part of parts) {
				const numbers = part.match(/[0-9.]+/g);
				if (numbers === null) continue;
				for (const raw of numbers) {
					const value = Number(raw);
					if (value > 0 && value <= 1) return value;
				}
			}
			return Number.NaN;
		}

		/**
		 * 量出一组文字的渲染宽度（用真实字体，挂在 body 上量完即删）。
		 * 用于给"档位名"预留固定宽度 —— 否则各档名长度不同会让控件宽度伸缩，
		 * 把右侧的官方按钮推来推去（用户报的"字体位置在抖"）。
		 *
		 * @param texts - 待测量的文字。
		 * @param className - 量具要带的类名（继承同样的字号/字重）。
		 * @returns 最宽的一条的像素宽度（测量失败返回 0）。
		 */


		/**






		/**
		 * 位置补间：把圆点与填充从"当前值"平滑推到"目标值"，**直接写 DOM**。
		 *
		 * 两条设计决定（都是踩坑换来的）：
		 *
		 * 1. **不用 CSS transition**：位置本来由 React 每次渲染写进 style，只要 React 重建了
		 *    这两个元素，CSS 过渡就不发生 —— 现象是"点了没动画"，且极难从代码看出来。改成
		 *    rAF 补间后与 React 的渲染方式解耦（当前位置记在 data-esm-pos 上，元素重建也能接着补）。
		 *
		 * 2. **拖动也用同一条补间**（早先版本拖动是"零过渡直接落位"，用户反馈"拖动没有动画、
		 *    感受不到过渡"）。现在拖动与换档共用 540ms 的缓动：拖动时每次指针移动都会重设目标，
		 *    补间在途中被重置并重新起步，观感就是"圆点顺滑地跟着指针流过去"，而不是硬跟手。
		 *
		 * @param knob - 圆点元素（锁定态下为 null）。
		 * @param fill - 填充元素。
		 * @param target - 目标档位进度（0..1）。
		 * @param animate - false 时直接落位（仅用于打开面板的首帧）。
		 * @param duration - 补间时长（ms）；拖动传更短的值以保跟手。
		 * @returns 清理函数。
		 */
		function tweenPosition(knob, fill, target, animate, duration = TWEEN_MS, ease = tweenEase, lastPosRef = null) {
			const node = knob ?? fill;
			if (node === null) return () => {};
			/**
			 * 当前位置的取法（顺序很重要）：
			 *   1. 账本里有 → 用它（同元素内最准，含补间中间值）；
			 *   2. 账本没有（元素刚被 React 重建）→ 用元素渲染出的**可见位置**兜底；
			 *   3. 连可见位置都没有 → 当作首帧，直接落位。
			 *
			 * 曾经用"组件级最后位置"兜底第 2 步，结果账本(0.667)与元素渲染值(0%)脱节，
			 * 补间判定"已到位"直接跳过，滑块就卡在最左（用户报的 bug）。
			 */
			/**
			 * 基准值取法（顺序固定，别改）：
			 *   1. **元素账本**（补间自己维护，最权威）；
			 *   2. 没有账本、但有组件级账本 → 用它（元素重建/面板实例重建后位置连续）；
			 *   3. 都没有 → 当作首帧，直接落位。
			 *
			 * React **不再给圆点渲染 left**（见渲染处的注释），所以这里不去读样式：
			 * 没有"React 渲染出来的位置"这种东西了，位置只有补间一个写入方。
			 * 只接受 0..1 的合理值，越界视为未知。
			 */
			const clampRatio = (value) => (Number.isFinite(value) && value >= 0 && value <= 1 ? value : Number.NaN);
			let rawCurrent = clampRatio(tweenPos.has(node) ? tweenPos.get(node) : Number.NaN);
			if (!Number.isFinite(rawCurrent) && lastPosRef !== null) rawCurrent = clampRatio(lastPosRef.current);
			const current = rawCurrent;
			/** 直接落位（首帧用）。 */
			const write = (value) => {
				tweenPos.set(node, value);
				if (lastPosRef !== null) lastPosRef.current = value;
				if (knob !== null) knob.style.left = knobLeft(value);
				if (fill !== null) fill.style.width = `${value * 100}%`;
			};
			/** 直接落位（首帧用）。 */
			const place = () => write(target);
			// 首次落位：直接写，不动画（避免开面板时从 0 滑过来）。
			if (!Number.isFinite(current)) {
				place();
				return () => {};
			}
			if (!animate) {
				place();
				return () => {};
			}
			if (current === target) {
				return () => {};
			}
			const start = performance.now();
			const from = current;
			let raf = 0;
			const step = (now) => {
				const t = Math.min(1, (now - start) / duration);
				const value = from + (target - from) * ease(t);
				write(value);
				if (t < 1) raf = window.requestAnimationFrame(step);
				else tweenPos.set(node, target);
			};
			raf = window.requestAnimationFrame(step);
			return () => window.cancelAnimationFrame(raf);
		}

		//#region 粒子与爆炸
		/** 液体粒子的调参。 */
		const PARTICLES = {
			/** 每 100px 轨道宽度放几颗（实际数量按宽度算，最少 8 颗）。 */
			per100px: 5,
			minCount: 8,
			/** 横向漂移速度（px/s，负值向左流）。 */
			driftX: -13,
			/** 纵向浮沉幅度（px）与角速度（rad/s）。 */
			bobAmp: 1.5,
			bobSpeed: 0.9,
			/** 半径范围（px，未乘 dpr）。 */
			minRadius: 1,
			maxRadius: 2.4,
			/** 帧率上限（省电：粒子不需要 60fps，但爆炸期间要跟手，见 burstActive）。 */
			fps: 30
		};

		/** 到最高档时那一下"小爆炸"的调参。 */
		const BURST = {
			/** 粒子数 / 生命期（ms）。刻意克制：这是"到顶了"的提示，不是烟花。 */
			count: 16,
			life: 460,
			/**
			 * 初速范围（px/s）。要能**炸出圆点范围**才有爆炸感：圆点直径 28px，
			 * 所以最快的粒子在 150ms 内应至少飞过 60px。慢于此就只是"冒了个泡"。
			 */
			minSpeed: 90,
			maxSpeed: 260,
			/** 阻尼（每秒保留比例）与重力（px/s²）—— 有这两项才像"炸开"而不是"扩散"。 */
			friction: 0.12,
			gravity: 240,
			/** 半径范围（px）与形状（横向拉伸系数）。 */
			minRadius: 1,
			maxRadius: 2.4,
			flatten: 0.55,
			/** 单次爆炸最多允许同时存在几个（防止快速来回换档堆积）。 */
			maxConcurrent: 2
		};

		/**
		 * 轨道特效层：一个 canvas 同时负责两件事 ——
		 *   1. **液体粒子**：最高档时在填充段内缓慢左漂 + 正弦浮沉（原来在填充层里画，
		 *      但填充层有 overflow:hidden，会裁掉下面爆炸的粒子，所以统一挪到轨道层）；
		 *   2. **到达最高档那一下的小爆炸**：从圆点位置炸开一圈粒子，带阻尼与重力、缩小淡出。
		 *
		 * 只有面板打开才挂载，其余情况一个像素都不画；用 canvas 而不是 DOM/WebGL：
		 * 颗粒少、要按 dpr 保持清晰，一次 clear + N 个 arc 远低于 N 个带动画的 DOM 节点。
		 *
		 * @param props.percent - 当前档位进度（0..1），用于摆放液体粒子与爆炸中心。
		 * @param props.fillPercent - 填充比例（与 percent 相同，保留以便将来区分）。
		 * @param props.spark - 是否最高档（决定是否画液体粒子）。
		 * @param props.burstToken - 每次"到达最高档"递增的令牌；变化即触发一次爆炸。
		 * @param props.hue - 爆炸粒子颜色（跟随本档色相）。
		 * @param props.dpr - 设备像素比（可选，默认从 window 取）。
		 */
		function TrackFx(props) {
			const { percent, spark, burstToken } = props;
			const canvasRef = react.useRef(null);
			const stateRef = react.useRef({ percent, spark, burstToken, hue: "#fff" });
			stateRef.current = { percent, spark, burstToken, hue: props.hue ?? "#fff" };

			react.useEffect(() => {
				const canvas = canvasRef.current;
				if (canvas === null) return void 0;
				const context = canvas.getContext("2d");
				if (context === null) return void 0;
				const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

				let width = 0;
				let height = 0;
				/** 可见轨道带的高度（画布比它高，用于容纳爆炸的垂直飞散）。 */
				let laneHeight = 0;
				let grains = [];
				/** 正在播放/待播放的爆炸。 */
				const bursts = [];
				let lastToken = stateRef.current.burstToken;
				let raf = 0;
				let previous = 0;

				const seedGrains = () => {
					const count = Math.max(PARTICLES.minCount, Math.round((width / 100) * PARTICLES.per100px));
					const lane = laneHeight > 0 ? laneHeight : height;
					grains = Array.from({ length: count }, () => ({
						x: Math.random() * width,
						y: lane * (0.22 + Math.random() * 0.56),
						radius: PARTICLES.minRadius + Math.random() * (PARTICLES.maxRadius - PARTICLES.minRadius),
						phase: Math.random() * Math.PI * 2,
						speed: 0.7 + Math.random() * 0.6,
						alpha: 0.45 + Math.random() * 0.45
					}));
				};
				const resize = () => {
					const rect = canvas.getBoundingClientRect();
					if (rect.width === 0 || rect.height === 0) return;
					const dpr = Math.min(2, window.devicePixelRatio || 1);
					width = rect.width;
					height = rect.height;
					canvas.width = Math.max(1, Math.round(width * dpr));
					canvas.height = Math.max(1, Math.round(height * dpr));
					context.setTransform(dpr, 0, 0, dpr, 0, 0);
					// 轨道带高度：取轨道容器的实际高度（画布本身更高，留出爆炸的空间）。
					const trackBox = canvas.parentElement === null ? null : canvas.parentElement.getBoundingClientRect();
					laneHeight = trackBox !== null && trackBox.height > 0 ? trackBox.height : 24;
					seedGrains();
				};
				resize();
				const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
				observer?.observe(canvas);

				/**
				 * 触发一次爆炸：从**圆点中心**炸开。
				 * 中心横坐标用与 `.esm-knob` 完全相同的算式（轨道容器两端各内缩半个圆点），
				 * 所以爆炸起点与圆点像素级重合。
				 */
				const fireBurst = () => {
					if (bursts.length >= BURST.maxConcurrent) bursts.shift();
					const ratio = Math.max(0, Math.min(1, stateRef.current.percent));
					/**
					 * 起爆点必须与**圆点的实际渲染位置**重合：圆点相对 `.esm-railTrack`
					 * 用 `left: <percent>%` 定位，所以它的中心就是 `width * ratio`；
					 * 只有中间的轨道条才两端内缩。早先按"两端内缩"算成
					 * `INSET + (width - 2 * INSET) * ratio`，到 MAX 时起爆点比圆点偏里
					 * 整整一个 INSET（14px）—— 用户看到的"爆炸不在圆点中心"就是这个。
					 */
					// 画布铺满整条 rail，而圆点的百分比也是相对整条 rail 解析的
					// （`.esm-railTrack` 是 `left:14px; right:14px`，百分比基于 rail 宽度），
					// 所以两者同一坐标系：起爆点就是 width * ratio。
					const centerX = width * ratio;
					const centerY = height / 2;
					const parts = [];
					for (let i = 0; i < BURST.count; i++) {
						// 角度均匀分布 + 抖动：纯随机会结块，均匀分布才有"四周炸开"的观感。
						const angle = (i / BURST.count) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
						// 每颗粒子给不同速度，形成外层快、内层慢的层次。
						const speed = BURST.minSpeed + Math.random() * (BURST.maxSpeed - BURST.minSpeed);
						// 所有粒子都从**同一个点**（圆点中心）起爆 —— 不做初生抖动，
						// 否则第一帧就能看出爆炸中心偏了一点。
						// 纵向把粒子限制在画布内：画布高 52px、轨道带只有 24px，
						// 最快的粒子 26ms 就能飞出画布 —— 那样爆炸只剩一下微闪，
						// 看起来"没有效果"（实测就是这个问题）。
						const margin = BURST.maxRadius + 2;
						const maxVy = Math.max(40, (height / 2 - margin) / (BURST.life / 1000) * 1.6);
						parts.push({
							x: centerX,
							y: centerY,
							vx: Math.cos(angle) * speed,
							vy: Math.max(-maxVy, Math.min(maxVy, Math.sin(angle) * speed)),
							radius: BURST.minRadius + Math.random() * (BURST.maxRadius - BURST.minRadius),
							age: 0
						});
					}
					// 记下起爆点：验证脚本据此核对"爆炸是否以圆点为中心"。
					canvas.dataset.burstOrigin = `${centerX.toFixed(2)},${centerY.toFixed(2)}`;
					bursts.push({ particles: parts, color: stateRef.current.hue ?? "#fff" });
				};

				const draw = (time) => {
					raf = window.requestAnimationFrame(draw);
					const snapshot = stateRef.current;
					// 爆炸令牌变化 = 刚到达最高档 → 炸一次（不循环）。
					if (snapshot.burstToken !== lastToken) {
						lastToken = snapshot.burstToken;
						if (!reduceMotion) fireBurst();
					}
					const hasBurst = bursts.length > 0;
					// 省电：没有爆炸时按 fps 上限跑；爆炸期间不降频，保证那一下够利落。
					const interval = hasBurst ? 0 : 1000 / PARTICLES.fps;
					if (!hasBurst && time - previous < interval) return;
					const dt = Math.min(0.05, (time - (previous || time)) / 1000);
					previous = time;
					context.clearRect(0, 0, width, height);

					// 1) 液体粒子（只在最高档）
					if (snapshot.spark) {
						const drift = reduceMotion ? 0 : 1;
						for (const grain of grains) {
							grain.x += PARTICLES.driftX * grain.speed * dt * drift;
							grain.phase += PARTICLES.bobSpeed * grain.speed * dt * drift;
							if (grain.x < -4) {
								grain.x = width + 4;
								const lane = laneHeight > 0 ? laneHeight : height;
								grain.y = lane * (0.22 + Math.random() * 0.56);
							}
							const y = grain.y + Math.sin(grain.phase) * PARTICLES.bobAmp;
							const twinkle = 0.75 + 0.25 * Math.sin(grain.phase * 1.7);
							context.globalAlpha = grain.alpha * twinkle;
							context.beginPath();
							context.arc(grain.x, y, grain.radius, 0, Math.PI * 2);
							context.fillStyle = "#fff";
							context.fill();
						}
					}

					// 2) 爆炸粒子（阻尼 + 重力 + 缩小淡出）
					if (hasBurst) {
						const decay = Math.pow(BURST.friction, dt);
						for (let b = bursts.length - 1; b >= 0; b--) {
							const burst = bursts[b];
							let alive = 0;
							for (const part of burst.particles) {
								part.age += dt * 1000;
								if (part.age >= BURST.life) continue;
								alive++;
								part.vx *= decay;
								part.vy = part.vy * decay + BURST.gravity * dt;
								part.x += part.vx * dt;
								part.y += part.vy * dt;
								const t = part.age / BURST.life;
								context.globalAlpha = Math.max(0, 1 - t * t);
								context.beginPath();
								context.ellipse(part.x, part.y, Math.max(0.2, part.radius * (1 - t) * BURST.flatten), Math.max(0.2, part.radius * (1 - t)), 0, 0, Math.PI * 2);
								context.fillStyle = burst.color ?? "#fff";
								context.fill();
							}
							if (alive === 0) bursts.splice(b, 1);
						}
					}
					context.globalAlpha = 1;
				};
				if (reduceMotion) draw(0);
				else raf = window.requestAnimationFrame(draw);
				return () => {
					if (raf !== 0) window.cancelAnimationFrame(raf);
					observer?.disconnect();
				};
			}, []);

			return react.createElement("canvas", { className: "esm-canvas", ref: canvasRef, "aria-hidden": "true" });
		}
		//#endregion

		//#region 面板
		/**
		 * 推理档位滑轨面板（Codex 版式：档位名 → 可点的模型名 → 滑轨）。
		 *
		 * @param props.sessionId - 当前会话 id（目录与写回都挂在它上面）。
		 * @param props.directory - 官方模型目录的 store（座位 inject 面）。
		 * @param props.load - 触发目录加载（座位 inject 面）。
		 * @param props.select - 官方选择写入（座位 inject 面）。
		 * @param props.onClose - 关闭回调。
		 */
		function EffortPanel(props) {
			const { directory, load, select, onClose, onView } = props;
			const t = react.useMemo(resolveText, []);
			const { state, error } = useDirectory(directory ?? null, load ?? null);
			const info = readEffort(state ?? null);
			const { tiers, locked, current, modelName } = info;
			const last = tiers.length - 1;

			/** 本地档位：打开瞬间同步到当前档位，避免先渲染 0 档再跳。 */
			const [index, setIndex] = react.useState(-1);
			const [dragging, setDragging] = react.useState(false);
			/** 是否处于"按下"（含尚未升级为拖动的那一瞬），驱动圆点的按压反馈。 */
			const [pressed, setPressed] = react.useState(false);
			const [modelOpen, setModelOpen] = react.useState(false);

			/** 位置补间的状态（全部用 ref，避免多一次渲染）。 */
			const knobRef = react.useRef(null);
			const fillRef = react.useRef(null);
			/**
			 * 圆点实例标记：元素每次被创建时递增。
			 * 用来观测"元素是否被 React 重建"——重建会让补间的位置账本与 DOM 脱节。
			 */
			const knobInstanceRef = react.useRef(0);
			/** 当前圆点引用是由哪个面板实例装的（用于安全的卸载清理）。 */
			const knobOwnerRef = react.useRef(null);
			/** 最新档位 / 档位数（供 ref 落位时读取，避免闭包过期）。 */
			const activeRef = react.useRef(0);
			const lastRef = react.useRef(0);
			/**
			 * 面板实例 id（每个组件实例不同）。
			 *
			 * 模型下拉会让面板**实例重建**，新旧实例会同时挂载/卸载；老实例卸载时的
			 * ref 回调（null）会把新实例刚装上的圆点引用清掉，补间于是写到不存在的元素上 ——
			 * 页面上的圆点没有 left，永远贴在最左（用户报的 bug）。
			 * 用实例 id 认领元素，null 回调只清"自己装的那个"。
			 */
			const panelIdRef = react.useRef(null);
			if (panelIdRef.current === null) panelIdRef.current = `panel-${panelInstanceSeed++}`;
			/**
			 * 最后已知的圆点位置（0..1）。
			 *
			 * 补间的位置账本用 WeakMap 按**元素**存，元素被 React 重建时就会丢（实测：切模型
			 * 时元素重建、补间把那一帧当成"首帧"直接落位到 0%，滑块于是跑到最左）。
			 * 这里在组件级留一份，元素重建后接着从它补间，位置因此连续。
			 */
			const lastPosRef = react.useRef(Number.NaN);
			const setKnobRef = react.useMemo(() => (node) => {
				if (node === null) {
					// 只清"自己装的那个"：并存实例的卸载回调不能动别人的引用。
					if (knobOwnerRef.current === panelIdRef.current) {
						knobRef.current = null;
						knobOwnerRef.current = null;
					}
					return;
				}
				knobRef.current = node;
				knobOwnerRef.current = panelIdRef.current;
				node.dataset.esmInstance = String(++knobInstanceRef.current);
				/**
				 * 元素是新建的：**用组件级账本播种它的账本**。
				 *
				 * 关键：必须以组件级为准，不能反过来用元素自己的值覆盖账本 ——
				 * 模型下拉重渲染时面板实例会被重建，新实例的元素初值是 0%，
				 * 若把它当成"当前位置"写进账本，补间就会判定"已到位"而跳过，
				 * 圆点于是停在最左（用户报的 bug，探针实测到 posRef=0 被播种）。
				 */
				/**
				 * 元素一挂载就立刻落位。
				 *
				 * 必须在这里写、不能只靠 useLayoutEffect：React 可能**在补间写完之后**
				 * 再重建一次圆点，而那时 effect 的依赖（档位/拖动态）没变、不会重跑 ——
				 * 新元素就永远拿不到 left，页面上的圆点贴在最左
				 * （实测：补间轨迹 0.904→0.686 全对，元素随后被换掉，style 变成 null）。
				 */
				const target = lastRef.current > 0 ? activeRef.current / lastRef.current : 0;
				tweenPos.set(node, target);
				lastPosRef.current = target;
				node.style.left = knobLeft(target);
			}, [panelIdRef.current]);
			const isFirstPaintRef = react.useRef(true);
			const pointerPendingRef = react.useRef(false);
			const pointerStartXRef = react.useRef(0);

			/** 目录里可选的全部模型（用于模型下拉）。 */
			const choices = react.useMemo(() => {
				const groups = state?.groups ?? [];
				return groups.flatMap((group) => (group.models ?? []).map((entry) => ({
					provider: group.id,
					id: entry.id,
					name: entry.name ?? entry.id,
					tiers: entry.reasoning?.efforts?.length ?? 0
				})));
			}, [state]);

			/** 打开面板时把本地档位对齐到当前档位。 */
			react.useLayoutEffect(() => {
				if (locked || dragging) return;
				setIndex(info.index < 0 ? 0 : info.index);
			}, [locked, dragging, info.index]);
			const active = locked ? Math.max(info.index, 0) : (index < 0 ? Math.max(info.index, 0) : index);
			// 同步给 ref：圆点挂载时的落位需要最新档位（闭包里的值可能过期）
			activeRef.current = active;
			lastRef.current = last;

			/** 档位进度、最高档标记、本档色相。 */
			const tierT = last > 0 ? active / last : 0;
			const spark = !locked && last > 0 && active === last;
			const hue = tierHue(tierT, spark);

			/**
			 * "到达最高档"那个瞬间的令牌：跨入最高档时 +1，特效层据此炸一次。
			 * 首帧不炸（打开面板时本来就在最高档不该爆炸），所以初始值等于首帧状态。
			 */
			const [burstToken, setBurstToken] = react.useState(0);
			/** 系统"减少动态效果"时不播冲击动画（与 canvas 爆炸保持一致）。 */
			const punch = react.useMemo(
				() => burstToken > 0 && !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches),
				[burstToken]
			);
			const wasSparkRef = react.useRef(spark);
			react.useEffect(() => {
				const was = wasSparkRef.current;
				wasSparkRef.current = spark;
				if (spark && !was) setBurstToken((value) => value + 1);
			}, [spark]);

			/**
			 * 位置补间：档位/拖动变化时把圆点与填充平滑推过去（rAF，不依赖 CSS 过渡）。
			 * 首帧直接落位，避免开面板时从 0 档滑过来。
			 */
			/**
			 * 圆点的位置**只由档位决定**（不跟光标逐像素移动）。
			 *
			 * 拖动时圆点会在跨过档位边界的那一刻移到对应刻度上，拖动补间更短所以跟手；
			 * 但指针在两档之间时圆点就停在刻度上 —— 用户明确不要"实时跟着光标"的效果。
			 * 换档 / 方向键 / 外部改动同样走这条，统一无过冲曲线（刻度上不做花样）。
			 */
			react.useLayoutEffect(() => {
				const animate = !isFirstPaintRef.current;
				const target = last > 0 ? active / last : 0;
				tweenPosition(knobRef.current, fillRef.current, target, animate, dragging ? DRAG_TWEEN_MS : TWEEN_MS, tweenEase, lastPosRef);
			}, [active, last, dragging, locked]);
			react.useEffect(() => {
				isFirstPaintRef.current = false;
			}, []);

			//#region 档位写入
			/**
			 * 写入档位。同一档位去重；写入在途时只保留最新值（在途合并），
			 * 避免拖动时每一帧都打后端。
			 */
			const inflightRef = react.useRef(false);
			const pendingRef = react.useRef(void 0);
			const sentRef = react.useRef(void 0);
			const latest = react.useRef({ locked: true, tiers: [], current: null, select: null });
			latest.current = { locked, tiers, current, select: select ?? null };
			const send = react.useCallback((targetIndex) => {
				const snapshot = latest.current;
				if (snapshot.locked || snapshot.current === null || snapshot.select === null) return;
				const tier = snapshot.tiers[targetIndex];
				if (tier === void 0 || sentRef.current === tier.id) return;
				if (inflightRef.current) {
					pendingRef.current = targetIndex;
					return;
				}
				sentRef.current = tier.id;
				inflightRef.current = true;
				const done = () => {
					inflightRef.current = false;
					const next = pendingRef.current;
					pendingRef.current = void 0;
					if (next !== void 0) send(next);
				};
				Promise.resolve(snapshot.select({
					provider: snapshot.current.provider,
					model: snapshot.current.model,
					reasoningEffort: tier.id
				})).catch((writeError) => {
					// 写入失败：允许稍后重试同一档位。
					sentRef.current = void 0;
					console.warn("[effort-minimal] select failed:", writeError);
				}).then(done, done);
			}, []);
			//#endregion

			/**
			 * 按压态的兜底复位：指针在轨道之外松开时，rail 收不到 pointerup
			 * （setPointerCapture 在个别环境下也可能没生效），圆点就会一直保持
			 * "放大 + 光晕"的按下样子。这里在按下期间挂一个全局 pointerup 兜底。
			 */
			react.useEffect(() => {
				if (!pressed) return void 0;
				const release = () => {
					pointerPendingRef.current = false;
					setDragging(false);
					setPressed(false);
				};
				document.addEventListener("pointerup", release, true);
				document.addEventListener("pointercancel", release, true);
				return () => {
					document.removeEventListener("pointerup", release, true);
					document.removeEventListener("pointercancel", release, true);
				};
			}, [pressed]);

			//#region 指针与键盘
			const trackRef = react.useRef(null);
			/**
			 * 触发一次渲染（档位或拖动状态变化）。补间本身用 rAF 直接写 DOM，不需要每帧渲染。
			 */
			const bump = (nextIndex, nextDragging) => {
				setIndex(nextIndex);
				setDragging(nextDragging);
			};
			/** 把指针位置换算成 0..1 的连续进度（以已内缩的轨道容器为基准）。 */
			const ratioFromEvent = (event) => {
				const track = trackRef.current;
				if (track === null) return 0;
				const box = track.getBoundingClientRect();
				const usable = Math.max(1, box.width);
				return Math.min(1, Math.max(0, (event.clientX - box.left) / usable));
			};
			/** 连续进度 → 最近的档位序号。 */
			const indexFromRatio = (ratio) => Math.round(ratio * Math.max(tiers.length - 1, 0));
			/**
			 * 按下 → 待定态（保留补间，圆点会滑到目标档）；指针**移动超过阈值**才升级为
			 * 拖动态。阈值必须有：触控板/鼠标按下后几乎总会先发 1~2px 的 pointermove，
			 * 早期版本据此就判定为拖动，导致点击跳档永远被当成拖动。
			 */
			const DRAG_THRESHOLD = 4;
			const onPointerDown = (event) => {
				if (locked) return;
				event.preventDefault();
				event.stopPropagation();
				const ratio = ratioFromEvent(event);
				const next = indexFromRatio(ratio);
				pointerPendingRef.current = true;
				pointerStartXRef.current = event.clientX;
				setPressed(true);
				bump(next, false);
				send(next);
				event.currentTarget.setPointerCapture?.(event.pointerId);
			};
			const onPointerMove = (event) => {
				if (locked) return;
				if (!pointerPendingRef.current && !dragging) return;
				const moved = Math.abs(event.clientX - pointerStartXRef.current) >= DRAG_THRESHOLD;
				if (!dragging && !moved) return;
				event.preventDefault();
				if (!dragging) {
					pointerPendingRef.current = false;
					setDragging(true);
				}
				const next = indexFromRatio(ratioFromEvent(event));
				setIndex(next);
				send(next);
			};
			const endDrag = (event) => {
				if (event !== void 0) event.stopPropagation();
				pointerPendingRef.current = false;
				setDragging(false);
				setPressed(false);
			};
			const onKeyDown = (event) => {
				if (locked) return;
				const move = (next) => {
					event.preventDefault();
					const clamped = Math.min(last, Math.max(0, next));
					setIndex(clamped);
					send(clamped);
				};
				if (event.key === "ArrowRight" || event.key === "ArrowUp") move(active + 1);
				else if (event.key === "ArrowLeft" || event.key === "ArrowDown") move(active - 1);
				else if (event.key === "Home") move(0);
				else if (event.key === "End") move(last);
				else if (event.key === "Escape") {
					event.preventDefault();
					onClose();
				}
			};
			//#endregion

			//#region 模型切换
			/**
			 * 切模型：走官方 `select({provider, model})`，刻意**不带 reasoningEffort**
			 * —— 让官方按该模型的 defaultEffort 处理，档位仍由上面的滑轨单独负责。
			 */
			const selectModel = (provider, id) => {
				setModelOpen(false);
				if (current !== null && current.provider === provider && current.model === id) return;
				try {
					Promise.resolve(select({ provider, model: id })).catch((modelError) => {
						console.warn("[effort-minimal] select model failed:", modelError);
					});
				} catch (modelError) {
					console.warn("[effort-minimal] select model threw:", modelError);
				}
			};
			//#endregion

			//#region 渲染
			const percent = last > 0 ? active / last : 0;
			const activeLabel = tiers[active]?.name ?? "—";
			const hueTo = hueCss(tierHue(1, spark));
			const hueFrom = hueCss(tierHue(tierT * 0.62, spark));

			/** 面板宽度随视图变化：滑块页窄、模型选择页宽（"整块变成选择页"）。 */
			react.useLayoutEffect(() => {
				onView?.(modelOpen ? "model" : "slider");
			}, [modelOpen, onView]);

			const children = [];

			if (modelOpen) {
				// —— 模型选择页（对齐 Codex：整块面板变成选择列表）——
				const kids = [
					react.createElement("div", { className: "esm-viewHead", key: "head" }, [
						react.createElement("button", {
							type: "button",
							className: "esm-back",
							key: "back",
							"aria-label": "返回",
							onClick: (event) => {
								event.stopPropagation();
								setModelOpen(false);
							}
						}, "\u2039"),
						react.createElement("span", { className: "esm-viewTitle", key: "t" }, "选择模型")
					]),
				];
				const rows = [];
				for (const group of state?.groups ?? []) {
					rows.push(react.createElement("div", { className: "esm-groupLabel", key: `g-${group.id}` }, group.id));
					for (const entry of group.models ?? []) {
						const isCurrent = current !== null && current.provider === group.id && current.model === entry.id;
						rows.push(react.createElement("button", {
							type: "button",
							className: "esm-option",
							key: `m-${group.id}-${entry.id}`,
							role: "option",
							"aria-selected": isCurrent ? "true" : "false",
							onClick: (event) => {
								event.stopPropagation();
								selectModel(group.id, entry.id);
							}
						}, [
							react.createElement("span", { className: "esm-optionMark", key: "k", "aria-hidden": "true" }, isCurrent ? "\u2713" : ""),
							react.createElement("span", { className: "esm-optionName", key: "n" }, entry.name ?? entry.id),
						]));
					}
				}
				kids.push(react.createElement("div", { className: "esm-modelList", key: "list", role: "listbox" }, rows));
				children.push(...kids);
			} else {
				// —— 滑块页 ——
				children.push(react.createElement("div", { className: "esm-title", key: "title" }, locked ? "—" : activeLabel));
				children.push(react.createElement("div", { className: "esm-modelRow", key: "model" }, react.createElement("button", {
					type: "button",
					className: "esm-model",
					disabled: choices.length < 2,
					"aria-haspopup": "listbox",
					"aria-expanded": "false",
					title: choices.length < 2 ? modelName : `${modelName} · 点击选择模型`,
					onClick: (event) => {
						event.stopPropagation();
						setModelOpen(true);
					}
				}, [
					react.createElement("span", { className: "esm-modelName", key: "n" }, modelName),
					choices.length >= 2
						? react.createElement("span", { className: "esm-modelChevron", key: "c", "aria-hidden": "true" }, "\u25be")
						: null
				])));

				if (error !== void 0) {
					children.push(react.createElement("div", { className: "esm-msg esm-error", key: "err" }, t.failed(error)));
				} else if (locked) {
					children.push(react.createElement("div", { className: "esm-msg", key: "msg" }, state === null ? t.loading : t.noTiers));
				} else {
					children.push(react.createElement("div", {
						className: "esm-rail",
						key: "rail",
						role: "slider",
						tabIndex: 0,
						"aria-label": t.seatTitle(modelName, activeLabel),
						"aria-valuemin": 0,
						"aria-valuemax": last,
						"aria-valuenow": active,
						"aria-valuetext": activeLabel,
						title: t.dragHint,
						onPointerDown,
						onPointerMove,
						onPointerUp: endDrag,
						onPointerCancel: endDrag,
						onKeyDown
					}, [react.createElement("div", { className: "esm-railTrack", key: "rail-track", ref: trackRef }, [
						react.createElement("div", { className: "esm-track", key: "track" }),
						react.createElement("div", {
							className: "esm-fill",
							key: "fill",
							ref: fillRef,
							style: { width: `${percent * 100}%`, background: `linear-gradient(90deg, ${hueFrom}, ${hueTo})` }
						}),
						// 特效层在轨道层：液体粒子 + 到最高档那一下的小爆炸。放在这里是因为
						// .esm-fill 有 overflow:hidden，会把炸开的粒子裁掉。
						react.createElement(TrackFx, {
							key: "fx",
							percent: percent,
							spark: spark,
							burstToken: burstToken
						}),
						// 档位点从轨道容器两端各内缩一个弧半径 —— 0% / 100% 落在胶囊弧心。
						...tiers.map((tier, i) => react.createElement("div", {
							className: "esm-dot",
							key: `dot-${tier.id}`,
							"data-active": i === active ? "true" : "false",
							style: {
								left: `calc(${ARC}px + (100% - ${ARC * 2}px) * ${last > 0 ? i / last : 0})`,
								opacity: (i === active ? 0.9 : 0.42 + 0.22 * tierT) * (spark ? 0 : 1)
							}
						})),
						// 冲击环：用 burstToken 当 key，令牌一变就重新挂载 → 动画从头播。
						// 它是**一次性**元素，重建没有副作用。
						//
						// 圆点则**不能**换 key：换 key 会让 React 重建元素，从而丢掉 ref/样式连接
						// （实测会把正在被 rAF 补间写入的元素换成脱离 DOM 的新元素，动画看起来"没了"）。
						// 圆点的冲击只改 data-punch 属性 —— CSS animation 属性变化本身就会重播动画。
						react.createElement("div", {
							className: "esm-knob",
							key: "knob",
							ref: setKnobRef,
							"data-punch": punch ? "true" : "false",
							// 冲击环作为圆点的**子元素**：同心由结构保证（见 .esm-ring 注释）。
							// 它是一次性元素，用 burstToken 当 key 让动画每次重新播。
							// 圆点则**不能**换 key（换 key 会重建元素、切断补间的写入目标）。
							// 位置**不由 React 写**：left 完全交给 rAF 补间（tweenPosition）。
							// 两方都写同一个属性会互相覆盖 —— React 用它的虚拟值盖掉补间的中间值，
							// 补间再以为"已到位"而停住（实测踩到过僵局）。
							// 首帧的可见位置由补间的 place() 立即写入，不会闪。
						}, punch
							? [react.createElement("span", {
								className: "esm-ring",
								key: `ring-${burstToken}`,
								"aria-hidden": "true"
							})]
							: null)
					])]));
				}
			}

			return react.createElement("div", {
				className: "esm-panel",
				"data-effort-panel": "true",
				"data-dragging": dragging ? "true" : "false",
				"data-pressed": dragging || pressed ? "true" : "false",
				"data-spark": spark ? "true" : "false",
				"data-view": modelOpen ? "model" : "slider",
				style: {
					"--esm-hue": hueCss(hue),
					"--esm-spark": spark ? "1" : "0",
					"--esm-t": String(tierT)
				},
				onPointerDown: (event) => event.stopPropagation(),
				onClick: (event) => event.stopPropagation()
			}, children);
		}
		//#endregion

		//#endregion

		//#region 常驻控件
		/**
		 * 输入框里的常驻推理档位控件（注册进官方 list 座位 conversation.input.right）。
		 * 点档位名弹出滑轨面板；面板贴在控件上方/下方，滚动或缩放时重新定位。
		 */
		function EffortSeat(props) {
			const { sessionId, directory, load, select } = props;
			const t = react.useMemo(resolveText, []);
			const { state } = useDirectory(directory ?? null, load ?? null);
			const info = readEffort(state ?? null);
			const [open, setOpen] = react.useState(false);
			const triggerRef = react.useRef(null);
			const hostRef = react.useRef(null);
			/**
			 * 当前视图：slider（滑块）或 model（模型选择页）。
			 * 模型选择页会更宽并居中到控件上方 —— 也就是"整块面板变成选择页"，选完回到滑块。
			 */
			const viewRef = react.useRef("slider");
			const [view, setView] = react.useState("slider");

			// 浮层挂到 body：不参与输入框布局，避免撑坏 composer。
			react.useEffect(() => {
				if (!open) return void 0;
				const host = document.createElement("div");
				host.dataset.effortHost = "";
				/**
				 * 固定宽度与下缘；`height` 参与过渡 —— 视图切换时框"变长"而不是跳变。
				 * 高度不能只靠内容撑（那样过渡不会被触发），所以下面用 ResizeObserver
				 * 把内容高度显式同步到 host.height；overflow:hidden 负责在动画期间裁剪内容。
				 */
				host.style.cssText = `position:fixed;z-index:1200;width:${PANEL_W}px;pointer-events:auto;overflow:hidden;transition:height .3s cubic-bezier(.22,1,.36,1);`;
				document.body.appendChild(host);
				hostRef.current = host;
				/**
				 * 位置：**宽度与水平位置恒定，只让高度变**（对齐 Codex 那种"框只变长"）。
				 *
				 * 浮层用 `bottom` 锚定在控件上方：宽度固定 300px、左缘恒定，高度变化时
				 * 向**上**生长，下缘始终贴着控件 —— 视觉上就是"框变长了"，而不是整体位移。
				 * 高度本身由内容决定（模型列表比滑块页高），配合 host 上的 height transition
				 * 就有了展开/收起的过渡动画。
				 */
				const place = () => {
					const anchor = triggerRef.current;
					if (anchor === null) return;
					const rect = anchor.getBoundingClientRect();
					const left = Math.max(8, Math.min(rect.right - PANEL_W, window.innerWidth - PANEL_W - 8));
					const bottom = Math.max(8, window.innerHeight - rect.top + 6);
					host.style.left = `${left}px`;
					host.style.bottom = `${bottom}px`;
					host.style.top = "auto";
				};
				// 内容包装：把面板装进一层 div，便于在不打断内容的前提下量高度。
				const content = document.createElement("div");
				host.appendChild(content);
				const root = react_dom_client.createRoot(content);
				/** 把内容高度同步给 host（host 的高度过渡才有可插值的两端）。 */
				const syncHeight = () => {
					const next = content.scrollHeight;
					if (next > 0 && host.style.height !== `${next}px`) host.style.height = `${next}px`;
				};
				const heightObserver = typeof ResizeObserver === "function" ? new ResizeObserver(syncHeight) : null;
				heightObserver?.observe(content);
				root.render(react.createElement(EffortPanel, {
					sessionId,
					directory,
					load,
					select,
					onClose: () => setOpen(false),
					// 视图切换只需要重算位置（宽度不变，高度交给 CSS 过渡）。
					onView: (next) => {
						if (viewRef.current === next) return;
						viewRef.current = next;
						setView(next);
						place();
					}
				}));
				place();
				// 面板高度要等首帧渲染后才能量准：先同步一次高度，再排一次定位/测量。
				const raf = window.requestAnimationFrame(() => {
					syncHeight();
					place();
				});
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return () => {
					window.cancelAnimationFrame(raf);
					heightObserver?.disconnect();
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
					root.unmount();
					host.remove();
					hostRef.current = null;
				};
			}, [open, sessionId, directory, load, select]);

			// 点面板外 / Esc 关闭。捕获阶段处理。
			react.useEffect(() => {
				if (!open) return void 0;
				const onDocPointer = (event) => {
					const host = hostRef.current;
					if (host !== null && host.contains(event.target)) return;
					if (triggerRef.current !== null && triggerRef.current.contains(event.target)) return;
					setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onDocPointer, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("pointerdown", onDocPointer, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [open]);

			const disabled = info.locked;
			const label = disabled ? "—" : (info.tiers[Math.max(info.index, 0)]?.name ?? "—");
			/**
			 * 档位名的预留宽度：取所有档名里最宽的一条（外加一点点余量）。
			 * 这样换档时控件宽度恒定，右侧的官方按钮不会被推动。
			 */
			const levelWidth = react.useMemo(() => {
				const names = info.tiers.map((tier) => tier.name).filter((name) => typeof name === "string");
				if (names.length === 0) return 0;
				// 字体与 .esm-trigger 一致（13px / 常规字重，继承界面字体）
				return Math.ceil(measureTextWidth([...names, "—"], "13px/normal inherit")) + 1;
			}, [info.tiers]);
			return react.createElement("button", {
				type: "button",
				className: "esm-trigger",
				ref: triggerRef,
				disabled,
				"data-open": open ? "true" : "false",
				"data-view": view,
				"aria-haspopup": "true",
				"aria-expanded": open ? "true" : "false",
				title: disabled ? t.noTiers : t.seatTitle(info.modelName, label),
				style: levelWidth > 0 ? { "--esm-level-w": `${levelWidth}px` } : void 0,
				onClick: () => setOpen((value) => !value)
			}, [
				// 收起时只显示档位名（High / Max / Low…），把"推理等级"这个标签藏起来 ——
				// 控件在输入框里越短越好；展开（面板打开）后才把标签显示出来，说明它是什么。
				open
					? react.createElement("span", { className: "esm-triggerName", key: "n" }, t.effort)
					: null,
				react.createElement("span", { className: "esm-triggerLevel", key: "l" }, label)
			]);
		}
		//#endregion

		//#region apply
		/** 需要注入的官方服务：插槽注册表 + 模型目录 + 会话列表。 */
		const inject = ["slots", "modelDirectories", "sessions"];

		/** 常驻控件在 list 座位里的排序（官方模型座位在它右边）。 */
		const SEAT_ORDER = 10;

		/**
		 * 注册常驻控件与全局样式。
		 * @param ctx - 宿主上下文（effect 生命周期负责回收）。
		 */
		function apply(ctx) {
			const style = document.createElement("style");
			// 注意：不要与 React 根节点的 data 属性同名（HTML 属性名不区分大小写）。
			style.dataset.effortMinimalStyle = "";
			style.textContent = css;
			document.head.appendChild(style);

			// 座位注册是可选的：slots 服务缺席时（精简 profile / 老版本）插件仍能加载，
			// 只是没有常驻控件 —— 而不是把整个 profile 拖下水。
			const slots = ctx.get("slots");
			if (slots === void 0) {
				console.warn("[effort-minimal] slots service unavailable: composer seat not registered");
			} else {
				ctx.effect(() => slots.inject("conversation.input.right", () => slots.register({
					name: "conversation.input.right",
					id: "effort-minimal",
					order: SEAT_ORDER,
					inject: (sessionId) => {
						const modelDirectories = ctx.get("modelDirectories");
						if (modelDirectories === void 0) throw new Error("effort-minimal: modelDirectories unavailable");
						const directory = modelDirectories.directoryFor(sessionId);
						return {
							sessionId,
							directory: directory.store,
							load: () => {
								directory.load().catch(() => {});
							},
							select: (selection) => directory.select(selection)
						};
					}
				}, EffortSeat)), "dsh-effort-minimal: composer seat");
			}

			ctx.effect(() => () => {
				style.remove();
			}, "dsh-effort-minimal: style");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** 测试钩子：补间曲线与时长（纯函数，便于独立验证动画数学）。 */
		exports.__test = {
			tweenEase,
			TWEEN_MS,
			DRAG_TWEEN_MS
		};
		exports.EffortPanel = EffortPanel;
		exports.EffortSeat = EffortSeat;
		exports.currentSessionId = currentSessionId;
		return module.exports;
	}
});
