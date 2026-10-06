/**
 * 预检：在重启 DSH 之前，按官方 `@deepseek-ai/dsh-client-modules` 的规则校验插件。
 *
 * 校验项（对齐官方 0.2.x 的 parseDshClient / clientExportOf / resolveMeta 行为）：
 *   1. 声明了 `dsh.client` 时，`exports["./client"]` 必须存在且指向真实文件
 *      —— 缺了这一条会让 **required 插件 `modules` 激活失败、整个应用起不来**；
 *   2. `exports["."]`/`main` 指向的宿主半边必须存在；
 *   3. `dsh.client.platform` 必须是 "web"，`dsh.client.inject` 必须是字符串数组；
 *   4. 宿主半边可被 Node 成功 import，且导出面能形成合法的 cordis 插件
 *      （具名 `apply` / 具名 `name`，或默认导出的对象上带 `apply`）；
 *   5. 客户端 bundle 必须是 `window.__ModuleLoader__.load({id, factory})` 形式，id 与包名一致；
 *   6. 同 profile 内是否存在同样占用输入框推理档位座位的插件（会叠出两个控件）。
 *
 * 用法：
 *   node scripts/preflight.mjs [插件目录，默认本仓库]
 *   node scripts/preflight.mjs --profile ~/.dsh/profiles/desktop   # 校验整个 profile 的 bundles
 * 退出码非 0 表示不要重启，先修。
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

/** 解析命令行参数。 */
function parseArgs() {
	const out = { profile: null, target: here };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile") out.profile = resolve(argv[++i] ?? "");
		else out.target = resolve(argv[i]);
	}
	return out;
}
const args = parseArgs();

