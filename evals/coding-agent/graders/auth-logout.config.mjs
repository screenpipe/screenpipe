// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {defineConfig} from 'vitest/config';import {resolve} from 'node:path';export default defineConfig({resolve:{alias:{'@':resolve(process.cwd()),'gt-react':resolve(process.cwd(),'eval-auth-translation.ts')}},test:{environment:'jsdom',include:['eval-auth-logout.test.tsx'],pool:'forks',maxWorkers:1,minWorkers:1},esbuild:{jsx:'automatic'}});
