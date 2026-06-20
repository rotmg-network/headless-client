// Importing each plugin module runs its @Plugin decorator, registering it.
// Add new plugins here (or switch to dynamic discovery later).
import './auto-vault';
import './anti-spam';
import './auto-quest';
import './chat-logger';
import './chest-replication';
import './game-id-checker';
import './packet-logger';
import './realm-finder';
import './realm-host-mapper';

export * from './decorators';
