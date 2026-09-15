/**
 * 统一的 npm 调用封装。
 *
 * - 直接执行 Node 自带的 npm-cli.js，不经过 shell：既避免 Windows 上 .cmd 的 EINVAL，
 *   也避免任何参数解释/注入；
 * - 默认注入 NPM_CONFIG_IGNORE_SCRIPTS=true：任何 npm 调用都不会执行依赖包的生命周期脚本。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const npmCli = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.npm_execpath,
]
    .filter(Boolean)
    .find((candidate) => existsSync(candidate));

const spawn = (args, { stdio, env: extraEnv, ...options }) => {
    const env = { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: 'true', ...(extraEnv ?? {}) };
    const file = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const argv = npmCli ? [npmCli, ...args] : args;
    if (stdio === 'inherit') {
        return execFileSync(file, argv, { ...options, stdio: 'inherit', env });
    }
    return execFileSync(file, argv, { encoding: 'utf8', ...options, env });
};

/** 调用 npm 并返回 stdout 字符串（失败时抛出，异常对象带 stdout/stderr）。 */
export const runNpm = (args, options = {}) => spawn(args, options);

/** 调用 npm 并把 stdio 交给终端（用于需要交互式 OTP 输入的命令）。 */
export const runNpmInherit = (args, options = {}) => spawn(args, { ...options, stdio: 'inherit' });
