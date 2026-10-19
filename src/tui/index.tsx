/** @jsxImportSource @opentui/solid */
import { Plugin } from '@opencode/plugin/tui';

import { createTuiPlugin } from '../composition/create-tui-plugin.js';

const id = 'brhp' as const;

export default Plugin.define({
  id,
  setup: createTuiPlugin(),
});
