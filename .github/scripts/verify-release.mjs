#!/usr/bin/env node
/**
 * 发布前门禁（release gate）。
 *
 * 设计原则：发布这一步不可撤销，所以把「能不能发」全部前置成可检查的不变量。
 * 本脚本不读取任何 npm token、不发布任何东西，只做校验 + 打包取证：
 *   1. tag 必须严格等于 package.json 里的版本（且是合法 semver）
 *   2. package.json 里不允许存在任何会在发布/安装时执行的 npm 生命周期脚本
 *   3. publishConfig 必须指向官方 registry、public、强制 provenance
 *   4. 依赖里不允许出现 file:/link:/git/http/workspace 这类非 registry 协议
 *   5. 仓库里不允许出现 .npmrc（防止将来有人悄悄改 registry 或塞 token）
 *   6. `npm pack` 出的文件清单必须在白名单内，且 exports 里每个入口都真实存在
 *   7. CI 环境下必须「零 token」：不允许存在 NPM_TOKEN / NODE_AUTH_TOKEN，
 *      同时必须存在 OIDC 环境变量（证明 id-token: write 真的生效）
 *
 * 成功时会把 tarball 的 SRI 写进 evidence 文件，供发布后的 verify-published.mjs
 * 比对 registry 上的产物，确保「发出去的东西 == 这里打包的东西」。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runNpm } from './lib/npm.mjs';

const root = resolve(process.env.RELEASE_ROOT ?? process.cwd());
const problems = [];
const passed = [];
const fail = (msg) => problems.push(msg);
const pass = (msg) => passed.push(msg);

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pkgName = pkg.name;
const pkgVersion = pkg.version;

/* 1) tag 必须严格等于 package.json 版本 ------------------------------------ */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME ?? '';
if (process.env.GITHUB_REF_TYPE && process.env.GITHUB_REF_TYPE !== 'tag') {
    fail(`GITHUB_REF_TYPE=${process.env.GITHUB_REF_TYPE}：发布只允许由 tag 触发`);
}
if (!/^v/.test(tag)) {
    fail(`tag "${tag}" 必须以 "v" 开头（例如 v${pkgVersion}）`);
} else if (!SEMVER.test(tag.slice(1))) {
    fail(`tag "${tag}" 去掉前缀后不是合法 semver`);
} else if (tag.slice(1) !== pkgVersion) {
    fail(`tag "${tag}" 与 package.json 版本 "${pkgVersion}" 不一致（拒绝发布）`);
} else {
    pass(`tag ${tag} 与 package.json 版本一致`);
}

/* 2) 禁止生命周期脚本 ------------------------------------------------------ */
// 这些脚本会在 npm publish / npm install 时执行代码，而 publish 期间 runner 上
// 存在可换取 npm 发布权限的 OIDC token，等于把发布权限交给脚本。
const FORBIDDEN_SCRIPTS = [
    'preinstall',
    'install',
    'postinstall',
    'prepare',
    'prepublish',
    'prepublishOnly',
    'prepack',
    'postpack',
    'dependencies',
];
const scripts = pkg.scripts ?? {};
const presentForbidden = FORBIDDEN_SCRIPTS.filter((name) => name in scripts);
if (presentForbidden.length > 0) {
    fail(`package.json 存在会在发布/安装时执行的生命周期脚本：${presentForbidden.join(', ')}`);
} else {
    pass(`无生命周期脚本（现有脚本：${Object.keys(scripts).join(', ') || '无'}）`);
}

/* 3) publishConfig --------------------------------------------------------- */
const publishConfig = pkg.publishConfig ?? {};
if (publishConfig.registry !== 'https://registry.npmjs.org/') {
    fail('publishConfig.registry 必须显式为 https://registry.npmjs.org/');
}
if (publishConfig.access !== 'public') {
    fail('publishConfig.access 必须为 "public"');
}
if (publishConfig.provenance !== true) {
    fail('publishConfig.provenance 必须为 true（强制生成 provenance 证明）');
}
if (publishConfig.tag !== undefined) {
    fail('不允许固定 publishConfig.tag：dist-tag 必须由版本号语义决定');
}
if (pkg.private === true) {
    fail('package.json 标记了 "private": true，不能发布');
}
if (publishConfig.registry === 'https://registry.npmjs.org/' && publishConfig.provenance === true) {
    pass('publishConfig 指向官方 registry 且强制 provenance');
}

/* 4) 依赖必须是 registry 协议 --------------------------------------------- */
const DEP_FIELDS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
    'bundledDependencies',
];
const NON_REGISTRY = /^(file:|link:|portal:|workspace:|git\+|git:|https?:|github:|[^/]+\/[^/]+#)/;
for (const field of DEP_FIELDS) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (typeof range === 'string' && NON_REGISTRY.test(range)) {
            fail(`${field}.${name} = "${range}" 不是 registry 版本范围（存在供应链风险）`);
        }
    }
}
pass('依赖声明均为 registry 版本范围');

/* 5) 仓库内不得存在 .npmrc ------------------------------------------------- */
if (existsSync(join(root, '.npmrc'))) {
    fail('仓库根目录存在 .npmrc：发布配置必须只来自 CLI 参数与 publishConfig');
} else {
    pass('仓库内无 .npmrc');
}

