// Importing each plugin module runs its @Plugin decorator, registering it.
// Add new plugins here (or switch to dynamic discovery later).
import './auto-vault';
import './anti-spam';
import './auto-quest';
import './chat-logger';
import './chest-replication';
import './game-id-checker';
import './inventory-tracker';
import './packet-logger';
import './pet-bag-round-trip';
import './pet-to-vault';
import './realm-finder';
import './realm-host-mapper';
import './socket-stall';
import './vault-storage';

export * from './decorators';
