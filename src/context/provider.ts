// context/provider.ts

import type { AgentConfig, ContextData } from '../config/types.js';
import type { Store } from '../store/store.js';
import { getDateTimeContext } from './datetime.js';
import { getLocationContext } from './location.js';
import { getVaultState } from './vault-state.js';

export async function assembleContext(vaultPath: string, config: AgentConfig, store: Store): Promise<ContextData> {
  const datetime = getDateTimeContext(config.userMeta.timezone);
  const location = getLocationContext(config.userMeta);
  const vault = await getVaultState(vaultPath, store, location);

  // Calendar and health came from server integrations that are gone. The engine
  // can use its own calendar tools when asked.
  return { datetime, calendar: null, health: null, location, vault };
}
