import { EventEmitter } from 'events';

/**
 * Supported network chain IDs
 */
export enum ChainId {
  MAINNET = '0x1',
  GOERLI = '0x5',
  SEPOLIA = '0xaa36a7',
  POLYGON = '0x89',
  BSC = '0x38',
  ARBITRUM = '0xa4b1',
  OPTIMISM = '0xa',
  AVALANCHE = '0xa86a',
}

/**
 * Network configuration interface
 */
export interface NetworkConfig {
  chainId: string;
  rpcUrl: string;
  ticker: string;
  nickname: string;
  rpcPrefs?: {
    blockExplorerUrl?: string;
    imageUrl?: string;
  };
}

/**
 * Network state interface
 */
export interface NetworkState {
  selectedNetworkClientId: string;
  networkConfigurations: Record<string, NetworkConfig>;
  providerConfig: NetworkConfig;
}

/**
 * Default network configurations
 */
const DEFAULT_NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    chainId: ChainId.MAINNET,
    rpcUrl: 'https://mainnet.infura.io/v3/',
    ticker: 'ETH',
    nickname: 'Ethereum Mainnet',
    rpcPrefs: {
      blockExplorerUrl: 'https://etherscan.io',
    },
  },
  sepolia: {
    chainId: ChainId.SEPOLIA,
    rpcUrl: 'https://sepolia.infura.io/v3/',
    ticker: 'SepoliaETH',
    nickname: 'Sepolia',
    rpcPrefs: {
      blockExplorerUrl: 'https://sepolia.etherscan.io',
    },
  },
};

/**
 * NetworkController manages the active network connection and
 * available network configurations for the MetaMask wallet.
 */
export class NetworkController extends EventEmitter {
  private state: NetworkState;

  constructor(initialState?: Partial<NetworkState>) {
    super();
    this.state = {
      selectedNetworkClientId: 'mainnet',
      networkConfigurations: DEFAULT_NETWORKS,
      providerConfig: DEFAULT_NETWORKS.mainnet,
      ...initialState,
    };
  }

  /**
   * Returns the current network state
   */
  getState(): NetworkState {
    return { ...this.state };
  }

  /**
   * Returns the currently active network configuration
   */
  getProviderConfig(): NetworkConfig {
    return { ...this.state.providerConfig };
  }

  /**
   * Switches the active network to the given network client ID
   * @param networkClientId - The ID of the network to switch to
   */
  async setActiveNetwork(networkClientId: string): Promise<void> {
    const network = this.state.networkConfigurations[networkClientId];
    if (!network) {
      throw new Error(`Network '${networkClientId}' not found in configurations`);
    }

    this.state = {
      ...this.state,
      selectedNetworkClientId: networkClientId,
      providerConfig: network,
    };

    this.emit('networkDidChange', network);
  }

  /**
   * Adds or updates a custom network configuration
   * @param networkClientId - Unique identifier for the network
   * @param config - Network configuration object
   */
  upsertNetworkConfiguration(
    networkClientId: string,
    config: NetworkConfig,
  ): void {
    this.state = {
      ...this.state,
      networkConfigurations: {
        ...this.state.networkConfigurations,
        [networkClientId]: config,
      },
    };
    this.emit('networkConfigurationUpdated', { networkClientId, config });
  }

  /**
   * Removes a custom network configuration by ID
   * @param networkClientId - The ID of the network configuration to remove
   */
  removeNetworkConfiguration(networkClientId: string): void {
    if (networkClientId === this.state.selectedNetworkClientId) {
      throw new Error('Cannot remove the currently active network');
    }
    const { [networkClientId]: _removed, ...remaining } =
      this.state.networkConfigurations;
    this.state = { ...this.state, networkConfigurations: remaining };
    this.emit('networkConfigurationRemoved', networkClientId);
  }
}

export default NetworkController;
