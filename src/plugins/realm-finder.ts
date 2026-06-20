import { Client } from '../client';
import { ClientEvent } from '../events';
import { RealmPortal } from '../models';
import { Plugin, EventHook } from './decorators';

const PORTAL_AREA = { x: 130, y: 110 };

/**
 * Watches the realm portals in the nexus and logs the least-populated open
 * realm as they appear/update. The selection is a pure function, so it can be
 * unit tested without connecting.
 */
@Plugin({
  name: 'RealmFinder',
  description: 'Logs the least-populated open realm as realm portals appear.',
  author: 'realmlib',
  version: '1.0.0',
})
export class RealmFinder {
  private best: string | undefined;
  private atPortalArea = false;

  @EventHook(ClientEvent.EnterNexus)
  onEnterNexus(client: Client): void {
    this.best = undefined;
    this.atPortalArea = false;
    console.log(`[${client.alias}] RealmFinder: walking to realm portal area`);
    client.moveTo(PORTAL_AREA);
  }

  @EventHook(ClientEvent.ReachedTarget)
  onReachedTarget(client: Client, target: { x: number; y: number }): void {
    if (distance(target, PORTAL_AREA) > 0.1) {
      return;
    }
    this.atPortalArea = true;
    this.logBestRealm(client);
  }

  @EventHook(ClientEvent.RealmPortal)
  onRealmPortal(client: Client): void {
    if (!this.atPortalArea) {
      return;
    }
    this.logBestRealm(client);
  }

  private logBestRealm(client: Client): void {
    const realm = RealmFinder.pickEmptiest(client.realmPortals());
    if (realm && realm.name !== this.best) {
      this.best = realm.name;
      const free = realm.maxPlayers - realm.players;
      console.log(
        `[${client.alias}] RealmFinder: emptiest realm is ${realm.name} (${realm.players}/${realm.maxPlayers}, ${free} free)`,
      );
    }
  }

  /** The open realm (not full) with the most free slots, or undefined if none. */
  static pickEmptiest(portals: RealmPortal[]): RealmPortal | undefined {
    return portals
      .filter((p) => p.players < p.maxPlayers)
      .sort((a, b) => b.maxPlayers - b.players - (a.maxPlayers - a.players))[0];
  }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
