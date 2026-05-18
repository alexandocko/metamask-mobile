import { Interface } from '@ethersproject/abi';
import { abiERC20 } from '@metamask/metamask-eth-abis';
import {
  AuthorizationList,
  GasFeeToken,
  IsAtomicBatchSupportedRequest,
  IsAtomicBatchSupportedResult,
  PublishHook,
  PublishHookResult,
  TransactionMeta,
  decodeAuthorizationSignature,
} from '@metamask/transaction-controller';
import { Hex, createProjectLogger } from '@metamask/utils';
import {
  Caveat,
  DeleGatorEnvironment,
  ExecutionStruct,
  createCaveatBuilder,
  getDeleGatorEnvironment,
} from '../../../core/Delegation';
import { exactExecution } from '../../../core/Delegation/caveatBuilder/exactExecutionBuilder';
import { limitedCalls } from '../../../core/Delegation/caveatBuilder/limitedCallsBuilder';
import { specificActionERC20TransferBatch } from '../../../core/Delegation/caveatBuilder/specificActionERC20TransferBatchBuilder';
import { TransactionControllerInitMessenger } from '../../../core/Engine/messengers/transaction-controller-messenger';
import {
  RelayStatus,
  RelaySubmitRequest,
  submitRelayTransaction,
  waitForRelayResult,
} from '../transaction-relay';
import { NetworkClientId } from '@metamask/network-controller';
import { isE2ETest } from '../util';
import {
  getClientForTransactionMetadata,
  sanitizeOrigin,
} from '../../../constants/smartTransactions';
import {
  convertTransactionToRedeemDelegations,
  normalizeCallData,
} from '../delegation';

const SEPOLIA_CHAIN_ID = '0xaa36a7';
const POLLING_INTERVAL_MS = 1000;

const EMPTY_RESULT = {
  transactionHash: undefined,
};

const log = createProjectLogger('delegation-7702-publish-hook');

