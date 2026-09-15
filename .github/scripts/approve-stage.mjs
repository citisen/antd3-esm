#!/usr/bin/env node
/**
 * 维护者本机使用：批准（或仅核对）一个已送审的 npm staged release。
 *
 * 为什么要在批准前跑这一步：CI 的权限是 `npm stage publish`，批准这个动作由人
 * 在本机用 2FA 完成，所以「registry 上的 staged 字节 == CI 打包的字节」这件事
 * 必须在批准前核对一次。核对方式是从 registry 把 staged tarball 下载下来，
 * 逐字节比对 sha512（SRI）和 sha1。
 *
 * 用法：
 *   node .github/scripts/approve-stage.mjs <stage-id> [选项]
 *
 * 选项：
 *   --evidence <file>         CI 产出的 release-evidence.json（默认 ./release-evidence.json）
 *   --expect-integrity <sri>  没有 evidence 文件时直接指定 sha512 SRI（CI job summary 里有）
 *   --expect-shasum <sha1>    同上，sha1
 *   --version <x.y.z>         覆盖版本号（默认取本地 package.json）
 *   --approve                 核对通过后立刻执行 `npm stage approve`（会要求输入 OTP）
 *
 * 不加 --approve 时只做核对，不做任何写操作。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadExpectations, parseArgs, sriOf } from './lib/expectations.mjs';
import { runNpm, runNpmInherit } from './lib/npm.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { flags, positionals } = parseArgs(process.argv.slice(2));
const stageId = positionals[0];

/** 把 npm 的报错压缩成一行，避免刷屏。 */
const errorText = (error) => {
    const lines = `${error.stderr ?? ''}`
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^npm error/.test(line));
    return lines.slice(0, 3).join(' | ') || error.message;
};

if (!stageId) {
    console.error('用法：node .github/scripts/approve-stage.mjs <stage-id> [--evidence <file>] [--expect-integrity <sri>] [--approve]');
    process.exit(2);
}

const expected = loadExpectations({ flags, name: pkg.name, version: pkg.version });
const problems = [];
const passed = [];

console.log(`核对 staged release ${stageId}`);
console.log(`  基准来源：${expected.source}`);

/* 1) registry 上的 staged 元数据 ----------------------------------------- */
let item;
try {
    item = JSON.parse(runNpm(['stage', 'view', stageId, '--json', '--registry=https://registry.npmjs.org/']));
} catch (error) {
    console.error(`::error::npm stage view ${stageId} 失败：${errorText(error)}`);
    process.exit(1);
}

if (item.packageName && expected.name && item.packageName !== expected.name) {
    problems.push(`staged 包名 ${item.packageName} != 期望 ${expected.name}`);
}
if (item.version && expected.version && item.version !== expected.version) {
    problems.push(`staged 版本 ${item.version} != 期望 ${expected.version}`);
}
if (item.shasum && expected.shasum && item.shasum !== expected.shasum) {
    problems.push(`registry 元数据里的 shasum ${item.shasum} != 期望 ${expected.shasum}`);
}
passed.push(
    `staged 元数据：${item.packageName}@${item.version}，tag ${item.tag ?? 'latest'}，由 ${item.actor ?? '未知'} (${item.actorType ?? 'n/a'}) 于 ${item.createdAt ?? 'n/a'} 送审`,
);

/* 2) 下载 staged tarball，逐字节核对 ------------------------------------- */
if (!expected.integrity) {
    console.log('提示：没有 integrity 基准（既没有 evidence 文件，也没有 --expect-integrity），只做元数据核对。');
}

const workDir = mkdtempSync(join(tmpdir(), 'npm-stage-'));
let downloaded;
try {
    try {
        runNpm(['stage', 'download', stageId, '--json', '--registry=https://registry.npmjs.org/'], { cwd: workDir });
    } catch (error) {
        console.error(`::error::npm stage download ${stageId} 失败：${errorText(error)}`);
        process.exit(1);
    }

    const safeName = String(item.packageName ?? expected.name).replace('@', '').replace('/', '-');
    const tarballPath = join(workDir, `${safeName}-${item.version ?? expected.version}-${stageId}.tgz`);
    const bytes = readFileSync(tarballPath);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const shasum = createHash('sha1').update(bytes).digest('hex');
    downloaded = { integrity, shasum, bytes: bytes.length };

    if (expected.integrity && sriOf(integrity) !== sriOf(expected.integrity)) {
        problems.push(`staged tarball 的 integrity (${integrity}) 与基准 (${expected.integrity}) 不一致`);
    } else if (expected.integrity) {
        passed.push(`staged tarball 与基准逐字节一致：${integrity}`);
    }
    if (expected.shasum && shasum !== expected.shasum) {
        problems.push(`staged tarball 的 shasum (${shasum}) 与基准 (${expected.shasum}) 不一致`);
    }
    passed.push(`staged tarball：${bytes.length} 字节，sha1 ${shasum}`);
} finally {
    rmSync(workDir, { recursive: true, force: true });
}

for (const line of passed) {
    console.log(`  ok   ${line}`);
}
if (problems.length > 0) {
    for (const line of problems) {
        console.error(`::error::${line}`);
        console.error(`  fail ${line}`);
    }
    console.error('\n核对未通过：不要批准这次送审。');
    process.exit(1);
}

console.log('\n核对通过。');
if (!flags.approve) {
    console.log(`确认无误后再执行：npm stage approve ${stageId}   （会要求输入 2FA 的 OTP）`);
    process.exit(0);
}

console.log(`执行 npm stage approve ${stageId} …（需要 2FA）`);
runNpmInherit(['stage', 'approve', stageId, '--registry=https://registry.npmjs.org/']);
console.log('\n已批准并发布。建议再验一次线上产物：');
console.log(
    `  node .github/scripts/verify-published.mjs --version ${expected.version} --expect-integrity ${downloaded.integrity}`,
);
