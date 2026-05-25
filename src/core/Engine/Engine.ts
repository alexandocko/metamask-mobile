/**
 * Engine.ts
 * Core engine module for MetaMask Mobile.
 * Manages the lifecycle of all controllers and provides
 * a centralized access point for blockchain interactions.
 */

import { EventEmitter } from 'events';

/**
 * Engine state interface representing the aggregated state
 * of all managed controllers.
 */
export interface EngineState {
  networkClientId: string;
  chainId: string;
  isInitialized: boolean;
  backgroundState: Record<string, unknown>;
}

/**
 * Engine configuration options.
 */
export interface EngineConfig {
  initialState?: Partial<EngineState>;
  encryptionKey?: string;
  debug?: boolean;
}

const DEFAULT_STATE: EngineState = {
  networkClientId: 'mainnet',
  chainId: '0x1',
  isInitialized: false,
  backgroundState: {},
};

/**
 * Singleton Engine class that orchestrates all MetaMask controllers.
 * Extends EventEmitter to allow components to subscribe to state changes.
 */
class Engine extends EventEmitter {
  private static instance: Engine | null = null;
  private state: EngineState;
  private config: EngineConfig;

  private constructor(config: EngineConfig = {}) {
    super();
    this.config = config;
    this.state = {
      ...DEFAULT_STATE,
      ...(config.initialState ?? {}),
    };
  }

  /**
   * Returns the singleton Engine instance, creating it if necessary.
   */
  static getInstance(config?: EngineConfig): Engine {
    if (!Engine.instance) {
      Engine.instance = new Engine(config);
    }
    return Engine.instance;
  }

  /**
   * Destroys the current Engine instance.
   * Useful for testing or full app resets.
   */
  static destroyInstance(): void {
    if (Engine.instance) {
      Engine.instance.removeAllListeners();
      Engine.instance = null;
    }
  }

  /**
   * Initializes the engine and all sub-controllers.
   * Must be called before any other engine operations.
   */
  async initialize(): Promise<void> {
    if (this.state.isInitialized) {
      if (this.config.debug) {
        console.warn('[Engine] Already initialized, skipping.');
      }
      return;
    }

    try {
      // TODO: Initialize KeyringController, NetworkController, etc.
      this.state.isInitialized = true;
      this.emit('initialized', this.state);

      if (this.config.debug) {
        console.log('[Engine] Initialized successfully.');
      }
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Returns a shallow copy of the current engine state.
   */
  getState(): Readonly<EngineState> {
    return { ...this.state };
  }

  /**
   * Updates a subset of the engine state and emits a stateChange event.
   */
  updateState(partial: Partial<EngineState>): void {
    this.state = { ...this.state, ...partial };
    this.emit('stateChange', this.state);
  }

  /**
   * Returns whether the engine has been initialized.
   */
  get isReady(): boolean {
    return this.state.isInitialized;
  }
}

export default Engine;