/* 6) 打包内容白名单 + exports 完整性 -------------------------------------- */
const PACK_ALLOW = /^(package\.json|LICENSE(?:\.[^/]+)?|README(?:\.[^/]+)?|NOTICE(?:\.[^/]+)?|CHANGELOG(?:\.[^/]+)?|dist\/.+)$/;
const MAX_PACKED_BYTES = 32 * 1024 * 1024;

const packDir = mkdtempSync(join(tmpdir(), `${pkgName}-pack-`));
let packJson;
try {
    packJson = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], { cwd: root });
} catch (error) {
    console.error('::error::npm pack 失败，无法确定发布内容');
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? error.message);
    process.exit(1);
}
const [packInfo] = JSON.parse(packJson);
const packed = packInfo.files.map((file) => file.path.replaceAll('\\', '/')).sort();

const outsideAllowlist = packed.filter((path) => !PACK_ALLOW.test(path));
if (outsideAllowlist.length > 0) {
    fail(`打包内容超出白名单：${outsideAllowlist.slice(0, 10).join(', ')}${outsideAllowlist.length > 10 ? ' …' : ''}`);
} else {
    pass(`打包内容 ${packed.length} 个文件，全部在白名单内`);
}

if (packInfo.size > MAX_PACKED_BYTES) {
    fail(`tarball 体积 ${(packInfo.size / 1048576).toFixed(1)} MiB 超出上限 ${MAX_PACKED_BYTES / 1048576} MiB`);
}

// exports 里每个目标都必须在包里，并且在磁盘上真实存在
const collectTargets = (value, acc = []) => {
    if (typeof value === 'string') {
        acc.push(value);
    } else if (value && typeof value === 'object') {
        for (const nested of Object.values(value)) {
            collectTargets(nested, acc);
        }
    }
    return acc;
};
const exportsTargets = collectTargets(pkg.exports);
if (exportsTargets.length === 0) {
    fail('package.json 没有 exports 字段');
}
const packedSet = new Set(packed);
for (const target of exportsTargets) {
    if (!target.startsWith('./')) {
        fail(`exports 目标 "${target}" 不是相对路径`);
        continue;
    }
    const rel = target.slice(2);
    if (!packedSet.has(rel)) {
        fail(`exports 目标 "${target}" 不在打包内容里`);
    } else if (!existsSync(join(root, rel))) {
        fail(`exports 目标 "${target}" 在磁盘上不存在`);
    }
}
if (exportsTargets.length > 0 && !problems.some((p) => p.includes('exports'))) {
    pass(`exports 的 ${exportsTargets.length} 个入口全部存在于打包内容中`);
}

// tarball 取证：SRI，供发布后比对
const tarballPath = join(packDir, packInfo.filename);
const tarball = readFileSync(tarballPath);
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
const shasum = createHash('sha1').update(tarball).digest('hex');
pass(`tarball ${packInfo.filename}（${(tarball.length / 1048576).toFixed(2)} MiB）${integrity}`);

/* 7) 仓库匹配 + 零 token + OIDC ------------------------------------------ */
if (process.env.GITHUB_REPOSITORY) {
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
    if (!repoUrl.toLowerCase().includes(process.env.GITHUB_REPOSITORY.toLowerCase())) {
        fail(`package.json repository "${repoUrl}" 与 ${process.env.GITHUB_REPOSITORY} 不匹配（provenance 会失败）`);
    } else {
        pass(`repository 与 ${process.env.GITHUB_REPOSITORY} 匹配`);
    }
}

if (process.env.CI) {
    const tokenVars = Object.keys(process.env).filter(
        (key) => /^(NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG__AUTH|NPM_CONFIG__AUTHTOKEN)$/i.test(key),
    );
    if (tokenVars.length > 0) {
        fail(`检测到 npm token 环境变量 ${tokenVars.join(', ')}：本工作流必须完全不使用 token`);
    } else {
        pass('零 token：环境中不存在 NPM_TOKEN / NODE_AUTH_TOKEN');
    }
    if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
        fail('缺少 ACTIONS_ID_TOKEN_REQUEST_* ：job 必须声明 permissions.id-token: write');
    } else {
        pass('OIDC 可用：id-token: write 已生效');
    }
}

/* 结果 -------------------------------------------------------------------- */
for (const line of passed) {
    console.log(`  ok   ${line}`);
}
if (problems.length > 0) {
    console.error('');
    for (const line of problems) {
        console.error(`::error::${line}`);
        console.error(`  fail ${line}`);
    }
    console.error(`\n发布门禁未通过：${problems.length} 项不满足，已中止。`);
    process.exit(1);
}

const evidencePath = resolve(process.env.RELEASE_EVIDENCE ?? join(root, 'release-evidence.json'));
writeFileSync(
    evidencePath,
    `${JSON.stringify(
        {
            name: pkgName,
            version: pkgVersion,
            tag,
            integrity,
            shasum,
            fileCount: packed.length,
            unpackedSize: packInfo.unpackedSize,
            tarballBytes: tarball.length,
            packed,
        },
        null,
        4,
    )}\n`,
);
console.log(`\n发布门禁通过。取证文件：${evidencePath}`);
