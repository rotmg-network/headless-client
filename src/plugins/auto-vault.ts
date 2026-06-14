import { VaultContentPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { Plugin, EventHook } from './decorators';

/** Walks into the vault on reaching the nexus and reports the item count. */
@Plugin({
  name: 'AutoVault',
  description: 'Walks into the vault on reaching the nexus and logs its contents.',
  author: 'realmlib',
  version: '1.0.0',
})
export class AutoVault {
  @EventHook(ClientEvent.EnterNexus)
  onNexus(client: Client): void {
    client.enterVault();
  }

  @EventHook(ClientEvent.VaultContents)
  onVault(client: Client, vault: VaultContentPacket): void {
    const count = vault.vaultContents.filter((id) => id !== -1).length;
    console.log(`[${client.alias}] AutoVault: ${count} items in the vault`);
  }
}
