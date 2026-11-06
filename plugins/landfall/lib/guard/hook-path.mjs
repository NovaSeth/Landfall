// Hook files (SEC-4): a hook directory (.githooks, .husky, .git/hooks) or .git itself, after resolving against the command's directory.
import { resolve } from 'node:path';

export const isHookPath = (t, cwd) => /(^|\/)(\.githooks|\.husky|\.git\/hooks)(\/|$)|(^|\/)\.git\/?$/.test(cwd ? resolve(cwd, t) : t);
