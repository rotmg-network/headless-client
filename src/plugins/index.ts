// Importing each plugin module runs its @Plugin decorator, registering it.
// Add new plugins here (or switch to dynamic discovery later).
import './auto-vault';
import './chat-logger';

export * from './decorators';
