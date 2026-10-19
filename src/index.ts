import { Plugin } from '@opencode/plugin';

import { createServerPlugin } from './composition/create-server-plugin.js';

const id = 'brhp' as const;

export default Plugin.define({
  id,
  async setup(context) {
    return createServerPlugin(context);
  },
});
