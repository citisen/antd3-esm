#!/usr/bin/env node
/**
 * 批准之后（包已真正上线）的核对：registry 上的产物 == CI 送审时的产物，且带 provenance。
 *
 * 分阶段发布让它变成了「维护者本机」的一步：批准（npm stage approve）之后跑一次，
 * 确认线上字节没变、证明齐全。
 *
 * 用法：
 *   node .github/scripts/verify-published.mjs [--evidence <file>] [--version x.y.z] [--expect-integrity <sri>]
 *
 * 任何一项不满足就以非 0 退出（需要人工介入，例如 npm deprecate）。
 */

import { readFileSync } from 'node:fs';

import { loadExpectations, parseArgs, sriOf } from './lib/expectations.mjs';
import { runNpm } from './lib/npm.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { flags } = parseArgs(process.argv.slice(2));
const expected = loadExpectations({ flags, name: pkg.name, version: pkg.version });
const spec = `${expected.name}@${expected.version}`;

if (!expected.integrity) {
    console.error('缺少 integrity 基准：请用 --evidence <release-evidence.json> 或 --expect-integrity <sha512-...> 指定。');
    process.exit(2);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// 注意：npm view 的多个字段必须是独立的 argv（拼成一个参数会静默返回空结果）。
// --prefer-online 绕过本地缓存，确保读到刚发布的那份 manifest。
const FIELDS = [
    'dist.integrity',
    'dist.shasum',
    'dist.fileCount',
    'dist.unpackedSize',
    'dist.signatures',
    'dist.attestations',
];
const view = () => {
    const out = runNpm([
        'view',
        spec,
        ...FIELDS,
        '--json',
        '--prefer-online',
        '--registry=https://registry.npmjs.org/',
    ]).trim();
    return out === '' ? undefined : JSON.parse(out);
};

let info;
for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
        info = view();
    } catch (error) {
        info = undefined;
        if (attempt === 12) {
            console.error(
                `::error::无法读取 ${spec} 的 manifest：${`${error.stderr ?? ''}`
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => /^npm error/.test(line))
                    .slice(0, 3)
                    .join(' | ') || error.message}`,
            );
            process.exit(1);
        }
    }
    if (info?.['dist.integrity']) {
        break;
    }
    await sleep(5000);
}
if (!info?.['dist.integrity']) {
    console.error(`::error::60 秒内仍读不到 ${spec} 的 dist.integrity，无法确认发布结果`);
    process.exit(1);
}

const problems = [];
const publishedIntegrity = info['dist.integrity'];
if (sriOf(publishedIntegrity) !== sriOf(expected.integrity)) {
    problems.push(`registry 上的 integrity (${publishedIntegrity}) 与基准 (${expected.integrity}) 不一致`);
}
if (expected.shasum && info['dist.shasum'] !== expected.shasum) {
    problems.push(`registry 上的 shasum (${info['dist.shasum']}) 与基准 (${expected.shasum}) 不一致`);
}
if (expected.fileCount !== undefined && info['dist.fileCount'] !== expected.fileCount) {
    problems.push(`registry 上的 fileCount (${info['dist.fileCount']}) 与基准 (${expected.fileCount}) 不一致`);
}
if (expected.unpackedSize !== undefined && info['dist.unpackedSize'] !== expected.unpackedSize) {
    problems.push(`registry 上的 unpackedSize (${info['dist.unpackedSize']}) 与基准 (${expected.unpackedSize}) 不一致`);
}
if (!Array.isArray(info['dist.signatures']) || info['dist.signatures'].length === 0) {
    problems.push('registry 上缺少 dist.signatures：产物没有 registry 签名');
}
const attestations = info['dist.attestations'];
if (!attestations?.provenance && !attestations?.url) {
    problems.push('registry 上没有 provenance 证明，说明这次发布不是走 OIDC trusted publishing');
}

console.log(`  ok   ${spec} 已在 registry 上可读`);
console.log(`  ok   integrity：${publishedIntegrity}`);
console.log(`  ok   文件数 ${info['dist.fileCount']}，解包体积 ${info['dist.unpackedSize']} 字节`);
console.log(`  ok   registry 签名：${info['dist.signatures']?.[0]?.keyid ?? '无'}`);
const provenanceUrl = attestations?.url ?? attestations?.provenance?.url ?? null;
if (provenanceUrl) {
    console.log(`  ok   provenance 证明：${provenanceUrl}`);
}

if (problems.length > 0) {
    for (const line of problems) {
        console.error(`::error::${line}`);
        console.error(`  fail ${line}`);
    }
    process.exit(1);
}
console.log('\n线上产物与基准一致，且带 registry 签名与 provenance。');