/** 对单个插件目录跑全部检查，返回失败信息数组。 */
async function checkPlugin(dir) {
	const failures = [];
	const notes = [];
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) return { failures: [`${dir} 下没有 package.json`], notes };
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch (error) {
		return { failures: [`${dir}/package.json 不是合法 JSON：${error.message}`], notes };
	}
	notes.push(`${pkg.name}@${pkg.version}`);

	// 1 + 2：exports 解析
	if (typeof pkg.exports === "object" && pkg.exports !== null) {
		const clientExport = pkg.exports["./client"];
		if (clientExport === void 0) {
			// 只有在声明了 dsh.client 时才致命（官方就是这个条件）。
			if (pkg.dsh?.client !== void 0) {
				failures.push(`${pkg.name}: 声明了 dsh.client 但 exports 缺少 "./client" → required 插件 modules 激活失败`);
			}
		} else {
			const rel = typeof clientExport === "string" ? clientExport : clientExport?.default;
			if (typeof rel !== "string") failures.push(`${pkg.name}: exports["./client"] 必须是字符串或带字符串 default 的对象`);
			else if (!existsSync(resolve(dir, rel))) failures.push(`${pkg.name}: exports["./client"] 指向的文件不存在：${rel}`);
			else notes.push(`客户端 bundle → ${rel}`);
		}
	} else if (pkg.dsh?.client !== void 0) {
		failures.push(`${pkg.name}: 声明了 dsh.client 但没有 exports`);
	}

	const rootRel = typeof pkg.exports?.["."] === "string" ? pkg.exports["."] : (pkg.exports?.["."]?.default ?? pkg.main);
	if (typeof rootRel !== "string") failures.push(`${pkg.name}: 找不到宿主半边入口（exports["."] 与 main 都缺失）`);
	else if (!existsSync(resolve(dir, rootRel))) failures.push(`${pkg.name}: 宿主半边入口不存在：${rootRel}`);
	else notes.push(`宿主半边 → ${rootRel}`);

	// 3：dsh.client 声明形状
	const client = pkg.dsh?.client;
	if (client !== void 0) {
		if (client.platform !== "web") failures.push(`${pkg.name}: dsh.client.platform 必须是 "web"（当前 ${String(client.platform)}）`);
		if (client.inject !== void 0 && (!Array.isArray(client.inject) || client.inject.some((id) => typeof id !== "string"))) {
			failures.push(`${pkg.name}: dsh.client.inject 必须是字符串数组`);
		}
	}

	// 4：宿主半边可 import 且能形成合法插件面
	try {
		const mod = await import(pathToFileURL(resolve(dir, rootRel)).href);
		const namedApply = typeof mod.apply === "function";
		const defaultApply = typeof mod.default?.apply === "function";
		if (!namedApply && !defaultApply) failures.push(`${pkg.name}: 宿主半边没有导出 apply()（具名或默认对象上都没有）`);
		else notes.push(`宿主半边 import 成功：${namedApply ? "具名 apply" : "默认导出 apply"}`);
	} catch (error) {
		failures.push(`${pkg.name}: 宿主半边 import 失败：${error instanceof Error ? error.message : String(error)}`);
	}

	// 5：客户端 bundle 形式
	const clientEntry = pkg.exports?.["./client"];
	const clientRel = typeof clientEntry === "string" ? clientEntry : clientEntry?.default;
	if (typeof clientRel === "string" && existsSync(resolve(dir, clientRel))) {
		const source = readFileSync(resolve(dir, clientRel), "utf8");
		if (!/__ModuleLoader__\.load\(/.test(source)) failures.push(`${pkg.name}: 客户端 bundle 不是 window.__ModuleLoader__.load({...}) 形式`);
		else {
			const idMatch = source.match(/__ModuleLoader__\.load\(\s*\{[\s\S]*?\bid:\s*"([^"]+)"/);
			if (idMatch === null) failures.push(`${pkg.name}: 客户端 bundle 的 load() 里读不到 id`);
			else if (idMatch[1] !== pkg.name) failures.push(`${pkg.name}: 客户端 bundle id "${idMatch[1]}" 与包名不一致`);
			else notes.push(`客户端 bundle id = ${idMatch[1]}`);
		}
	}
	return { failures, notes };
}

/** 校验整个 profile：每个 bundle 行都要能通过，且客户端插件之间不冲突。 */
async function checkProfile(profileDir) {
	const failures = [];
	const notes = [];
	const pkgPath = join(profileDir, "package.json");
	if (!existsSync(pkgPath)) return { failures: [`${profileDir} 下没有 package.json`], notes };
	const profile = JSON.parse(readFileSync(pkgPath, "utf8"));
	const bundles = profile.dsh?.profile?.bundles ?? [];
	notes.push(`profile bundles：${bundles.join(", ")}`);
	/** 会拦截「推理等级」菜单行的客户端插件（同时装两个会叠面板）。 */
	const effortInterceptors = [];
	for (const name of bundles) {
		if (name.startsWith("@deepseek-ai/")) continue; // 官方 bundle 不在此校验
		const dir = join(profileDir, "node_modules", name);
		if (!existsSync(dir)) {
			failures.push(`bundle "${name}" 已声明但 node_modules 里不存在（依赖没装上）`);
			continue;
		}
		const result = await checkPlugin(dir);
		notes.push(...result.notes.map((line) => `  [${name}] ${line}`));
		failures.push(...result.failures);
		const clientRel = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).exports?.["./client"];
		const rel = typeof clientRel === "string" ? clientRel : clientRel?.default;
		if (typeof rel === "string" && existsSync(join(dir, rel))) {
			const source = readFileSync(join(dir, rel), "utf8");
			// 会占用输入框里推理档位座位的客户端插件：同时装多个会叠出两个控件。
			if (source.includes("conversation.input.right") || source.includes("推理等级")) effortInterceptors.push(name);
		}
	}
	if (effortInterceptors.length > 1) {
		failures.push(`同时装了多个会占用推理档位座位的插件：${effortInterceptors.join(", ")} —— 会叠出两个控件，删掉多余的`);
	} else if (effortInterceptors.length === 1) {
		notes.push(`占用推理档位座位的插件：${effortInterceptors[0]}`);
	}

	// profile 里残留的插件目录（不在 bundles 里）提示一下，避免误以为还在生效。
	const modulesDir = join(profileDir, "node_modules");
	if (existsSync(modulesDir)) {
		for (const entry of readdirSync(modulesDir)) {
			if (entry.startsWith(".") || entry.startsWith("@") || entry.startsWith("dsh-profile")) continue;
			if (!bundles.includes(entry)) notes.push(`提示：node_modules 里有 ${entry}，但不在 bundles 中（未加载）`);
		}
	}
	return { failures, notes };
}

const result = args.profile !== null ? await checkProfile(args.profile) : await checkPlugin(args.target);
for (const line of result.notes) console.log(`  ok    ${line}`);
if (result.failures.length > 0) {
	console.error("");
	for (const line of result.failures) console.error(`  FAIL  ${line}`);
	console.error(`\n预检未通过（${result.failures.length} 项）——不要重启 DSH。`);
	process.exit(1);
}
console.log("\n预检通过：可以重启 DSH。");
