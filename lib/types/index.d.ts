/**
 * dsh-effort-minimal 宿主半边类型声明。
 *
 * 宿主半边只提供一个空的 apply：面板渲染全部在浏览器端 bundle
 * （`dsh-effort-minimal/client`）里完成。
 */

/** 稳定插件名（与 cordis.patch.yml 的 insert id 对应）。 */
export declare const name: "ui-effort-minimal";

/** 空实现：本插件不需要任何宿主逻辑。 */
export declare function apply(ctx: unknown): void;
