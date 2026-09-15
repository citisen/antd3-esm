/**
 * 本地「取证基准」解析：CI 里算出的指纹（evidence 文件），或命令行直接给出的期望值。
 *
 * 发布改成分阶段（staged publishing）后，最终的 publish 动作发生在维护者本机的
 * `npm stage approve`（带 2FA），所以校验必须在本地也能拿到 CI 的指纹作为基准。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 极简参数解析：`--key value` / `--key=value` / `--flag`，其余为位置参数。 */
export const parseArgs = (argv) => {
    const flags = {};
    const positionals = [];
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) {
            positionals.push(token);
            continue;
        }
        const [key, inline] = token.slice(2).split('=');
        if (inline !== undefined) {
            flags[key] = inline;
        } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
            flags[key] = argv[(index += 1)];
        } else {
            flags[key] = true;
        }
    }
    return { flags, positionals };
};

/**
 * 期望值来源优先级：`--evidence <file>` / 当前目录的 release-evidence.json > 命令行参数。
 * `--expect-integrity`、`--expect-shasum`、`--version` 可在没有 evidence 文件时直接指定。
 */
export const loadExpectations = ({ flags, name, version }) => {
    const evidencePath = typeof flags.evidence === 'string' ? resolve(flags.evidence) : resolve('release-evidence.json');
    const fromFile = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : undefined;

    return {
        source: fromFile ? evidencePath : '命令行参数',
        file: fromFile,
        name: flags.name ?? fromFile?.name ?? name,
        version: flags.version ?? fromFile?.version ?? version,
        integrity: flags['expect-integrity'] ?? fromFile?.integrity,
        shasum: flags['expect-shasum'] ?? fromFile?.shasum,
        fileCount: fromFile?.fileCount,
        unpackedSize: fromFile?.unpackedSize,
        stageId: typeof flags['stage-id'] === 'string' ? flags['stage-id'] : fromFile?.stageId,
    };
};

/** 把各种形态的 integrity 值归一成 `sha512-<base64>` 字符串。 */
export const sriOf = (value) => {
    if (typeof value === 'string') {
        return /^sha512-/.test(value) ? value : undefined;
    }
    if (Array.isArray(value)) {
        return value.map(sriOf).find(Boolean);
    }
    if (value && typeof value === 'object') {
        const nested = value.sha512 ?? value.integrity;
        if (typeof nested === 'string') {
            return /^sha512-/.test(nested) ? nested : `sha512-${nested}`;
        }
        if (nested) {
            return sriOf(nested);
        }
        const text = String(value);
        if (/^sha512-/.test(text)) {
            return text;
        }
    }
    return undefined;
};
