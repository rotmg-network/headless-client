/**
 * Higher-level game events the Client emits, beyond raw packets. Plugins hook
 * these with `@EventHook(ClientEvent.X)`. The string values are the event names
 * used internally by the Client's emitter.
 */
export enum ClientEvent {
  /** Socket connected; Hello sent. */
  Connected = 'connected',
  /** In-world (CreateSuccess). Payload: objectId. */
  Ready = 'ready',
  /** A new map loaded. Payload: map name. */
  MapChange = 'mapChange',
  /** Entered the vault. */
  EnterVault = 'enterVault',
  /** Entered the nexus. */
  EnterNexus = 'enterNexus',
  /** Vault contents received. Payload: VaultContentPacket. */
  VaultContents = 'vaultContents',
  /** A realm portal was seen/updated. Payload: RealmPortal. */
  RealmPortal = 'realmPortal',
  /** A game tick was processed. Payload: PlayerData | undefined. */
  Tick = 'tick',
  /** The character died. Payload: DeathPacket. */
  Death = 'death',
  /** A FailurePacket was received. Payload: FailurePacket. */
  Failure = 'failure',
  /** The socket closed. */
  Disconnect = 'disconnect',
  /** A move target was reached. Payload: the target {x,y}. */
  ReachedTarget = 'reachedTarget',
}