export class Delegation7702PublishHook {
  #isAtomicBatchSupported: (
    request: IsAtomicBatchSupportedRequest,
  ) => Promise<IsAtomicBatchSupportedResult>;

  #messenger: TransactionControllerInitMessenger;

  #getNextNonce: (
    address: string,
    networkClientId: NetworkClientId,
  ) => Promise<Hex>;

  constructor({
    isAtomicBatchSupported,
    messenger,
    getNextNonce,
  }: {
    isAtomicBatchSupported: (
      request: IsAtomicBatchSupportedRequest,
    ) => Promise<IsAtomicBatchSupportedResult>;
    messenger: TransactionControllerInitMessenger;
    getNextNonce: (
      address: string,
      networkClientId: NetworkClientId,
    ) => Promise<Hex>;
  }) {
    this.#isAtomicBatchSupported = isAtomicBatchSupported;
    this.#messenger = messenger;
    this.#getNextNonce = getNextNonce;
  }

  getHook(): PublishHook {
    return this.#hookWrapper.bind(this);
  }

  async #hookWrapper(
    transactionMeta: TransactionMeta,
    _signedTx: string,
  ): Promise<PublishHookResult> {
    try {
      return await this.#hook(transactionMeta, _signedTx);
    } catch (error) {
      log('Error', error);
      throw error;
    }
  }

  async #hook(
    transactionMeta: TransactionMeta,
    _signedTx: string,
  ): Promise<PublishHookResult> {
    const { chainId, gasFeeTokens, selectedGasFeeToken, txParams } =
      transactionMeta;

    const { from } = txParams;

    const atomicBatchSupport = await this.#isAtomicBatchSupported({
      address: from as Hex,
      chainIds: [chainId],
    });

    const atomicBatchChainSupport = atomicBatchSupport.find(
      (result) => result.chainId.toLowerCase() === chainId.toLowerCase(),
    );

    const isChainSupported =
      atomicBatchChainSupport &&
      (!atomicBatchChainSupport.delegationAddress ||
        atomicBatchChainSupport.isSupported);

    if (!isChainSupported) {
      log('Skipping as EIP-7702 is not supported', { from, chainId });
      return EMPTY_RESULT;
    }

    const { delegationAddress, upgradeContractAddress } =
      atomicBatchChainSupport;

    const isGaslessBridge = transactionMeta.isGasFeeIncluded;
    const isSponsored = Boolean(transactionMeta.isGasFeeSponsored);

    if (
      (!selectedGasFeeToken || !gasFeeTokens?.length) &&
      !isGaslessBridge &&
      !isSponsored
    ) {
      log('Skipping as no selected gas fee token');
      return EMPTY_RESULT;
    }

    const gasFeeToken =
      isGaslessBridge || isSponsored
        ? undefined
        : gasFeeTokens?.find(
            (token) =>
              token.tokenAddress.toLowerCase() ===
              selectedGasFeeToken?.toLowerCase(),
          );

    if (!gasFeeToken && !isGaslessBridge && !isSponsored) {
      throw new Error('Selected gas fee token not found');
    }

    const includeTransfer = !isGaslessBridge && !transactionMeta.isGasFeeSponsored;

    if (includeTransfer && (!gasFeeToken || gasFeeToken === undefined)) {
      throw new Error('Gas fee token not found');
    }

    const effectiveChainId = isE2ETest(chainId) ? SEPOLIA_CHAIN_ID : chainId;
    const delegationEnvironment = getDeleGatorEnvironment(
      parseInt(effectiveChainId, 16),
    );

    const caveats = this.#buildCaveats(
      delegationEnvironment,
      transactionMeta,
      gasFeeToken,
      includeTransfer,
    );

    const additionalExecutions: ExecutionStruct[] =
      includeTransfer && gasFeeToken
        ? [this.#buildTransferExecution(gasFeeToken)]
        : [];

    const { data, to: delegationManagerAddress } =
      await convertTransactionToRedeemDelegations({
        transaction: {
          ...transactionMeta,
          chainId: effectiveChainId as Hex,
        },
        messenger: this.#messenger,
        caveats,
        additionalExecutions,
        skipAuthorization: true,
      });

    const relayRequest: RelaySubmitRequest = {
      chainId,
      data,
      to: delegationManagerAddress,
      metadata: {
        txType: transactionMeta.type,
        client: getClientForTransactionMetadata(),
        origin: sanitizeOrigin(transactionMeta.origin),
      },
    };

    if (!delegationAddress) {
      relayRequest.authorizationList = await this.#buildAuthorizationList(
        transactionMeta,
        upgradeContractAddress,
      );
    }

    log('Relay request', relayRequest);

    const initialTxMeta = this.#messenger
      .call('TransactionController:getState')
      .transactions.find((tx) => tx.id === transactionMeta.id);

    if (initialTxMeta) {
      this.#messenger.call(
        'TransactionController:updateTransaction',
        {
          ...initialTxMeta,
          txParams: {
            ...initialTxMeta.txParams,
            nonce: undefined,
          },
        },
        'Delegation7702PublishHook - Remove nonce from transaction before relay',
      );
    }

    const { uuid } = await submitRelayTransaction(relayRequest);

    const { transactionHash, status } = await waitForRelayResult({
      chainId,
      uuid,
      interval: POLLING_INTERVAL_MS,
    });

    if (status !== RelayStatus.Success) {
      throw new Error(`Transaction relay error - ${status}`);
    }

    log('Setting isIntentComplete after relay success', transactionMeta.id);
    const finalTxMeta = this.#messenger
      .call('TransactionController:getState')
      .transactions.find((tx) => tx.id === transactionMeta.id);

    if (finalTxMeta) {
      this.#messenger.call(
        'TransactionController:updateTransaction',
        {
          ...finalTxMeta,
          isIntentComplete: true,
        },
        'Delegation7702PublishHook - Set isIntentComplete after relay confirmed',
      );
    }

    return {
      transactionHash,
    };
  }

  #buildTransferExecution(gasFeeToken: GasFeeToken): ExecutionStruct {
    return {
      target: gasFeeToken.tokenAddress,
      value: BigInt('0x0'),
      callData: this.#buildTokenTransferData(
        gasFeeToken.recipient,
        gasFeeToken.amount,
      ),
    };
  }

  #buildCaveats(
    environment: DeleGatorEnvironment,
    transactionMeta: TransactionMeta,
    gasFeeToken: GasFeeToken | undefined,
    includeTransfer: boolean,
  ): Caveat[] {
    const caveatBuilder = createCaveatBuilder(environment);

    const { txParams } = transactionMeta;
    const { to, value, data } = txParams;
    const normalizedData = normalizeCallData(data);

    if (includeTransfer && gasFeeToken !== undefined) {
      const { tokenAddress, recipient, amount } = gasFeeToken;

      if (to !== undefined) {
        caveatBuilder.addCaveat(
          specificActionERC20TransferBatch,
          tokenAddress,
          recipient,
          amount,
          to,
          (value as Hex) ?? '0x0',
          normalizedData,
        );
      }
    } else if (to !== undefined) {
      caveatBuilder.addCaveat(
        exactExecution,
        to,
        value ?? '0x0',
        normalizedData,
      );
    }

    caveatBuilder.addCaveat(limitedCalls, 1);

    return caveatBuilder.build();
  }

  async #buildAuthorizationList(
    transactionMeta: TransactionMeta,
    upgradeContractAddress?: Hex,
  ): Promise<AuthorizationList> {
    const { chainId, txParams, networkClientId } = transactionMeta;
    const { from, nonce: txNonce } = txParams;
    const nextNonce = await this.#getNextNonce(from, networkClientId);

    const nonce = txNonce ?? nextNonce;

    log('Including authorization as not upgraded');

    if (!upgradeContractAddress) {
      throw new Error('Upgrade contract address not found');
    }

    const authorizationSignature = (await this.#messenger.call(
      'KeyringController:signEip7702Authorization',
      {
        chainId: parseInt(chainId, 16),
        contractAddress: upgradeContractAddress,
        from,
        nonce: parseInt(nonce as string, 16),
      },
    )) as Hex;

    const { r, s, yParity } = decodeAuthorizationSignature(
      authorizationSignature,
    );

    log('Authorization signature', { authorizationSignature, r, s, yParity });

    return [
      {
        address: upgradeContractAddress,
        chainId,
        nonce: nonce as Hex,
        r,
        s,
        yParity,
      },
    ];
  }

  #buildTokenTransferData(recipient: Hex, amount: Hex): Hex {
    return new Interface(abiERC20).encodeFunctionData('transfer', [
      recipient,
      amount,
    ]) as Hex;
  }
}
