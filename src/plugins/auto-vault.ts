import { VaultContentPacket } from 'realmlib';
import { Client } from '../client';
import { Plugin } from './plugin';

/**
 * Walks into the vault on reaching the nexus and reports the item count.
 * Demonstrates hooking game events.
 */
export class AutoVault implements Plugin {
  private client: Client | undefined;

  // Stable handler references so detach() can remove them.
  private readonly onNexus = (): void => {
    this.client?.enterVault();
  };
  private readonly onVault = (vault: VaultContentPacket): void => {
    const count = vault.vaultContents.filter((id) => id !== -1).length;
    console.log(`[${this.client?.alias}] AutoVault: ${count} items in the vault`);
  };

  attach(client: Client): void {
    this.client = client;
    client.on('enterNexus', this.onNexus);
    client.on('vaultContents', this.onVault);
  }

  detach(): void {
    this.client?.off('enterNexus', this.onNexus);
    this.client?.off('vaultContents', this.onVault);
  }
}
