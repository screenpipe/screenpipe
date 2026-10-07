// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {mergeConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import base from './vitest.config';
// Resolve the historical workspace package from the evaluated tree, not a
// cached node_modules workspace symlink. External packages remain matched.
export default mergeConfig(base, {resolve:{alias:{'@screenpipe/workflows-ui/chat':fileURLToPath(new URL('../../packages/workflows-ui/src/chat-primitives.tsx',import.meta.url))}},test:{include:['components/chat/eval-remote-image-outcome.test.tsx'],maxWorkers:1,minWorkers:1}});
