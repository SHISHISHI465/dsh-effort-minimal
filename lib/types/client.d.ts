/**
 * dsh-effort-minimal 浏览器端 bundle 类型声明。
 *
 * 真正的产物是 `lib/client.js`——一个 `window.__ModuleLoader__.load({id, factory})`
 * 形式的客户端 bundle，其导出面为 `{ apply, inject, currentSessionId }`，
 * 由官方 `@deepseek-ai/dsh-client-modules` 载入。
 */

/** 注入的官方服务名。 */
export declare const inject: readonly string[];

/** 挂载菜单行拦截与极简推理等级面板。 */
export declare function apply(ctx: unknown): void;

/** 解析当前主视图会话 id（导出以便测试）。 */
export declare function currentSessionId(sessions: unknown): string | undefined;
