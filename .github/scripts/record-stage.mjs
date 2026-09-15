#!/usr/bin/env node
/**
 * CI 第二阶段：接收 `npm stage publish --json` 的输出，做交叉校验并记录 stage id。
 *
 * 分阶段发布（staged publishing）下，CI 只有「送审」权限，真正的 publish 由维护者
 * 在本机 `npm stage approve`（2FA）完成。所以这一步要做两件事：
 *   1. 证明 npm 真正上传到 registry 的字节 == 门禁阶段本地打包的字节
 *      （比对 integrity / shasum / 解包体积 / tarball 体积）
 *   2. 把 stage id 写回 evidence，并生成 job summary（含维护者要执行的批准命令）
 *
 * 需要的环境变量：STAGE_OUTPUT、RELEASE_EVIDENCE、可选的 GITHUB_STEP_SUMMARY。
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sriOf } from './lib/expectations.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stageOutputPath = resolve(process.env.STAGE_OUTPUT ?? 'stage-output.json');
const evidencePath = resolve(process.env.RELEASE_EVIDENCE ?? 'release-evidence.json');
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const raw = readFileSync(stageOutputPath, 'utf8');

/**
 * `npm stage publish --json` 的输出是 `{ "<包名>": { ...tar 内容, stageId } }`，
 * 但为了对不同 npm 版本/不同输出形态都稳，这里做多重兜底。
 */
const extractStageInfo = (text) => {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = undefined;
    }

    const candidates = [];
    if (Array.isArray(parsed)) {
        candidates.push(...parsed);
    } else if (parsed && typeof parsed === 'object') {
        candidates.push(parsed);
        for (const value of Object.values(parsed)) {
            if (value && typeof value === 'object') {
                candidates.push(value);
            }
        }
    }
    const found = candidates.find((candidate) => candidate?.stageId);
    if (found) {
        return found;
    }
    const matched = /"stageId"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(text);
    return matched ? { stageId: matched[1] } : undefined;
};

const info = extractStageInfo(raw);
const problems = [];
const passed = [];

if (!info?.stageId) {
    console.error('::error::无法从 npm stage publish 的输出里解析出 stageId');
    console.error('原始输出：');
    console.error(raw);
    process.exit(1);
}
if (!UUID.test(info.stageId)) {
    problems.push(`stageId "${info.stageId}" 不是合法 UUID`);
} else {
    passed.push(`stage id：${info.stageId}`);
}

if (info.name && info.name !== evidence.name) {
    problems.push(`staged 包名 (${info.name}) 与门禁阶段 (${evidence.name}) 不一致`);
}
if (info.version && info.version !== evidence.version) {
    problems.push(`staged 版本 (${info.version}) 与门禁阶段 (${evidence.version}) 不一致`);
}

const stagedIntegrity = sriOf(info.integrity);
if (!stagedIntegrity) {
    problems.push('npm 输出里没有 integrity，无法证明上传字节与本地一致');
} else if (stagedIntegrity !== evidence.integrity) {
    problems.push(`registry 收到的 integrity (${stagedIntegrity}) 与门禁阶段 (${evidence.integrity}) 不一致`);
} else {
    passed.push(`integrity 与门禁阶段一致：${stagedIntegrity}`);
}

const comparisons = [
    ['shasum', info.shasum, evidence.shasum],
    ['unpackedSize', info.unpackedSize, evidence.unpackedSize],
    ['tarball bytes', info.size, evidence.tarballBytes],
];
for (const [label, actual, expected] of comparisons) {
    if (actual === undefined || expected === undefined) {
        continue;
    }
    if (actual !== expected) {
        problems.push(`${label}：npm 上报 ${actual}，门禁阶段为 ${expected}`);
    } else {
        passed.push(`${label} 一致：${actual}`);
    }
}

for (const line of passed) {
    console.log(`  ok   ${line}`);
}
if (problems.length > 0) {
    for (const line of problems) {
        console.error(`::error::${line}`);
        console.error(`  fail ${line}`);
    }
    console.error('\n送审结果与门禁指纹不一致：请勿批准，先排查。');
    process.exit(1);
}

const updated = {
    ...evidence,
    stageId: info.stageId,
    stagedAt: new Date().toISOString(),
    stagedReport: {
        integrity: stagedIntegrity,
        shasum: info.shasum ?? null,
        unpackedSize: info.unpackedSize ?? null,
        tarballBytes: info.size ?? null,
        entryCount: info.entryCount ?? null,
    },
};
writeFileSync(evidencePath, `${JSON.stringify(updated, null, 4)}\n`);

const summary = [
    `### npm staged release: \`${evidence.name}@${evidence.version}\``,
    '',
    'CI 只完成了「送审」（trusted publisher 权限为 `npm stage publish`），还没有真正发布。',
    '',
    '| field | value |',
    '| --- | --- |',
    `| tag | \`${evidence.tag}\` |`,
    `| commit | \`${process.env.GITHUB_SHA ?? 'n/a'}\` |`,
    `| stage id | \`${info.stageId}\` |`,
    `| integrity | \`${evidence.integrity}\` |`,
    `| shasum | \`${evidence.shasum}\` |`,
    `| files | ${evidence.fileCount} |`,
    `| tarball bytes | ${evidence.tarballBytes} |`,
    '',
    '**下一步（维护者本机，需要 2FA）**：先核对，再批准。',
    '',
    '```bash',
    `npm stage view ${info.stageId}`,
    `node .github/scripts/approve-stage.mjs ${info.stageId} --expect-integrity ${evidence.integrity} --approve`,
    '```',
    '',
    '批准后可以再验一次线上产物：',
    '',
    '```bash',
    `node .github/scripts/verify-published.mjs --version ${evidence.version} --expect-integrity ${evidence.integrity}`,
    '```',
    '',
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
console.log(`\n送审完成，指纹与门禁阶段完全一致。stage id：${info.stageId}`);
console.log('等待维护者在本机执行 npm stage approve（2FA）后，包才会真正发布。');
