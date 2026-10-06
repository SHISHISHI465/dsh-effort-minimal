/**
 * dsh-effort-minimal 宿主半边。
 *
 * 面板渲染全部在浏览器端 bundle（lib/client.js）里完成：读数与写数都走官方
 * `modelDirectories` 服务，配色走官方主题变量，所以宿主半边不需要任何逻辑，
 * 只保留一个空 apply，让 cordis.patch.yml 的 insert 行（id: ui-effort-minimal）
 * 能正常注册。
 */

/** 稳定插件名（与 cordis.patch.yml 的 insert id 对应）。 */
export const name = "ui-effort-minimal";

export function apply(_ctx) {
	// 无宿主逻辑：客户端 bundle 独立完成面板渲染与档位读写。
}
